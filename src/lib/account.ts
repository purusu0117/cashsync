// アカウント管理のドメインロジック（サーバー専用・next非依存）。
// B5: アカウント削除（App Store審査要件）／パスワード再設定トークン／パスワード変更。
// Route Handler から薄く呼び、テストスイート（scripts/test-suite.ts）からも直接テストできるようにここへ集約する。
import { createHash, randomBytes } from "node:crypto";
import { db } from "./db";
import { hashPassword, verifyPassword } from "./password";

const RESET_TTL_MS = 60 * 60 * 1000; // トークン有効期限：1時間
const VERIFY_TTL_MS = 24 * 60 * 60 * 1000; // メール確認トークンの有効期限：24時間

/** 未確認ユーザーがAIコスト系（scan/parse）を叩いたときに返す共通の日本語メッセージ */
export const EMAIL_UNVERIFIED_MESSAGE =
  "メールアドレスの確認が必要です。登録時にお送りした確認メールのリンクを押してください。設定画面から確認メールを再送できます。";

function sha256(v: string): string {
  return createHash("sha256").update(v).digest("hex");
}

/**
 * ユーザーの全データを削除する（取り消し不可）。
 * recurring_posts は user_id を持たないので recurring_items 経由で先に消す。
 * 最後に users 行を消し、全セッションも無効化する。原子性のためトランザクションで行う。
 */
export async function deleteUserData(userId: string): Promise<void> {
  const d = await db();
  await d.transaction(async (tx) => {
    await tx.run(
      "DELETE FROM recurring_posts WHERE recurring_id IN (SELECT id FROM recurring_items WHERE user_id = ?)",
      userId,
    );
    // account_snapshots は user_id を持たないので accounts 経由で先に消す
    await tx.run(
      "DELETE FROM account_snapshots WHERE account_id IN (SELECT id FROM accounts WHERE user_id = ?)",
      userId,
    );
    // expense_tags も user_id を持たないので expenses 経由で先に消す
    await tx.run(
      "DELETE FROM expense_tags WHERE expense_id IN (SELECT id FROM expenses WHERE user_id = ?)",
      userId,
    );
    const tables = [
      "accounts",
      "expenses",
      "incomes",
      "receipts",
      "shifts",
      "jobs",
      "categories",
      "recurring_items",
      "quick_presets",
      "category_budgets",
      "push_subscriptions",
      "push_devices",
      "monthly_reviews",
      "merchant_categories",
      "ai_usage",
      "ai_reward_days",
      "scan_jobs",
      "tags",
      "email_verifications",
      "password_resets",
      "sessions",
      "users",
    ];
    for (const t of tables) {
      await tx.run(`DELETE FROM ${t} WHERE ${t === "users" ? "id" : "user_id"} = ?`, userId);
    }
  });
}

/** パスワードを検証してから全データ削除。okでなければ削除しない */
export async function deleteAccountWithPassword(
  userId: string,
  password: string,
): Promise<"ok" | "wrong_password"> {
  const d = await db();
  const row = await d.get<{ password_hash: string }>(
    "SELECT password_hash FROM users WHERE id = ?",
    userId,
  );
  if (!row || !verifyPassword(password, row.password_hash)) return "wrong_password";
  await deleteUserData(userId);
  return "ok";
}

/**
 * パスワード再設定トークンを発行する。メールが未登録なら null（呼び出し元は
 * 列挙攻撃対策として、存在有無にかかわらず同じレスポンスを返すこと）。
 * DBには sha256 のみ保存し、平文トークンはメールリンクにだけ載せる。
 */
export async function createPasswordReset(
  email: string,
): Promise<{ token: string; userId: string } | null> {
  const d = await db();
  const user = await d.get<{ id: string }>("SELECT id FROM users WHERE email = ?", email);
  if (!user) return null;
  // 期限切れの掃除（テーブルが無限に太らないように）
  await d.run("DELETE FROM password_resets WHERE expires_at < ?", Date.now());
  const token = randomBytes(32).toString("hex");
  await d.run(
    "INSERT INTO password_resets (token_hash, user_id, expires_at, used_at) VALUES (?, ?, ?, NULL)",
    sha256(token),
    user.id,
    Date.now() + RESET_TTL_MS,
  );
  return { token, userId: user.id };
}

/** トークンが有効か（画面表示前の事前チェック用） */
export async function isResetTokenValid(token: string): Promise<boolean> {
  const d = await db();
  const row = await d.get<{ expires_at: number; used_at: number | null }>(
    "SELECT expires_at, used_at FROM password_resets WHERE token_hash = ?",
    sha256(token),
  );
  return !!row && row.used_at === null && Number(row.expires_at) >= Date.now();
}

/**
 * トークンを消費して新パスワードを設定する。
 * 成功時は既存セッションを全破棄（盗まれたセッションを道連れに無効化）。
 */
export async function consumePasswordReset(
  token: string,
  newPassword: string,
): Promise<"ok" | "invalid_token" | "weak_password"> {
  if (newPassword.length < 8) return "weak_password";
  const d = await db();
  const hash = sha256(token);
  const row = await d.get<{ user_id: string; expires_at: number; used_at: number | null }>(
    "SELECT user_id, expires_at, used_at FROM password_resets WHERE token_hash = ?",
    hash,
  );
  if (!row || row.used_at !== null || Number(row.expires_at) < Date.now()) return "invalid_token";
  await d.run("UPDATE password_resets SET used_at = ? WHERE token_hash = ?", Date.now(), hash);
  await d.run(
    "UPDATE users SET password_hash = ? WHERE id = ?",
    hashPassword(newPassword),
    row.user_id,
  );
  await d.run("DELETE FROM sessions WHERE user_id = ?", row.user_id);
  return "ok";
}

// ---------------------------------------------------------------------------
// メール確認（公開前の不正対策①：捨てメアド乱造→無料AI枠farming を止める）
// password_resets と同じ作法：DBには sha256 のみ保存し、平文トークンはメールリンクにだけ載せる。
// 既存ユーザーは users.email_verified=1（スキーマDEFAULT）で全員確認済み扱い＝ログインを壊さない。
// ---------------------------------------------------------------------------

/**
 * メール確認を必須にするか（環境フラグ）。
 * REQUIRE_EMAIL_VERIFICATION="true" のときだけ ON。未設定/"false"（既定）は OFF。
 * OFF ＝ 新規は登録直後から全機能を摩擦なく使える（確認メール不要・Resend未設定でもOK）。
 * ON にすると register が未確認ユーザーを作り、AIコスト系（scan/parse）が未確認を403で弾く。
 */
export function emailVerificationRequired(): boolean {
  return process.env.REQUIRE_EMAIL_VERIFICATION === "true";
}

/** メール確認済みか（未設定/不明は「確認済み扱い」＝既存挙動を壊さない安全側） */
export async function isUserVerified(userId: string): Promise<boolean> {
  const d = await db();
  const row = await d.get<{ email_verified: number | null }>(
    "SELECT email_verified FROM users WHERE id = ?",
    userId,
  );
  // 行が無い場合も true（別経路で弾かれる）。列が NULL の場合は確認済み扱い。
  return !row || row.email_verified === null || Number(row.email_verified) === 1;
}

/**
 * メール確認トークンを発行する。ユーザーが存在しない/既に確認済みなら null。
 * 有効期限は24時間。過去に発行した未使用トークンは掃除してから1本だけ発行する。
 */
export async function createEmailVerification(
  userId: string,
): Promise<{ token: string } | null> {
  const d = await db();
  const user = await d.get<{ id: string; email_verified: number | null }>(
    "SELECT id, email_verified FROM users WHERE id = ?",
    userId,
  );
  if (!user) return null;
  if (Number(user.email_verified) === 1) return null; // 既に確認済みなら再送しない
  // 期限切れの掃除＋このユーザーの旧トークンを無効化（最新の1本だけ有効にする）
  await d.run("DELETE FROM email_verifications WHERE expires_at < ?", Date.now());
  await d.run("DELETE FROM email_verifications WHERE user_id = ?", userId);
  const token = randomBytes(32).toString("hex");
  await d.run(
    "INSERT INTO email_verifications (token_hash, user_id, expires_at, used_at) VALUES (?, ?, ?, NULL)",
    sha256(token),
    userId,
    Date.now() + VERIFY_TTL_MS,
  );
  return { token };
}

/**
 * 確認トークンを消費して users.email_verified=1 にする。
 * 既に確認済みのトークン再訪（used）でも "ok" を返す（二度押し・戻る操作でエラーにしない）。
 */
export async function consumeEmailVerification(
  token: string,
): Promise<"ok" | "invalid_token"> {
  if (!token) return "invalid_token";
  const d = await db();
  const hash = sha256(token);
  const row = await d.get<{ user_id: string; expires_at: number; used_at: number | null }>(
    "SELECT user_id, expires_at, used_at FROM email_verifications WHERE token_hash = ?",
    hash,
  );
  if (!row) return "invalid_token";
  if (row.used_at !== null) return "ok"; // 既に確認済み（二度押し）→ 成功扱い
  if (Number(row.expires_at) < Date.now()) return "invalid_token";
  await d.run("UPDATE email_verifications SET used_at = ? WHERE token_hash = ?", Date.now(), hash);
  await d.run("UPDATE users SET email_verified = 1 WHERE id = ?", row.user_id);
  return "ok";
}

/** ログイン中のパスワード変更（現PW確認つき） */
export async function changePassword(
  userId: string,
  currentPassword: string,
  newPassword: string,
): Promise<"ok" | "wrong_password" | "weak_password"> {
  if (newPassword.length < 8) return "weak_password";
  const d = await db();
  const row = await d.get<{ password_hash: string }>(
    "SELECT password_hash FROM users WHERE id = ?",
    userId,
  );
  if (!row || !verifyPassword(currentPassword, row.password_hash)) return "wrong_password";
  await d.run("UPDATE users SET password_hash = ? WHERE id = ?", hashPassword(newPassword), userId);
  return "ok";
}
