// サーバー専用：メール＋パスワード認証（CookSync 方式を scrypt ハッシュ化して継承）と
// httpOnly クッキーのセッション管理。
import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { cookies } from "next/headers";
import { db } from "./db";

export const SESSION_COOKIE = "cashsync_session";

export function hashPassword(password: string): string {
  const salt = randomBytes(16).toString("hex");
  const hash = scryptSync(password, salt, 64).toString("hex");
  return `${salt}:${hash}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [salt, hash] = stored.split(":");
  if (!salt || !hash) return false;
  const candidate = scryptSync(password, salt, 64);
  const expected = Buffer.from(hash, "hex");
  return candidate.length === expected.length && timingSafeEqual(candidate, expected);
}

export interface SessionUser {
  id: string;
  email: string;
  name: string;
}

export async function createSession(userId: string): Promise<string> {
  const token = randomBytes(32).toString("hex");
  const d = await db();
  await d.run(
    "INSERT INTO sessions (token, user_id, created_at) VALUES (?, ?, ?)",
    token,
    userId,
    Date.now(),
  );
  return token;
}

export async function destroySession(token: string): Promise<void> {
  const d = await db();
  await d.run("DELETE FROM sessions WHERE token = ?", token);
}

/** クッキーのセッショントークンからユーザーを引く。未ログインなら null */
export async function currentUser(): Promise<SessionUser | null> {
  const store = await cookies();
  const token = store.get(SESSION_COOKIE)?.value;
  if (!token) return null;
  const d = await db();
  const row = await d.get<SessionUser>(
    `SELECT u.id, u.email, u.name FROM sessions s
     JOIN users u ON u.id = s.user_id WHERE s.token = ?`,
    token,
  );
  return row ?? null;
}

/** Route Handler 用：未ログインなら throw（catch して 401 を返す） */
export async function requireUser(): Promise<SessionUser> {
  const u = await currentUser();
  if (!u) throw new AuthError();
  return u;
}

export class AuthError extends Error {
  constructor() {
    super("unauthorized");
  }
}

/** iPhoneショートカット等の外部連携用：Authorization: Bearer <api_token> からユーザーを引く */
export async function userFromBearer(request: Request): Promise<SessionUser | null> {
  const header = request.headers.get("authorization") ?? "";
  const m = header.match(/^Bearer\s+([a-f0-9]{32,})$/i);
  if (!m) return null;
  const d = await db();
  const row = await d.get<SessionUser>(
    "SELECT id, email, name FROM users WHERE api_token = ?",
    m[1],
  );
  return row ?? null;
}

/** ユーザーのAPIトークンを取得（無ければ生成して保存） */
export async function ensureApiToken(userId: string): Promise<string> {
  const d = await db();
  const row = await d.get<{ api_token: string | null }>(
    "SELECT api_token FROM users WHERE id = ?",
    userId,
  );
  if (row?.api_token) return row.api_token;
  const token = randomBytes(24).toString("hex");
  await d.run("UPDATE users SET api_token = ? WHERE id = ?", token, userId);
  return token;
}

export function unauthorized(): Response {
  return Response.json({ error: "ログインしてください。" }, { status: 401 });
}
