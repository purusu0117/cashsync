// メール＋パスワード認証（CookSync 方式を scrypt ハッシュ＋セッションクッキーに強化）。
// B5: forgot（リセットメール受付）/ reset（トークン＋新PW）/ changePassword（ログイン中の変更）を追加。
import { cookies } from "next/headers";
import {
  changePassword,
  consumeEmailVerification,
  consumePasswordReset,
  createEmailVerification,
  createPasswordReset,
  emailVerificationRequired,
  isUserVerified,
} from "@/lib/account";
import {
  SIGNUP_IP_LIMIT,
  SIGNUP_RATE_MESSAGE,
  clientIp,
  recentSignupAttempts,
  recordSignupAttempt,
} from "@/lib/abuse";
import {
  SESSION_COOKIE,
  createSession,
  currentUser,
  destroySession,
  hashPassword,
  verifyPassword,
} from "@/lib/auth";
import { db, seedCategories, uid } from "@/lib/db";
import { sendPasswordResetMail, sendVerificationMail } from "@/lib/mail";

export const dynamic = "force-dynamic";

const COOKIE_OPTS = {
  httpOnly: true,
  sameSite: "lax" as const,
  path: "/",
  maxAge: 60 * 60 * 24 * 365,
};

export async function GET() {
  const u = await currentUser();
  // 未確認バナー表示用に確認状態も返す（未ログインは true 扱いで無害）。
  // メール確認がフラグOFF（既定）のときは常に true ＝ バナーを出さない。
  const emailVerified = u && emailVerificationRequired() ? await isUserVerified(u.id) : true;
  return Response.json({ user: u, emailVerified });
}

export async function POST(request: Request) {
  try {
    const { action, name, email, password, token, currentPassword, newPassword } =
      (await request.json()) as {
        action?: string;
        name?: string;
        email?: string;
        password?: string;
        token?: string; // reset用
        currentPassword?: string; // changePassword用
        newPassword?: string; // changePassword用
      };
    const store = await cookies();

    if (action === "logout") {
      const t = store.get(SESSION_COOKIE)?.value;
      if (t) await destroySession(t);
      store.delete(SESSION_COOKIE);
      return Response.json({ ok: true });
    }

    // B5: パスワード再設定メールの受付。
    // 列挙攻撃対策：メールが登録済みかどうかにかかわらず、常に同じ成功レスポンスを返す。
    if (action === "forgot") {
      const target = (email || "").trim().toLowerCase();
      if (!target) {
        return Response.json({ error: "メールアドレスを入力してください。" }, { status: 400 });
      }
      const reset = await createPasswordReset(target);
      if (reset) {
        const url = `${new URL(request.url).origin}/reset-password?token=${reset.token}`;
        try {
          await sendPasswordResetMail(target, url);
        } catch (err) {
          // 送信基盤の失敗もユーザーには同じ文言（存在有無を推測させない）。詳細はログのみ。
          console.error("password reset mail failed:", err);
        }
      }
      return Response.json({ ok: true });
    }

    // B5: トークン＋新パスワードで再設定
    if (action === "reset") {
      if (!token || !password) {
        return Response.json({ error: "リンクが正しくありません。" }, { status: 400 });
      }
      const result = await consumePasswordReset(token, password);
      if (result === "weak_password") {
        return Response.json({ error: "パスワードは8文字以上にしてください。" }, { status: 400 });
      }
      if (result === "invalid_token") {
        return Response.json(
          { error: "リンクが無効か、有効期限（1時間）が切れています。もう一度お手続きください。" },
          { status: 400 },
        );
      }
      return Response.json({ ok: true });
    }

    // 不正対策①: メール確認リンク（/verify?token=…）からの検証。認証不要（トークンが本人性）。
    if (action === "verify") {
      const result = await consumeEmailVerification(token ?? "");
      if (result === "invalid_token") {
        return Response.json(
          { error: "リンクが無効か、有効期限（24時間）が切れています。設定画面から再送してください。" },
          { status: 400 },
        );
      }
      return Response.json({ ok: true });
    }

    // 不正対策①: 確認メールの再送。ログイン中の未確認ユーザーが対象（列挙対策で常に ok を返す）。
    if (action === "resendVerification") {
      const u = await currentUser();
      if (u) {
        const v = await createEmailVerification(u.id);
        if (v) {
          const url = `${new URL(request.url).origin}/verify?token=${v.token}`;
          try {
            await sendVerificationMail(u.email, url);
          } catch (err) {
            console.error("verification mail failed:", err);
          }
        }
      }
      return Response.json({ ok: true });
    }

    // B5: ログイン中のパスワード変更（現PW＋新PW）
    if (action === "changePassword") {
      const u = await currentUser();
      if (!u) return Response.json({ error: "ログインしてください。" }, { status: 401 });
      const result = await changePassword(u.id, currentPassword ?? "", newPassword ?? "");
      if (result === "weak_password") {
        return Response.json(
          { error: "新しいパスワードは8文字以上にしてください。" },
          { status: 400 },
        );
      }
      if (result === "wrong_password") {
        return Response.json({ error: "現在のパスワードが違います。" }, { status: 401 });
      }
      return Response.json({ ok: true });
    }

    const em = (email || "").trim().toLowerCase();
    if (!em || !password) {
      return Response.json(
        { error: "メールとパスワードを入力してください。" },
        { status: 400 },
      );
    }
    const d = await db();

    if (action === "register") {
      if (!name || !name.trim()) {
        return Response.json({ error: "名前を入力してください。" }, { status: 400 });
      }
      // A7: 新規登録のみ8文字以上を必須にする（既存ユーザーのログインには影響させない）
      if (password.length < 8) {
        return Response.json(
          { error: "パスワードは8文字以上にしてください。" },
          { status: 400 },
        );
      }
      const existing = await d.get("SELECT id FROM users WHERE email = ?", em);
      if (existing) {
        return Response.json(
          { error: "このメールは登録済みです。ログインしてください。" },
          { status: 409 },
        );
      }
      // 不正対策②: 同一IPからの新規登録の連打（捨てメアド乱造）を弾く。
      // 既存ユーザーのログインには一切影響しない（register 分岐の中だけ）。
      const ip = clientIp(request);
      if ((await recentSignupAttempts(ip)) >= SIGNUP_IP_LIMIT) {
        await recordSignupAttempt(ip); // 連打が続く限りウィンドウを延ばす
        return Response.json({ error: SIGNUP_RATE_MESSAGE }, { status: 429 });
      }
      await recordSignupAttempt(ip);
      const id = uid();
      // 不正対策①（フラグ制御）: 確認必須ONのときだけ email_verified=0（未確認）で作る。
      // OFF（既定）は email_verified=1 で作り、確認メールを送らず登録直後から全機能を使える。
      const requireVerify = emailVerificationRequired();
      await d.run(
        "INSERT INTO users (id, email, name, password_hash, created_at, email_verified) VALUES (?, ?, ?, ?, ?, ?)",
        id,
        em,
        name.trim(),
        hashPassword(password),
        Date.now(),
        requireVerify ? 0 : 1,
      );
      await seedCategories(id);
      // 確認必須ONのときだけ確認メールを送る（送信基盤の失敗はログのみ。登録自体は成立させ、後で再送できる）。
      if (requireVerify) {
        const v = await createEmailVerification(id);
        if (v) {
          const url = `${new URL(request.url).origin}/verify?token=${v.token}`;
          try {
            await sendVerificationMail(em, url);
          } catch (err) {
            console.error("verification mail failed:", err);
          }
        }
      }
      // ログイン自体は許容（セッション発行）。ON時のみ未確認なので scan/parse 系が 403 で弾かれる。
      store.set(SESSION_COOKIE, await createSession(id), COOKIE_OPTS);
      return Response.json({
        ok: true,
        user: { id, email: em, name: name.trim() },
        emailVerified: !requireVerify,
      });
    }

    // login（身内アプリなので、未登録とパスワード違いを分けて案内する）
    const u = await d.get<{ id: string; email: string; name: string; password_hash: string }>(
      "SELECT id, email, name, password_hash FROM users WHERE email = ?",
      em,
    );
    if (!u) {
      return Response.json(
        { error: "このメールアドレスは登録されていません。「アカウントを作る」から登録してください。" },
        { status: 401 },
      );
    }
    if (!verifyPassword(password, u.password_hash)) {
      return Response.json({ error: "パスワードが違います。" }, { status: 401 });
    }
    store.set(SESSION_COOKIE, await createSession(u.id), COOKIE_OPTS);
    return Response.json({ ok: true, user: { id: u.id, email: u.email, name: u.name } });
  } catch (e) {
    return Response.json(
      { error: e instanceof Error ? e.message : "auth failed" },
      { status: 500 },
    );
  }
}
