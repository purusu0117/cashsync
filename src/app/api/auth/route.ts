// メール＋パスワード認証（CookSync 方式を scrypt ハッシュ＋セッションクッキーに強化）。
import { cookies } from "next/headers";
import {
  SESSION_COOKIE,
  createSession,
  currentUser,
  destroySession,
  hashPassword,
  verifyPassword,
} from "@/lib/auth";
import { db, seedCategories, uid } from "@/lib/db";

export const dynamic = "force-dynamic";

const COOKIE_OPTS = {
  httpOnly: true,
  sameSite: "lax" as const,
  path: "/",
  maxAge: 60 * 60 * 24 * 365,
};

export async function GET() {
  const u = await currentUser();
  return Response.json({ user: u });
}

export async function POST(request: Request) {
  try {
    const { action, name, email, password } = (await request.json()) as {
      action?: string;
      name?: string;
      email?: string;
      password?: string;
    };
    const store = await cookies();

    if (action === "logout") {
      const token = store.get(SESSION_COOKIE)?.value;
      if (token) destroySession(token);
      store.delete(SESSION_COOKIE);
      return Response.json({ ok: true });
    }

    const em = (email || "").trim().toLowerCase();
    if (!em || !password) {
      return Response.json(
        { error: "メールとパスワードを入力してください。" },
        { status: 400 },
      );
    }
    const d = db();

    if (action === "register") {
      if (!name || !name.trim()) {
        return Response.json({ error: "名前を入力してください。" }, { status: 400 });
      }
      const existing = d.prepare("SELECT id FROM users WHERE email = ?").get(em);
      if (existing) {
        return Response.json(
          { error: "このメールは登録済みです。ログインしてください。" },
          { status: 409 },
        );
      }
      const id = uid();
      d.prepare(
        "INSERT INTO users (id, email, name, password_hash, created_at) VALUES (?, ?, ?, ?, ?)",
      ).run(id, em, name.trim(), hashPassword(password), Date.now());
      seedCategories(id);
      store.set(SESSION_COOKIE, createSession(id), COOKIE_OPTS);
      return Response.json({ ok: true, user: { id, email: em, name: name.trim() } });
    }

    // login（身内アプリなので、未登録とパスワード違いを分けて案内する）
    const u = d
      .prepare("SELECT id, email, name, password_hash FROM users WHERE email = ?")
      .get(em) as { id: string; email: string; name: string; password_hash: string } | undefined;
    if (!u) {
      return Response.json(
        { error: "このメールアドレスは登録されていません。「アカウントを作る」から登録してください。" },
        { status: 401 },
      );
    }
    if (!verifyPassword(password, u.password_hash)) {
      return Response.json({ error: "パスワードが違います。" }, { status: 401 });
    }
    store.set(SESSION_COOKIE, createSession(u.id), COOKIE_OPTS);
    return Response.json({ ok: true, user: { id: u.id, email: u.email, name: u.name } });
  } catch (e) {
    return Response.json(
      { error: e instanceof Error ? e.message : "auth failed" },
      { status: 500 },
    );
  }
}
