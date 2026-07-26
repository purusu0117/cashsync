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

export function createSession(userId: string): string {
  const token = randomBytes(32).toString("hex");
  db()
    .prepare("INSERT INTO sessions (token, user_id, created_at) VALUES (?, ?, ?)")
    .run(token, userId, Date.now());
  return token;
}

export function destroySession(token: string) {
  db().prepare("DELETE FROM sessions WHERE token = ?").run(token);
}

/** クッキーのセッショントークンからユーザーを引く。未ログインなら null */
export async function currentUser(): Promise<SessionUser | null> {
  const store = await cookies();
  const token = store.get(SESSION_COOKIE)?.value;
  if (!token) return null;
  const row = db()
    .prepare(
      `SELECT u.id, u.email, u.name FROM sessions s
       JOIN users u ON u.id = s.user_id WHERE s.token = ?`,
    )
    .get(token) as SessionUser | undefined;
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
export function userFromBearer(request: Request): SessionUser | null {
  const header = request.headers.get("authorization") ?? "";
  const m = header.match(/^Bearer\s+([a-f0-9]{32,})$/i);
  if (!m) return null;
  const row = db()
    .prepare("SELECT id, email, name FROM users WHERE api_token = ?")
    .get(m[1]) as SessionUser | undefined;
  return row ?? null;
}

/** ユーザーのAPIトークンを取得（無ければ生成して保存） */
export function ensureApiToken(userId: string): string {
  const d = db();
  const row = d.prepare("SELECT api_token FROM users WHERE id = ?").get(userId) as
    | { api_token: string | null }
    | undefined;
  if (row?.api_token) return row.api_token;
  const token = randomBytes(24).toString("hex");
  d.prepare("UPDATE users SET api_token = ? WHERE id = ?").run(token, userId);
  return token;
}

export function unauthorized(): Response {
  return Response.json({ error: "ログインしてください。" }, { status: 401 });
}
