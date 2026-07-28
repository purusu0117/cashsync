// アカウント管理のドメインロジック（サーバー専用・next非依存）。
// B5: アカウント削除（App Store審査要件）／パスワード再設定トークン／パスワード変更。
// Route Handler から薄く呼び、テストスイート（scripts/test-suite.ts）からも直接テストできるようにここへ集約する。
import { createHash, randomBytes } from "node:crypto";
import { db } from "./db";
import { hashPassword, verifyPassword } from "./password";

const RESET_TTL_MS = 60 * 60 * 1000; // トークン有効期限：1時間

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
      "monthly_reviews",
      "merchant_categories",
      "ai_usage",
      "ai_reward_days",
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
