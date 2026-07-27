// アカウント管理のドメインロジック（サーバー専用・next非依存）。
// B5: アカウント削除（App Store審査要件）／パスワード再設定トークン／パスワード変更。
// Route Handler から薄く呼び、検証スクリプトからも直接テストできるようにここへ集約する。
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
 * 最後に users 行を消し、全セッションも無効化する。
 */
export function deleteUserData(userId: string): void {
  const d = db();
  d.prepare(
    "DELETE FROM recurring_posts WHERE recurring_id IN (SELECT id FROM recurring_items WHERE user_id = ?)",
  ).run(userId);
  const tables = [
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
    "password_resets",
    "sessions",
    "users",
  ];
  for (const t of tables) {
    d.prepare(`DELETE FROM ${t} WHERE ${t === "users" ? "id" : "user_id"} = ?`).run(userId);
  }
}

/** パスワードを検証してから全データ削除。okでなければ削除しない */
export function deleteAccountWithPassword(userId: string, password: string): "ok" | "wrong_password" {
  const row = db().prepare("SELECT password_hash FROM users WHERE id = ?").get(userId) as
    | { password_hash: string }
    | undefined;
  if (!row || !verifyPassword(password, row.password_hash)) return "wrong_password";
  deleteUserData(userId);
  return "ok";
}

/**
 * パスワード再設定トークンを発行する。メールが未登録なら null（呼び出し元は
 * 列挙攻撃対策として、存在有無にかかわらず同じレスポンスを返すこと）。
 * DBには sha256 のみ保存し、平文トークンはメールリンクにだけ載せる。
 */
export function createPasswordReset(email: string): { token: string; userId: string } | null {
  const d = db();
  const user = d.prepare("SELECT id FROM users WHERE email = ?").get(email) as
    | { id: string }
    | undefined;
  if (!user) return null;
  // 期限切れの掃除（テーブルが無限に太らないように）
  d.prepare("DELETE FROM password_resets WHERE expires_at < ?").run(Date.now());
  const token = randomBytes(32).toString("hex");
  d.prepare(
    "INSERT INTO password_resets (token_hash, user_id, expires_at, used_at) VALUES (?, ?, ?, NULL)",
  ).run(sha256(token), user.id, Date.now() + RESET_TTL_MS);
  return { token, userId: user.id };
}

/** トークンが有効か（画面表示前の事前チェック用） */
export function isResetTokenValid(token: string): boolean {
  const row = db()
    .prepare("SELECT expires_at, used_at FROM password_resets WHERE token_hash = ?")
    .get(sha256(token)) as { expires_at: number; used_at: number | null } | undefined;
  return !!row && row.used_at === null && row.expires_at >= Date.now();
}

/**
 * トークンを消費して新パスワードを設定する。
 * 成功時は既存セッションを全破棄（盗まれたセッションを道連れに無効化）。
 */
export function consumePasswordReset(
  token: string,
  newPassword: string,
): "ok" | "invalid_token" | "weak_password" {
  if (newPassword.length < 8) return "weak_password";
  const d = db();
  const hash = sha256(token);
  const row = d
    .prepare("SELECT user_id, expires_at, used_at FROM password_resets WHERE token_hash = ?")
    .get(hash) as { user_id: string; expires_at: number; used_at: number | null } | undefined;
  if (!row || row.used_at !== null || row.expires_at < Date.now()) return "invalid_token";
  d.prepare("UPDATE password_resets SET used_at = ? WHERE token_hash = ?").run(Date.now(), hash);
  d.prepare("UPDATE users SET password_hash = ? WHERE id = ?").run(
    hashPassword(newPassword),
    row.user_id,
  );
  d.prepare("DELETE FROM sessions WHERE user_id = ?").run(row.user_id);
  return "ok";
}

/** ログイン中のパスワード変更（現PW確認つき） */
export function changePassword(
  userId: string,
  currentPassword: string,
  newPassword: string,
): "ok" | "wrong_password" | "weak_password" {
  if (newPassword.length < 8) return "weak_password";
  const d = db();
  const row = d.prepare("SELECT password_hash FROM users WHERE id = ?").get(userId) as
    | { password_hash: string }
    | undefined;
  if (!row || !verifyPassword(currentPassword, row.password_hash)) return "wrong_password";
  d.prepare("UPDATE users SET password_hash = ? WHERE id = ?").run(hashPassword(newPassword), userId);
  return "ok";
}
