// B5: アカウント削除（App Store審査要件）。
// パスワードで本人確認 → 全テーブルのユーザーデータを完全削除 → セッションクッキーも破棄。
import { cookies } from "next/headers";
import { deleteAccountWithPassword } from "@/lib/account";
import { AuthError, SESSION_COOKIE, requireUser, unauthorized } from "@/lib/auth";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const user = await requireUser();
    const body = (await request.json().catch(() => ({}))) as { password?: string };
    if (!body.password) {
      return Response.json({ error: "パスワードを入力してください。" }, { status: 400 });
    }
    const result = deleteAccountWithPassword(user.id, body.password);
    if (result === "wrong_password") {
      return Response.json({ error: "パスワードが違います。" }, { status: 401 });
    }
    const store = await cookies();
    store.delete(SESSION_COOKIE);
    return Response.json({ ok: true });
  } catch (e) {
    if (e instanceof AuthError) return unauthorized();
    return Response.json(
      { error: e instanceof Error ? e.message : "delete failed" },
      { status: 500 },
    );
  }
}
