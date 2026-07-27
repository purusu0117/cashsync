// ネイティブアプリの端末トークン登録（APNs用）。
// アプリ起動時に @capacitor/push-notifications が受け取ったトークンをここへ送る。
// Web Push の購読（/api/push）とは別テーブルで管理する。
import { AuthError, requireUser, unauthorized } from "@/lib/auth";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const user = await requireUser();
    const body = (await request.json()) as { token?: string; platform?: string };
    const token = (body.token ?? "").trim();
    if (!token || token.length > 400) {
      return Response.json({ error: "token required" }, { status: 400 });
    }
    const platform = body.platform === "android" ? "android" : "ios";
    const d = await db();
    // 同じ端末を別ユーザーで使い回した場合は所有者を上書きする（他人に通知が飛ばないように）
    await d.run(
      "INSERT INTO push_devices (token, user_id, platform, created_at) VALUES (?, ?, ?, ?) ON CONFLICT (token) DO UPDATE SET user_id = excluded.user_id, platform = excluded.platform",
      token,
      user.id,
      platform,
      Date.now(),
    );
    return Response.json({ ok: true });
  } catch (e) {
    if (e instanceof AuthError) return unauthorized();
    return Response.json({ error: String(e) }, { status: 500 });
  }
}

export async function DELETE(request: Request) {
  try {
    const user = await requireUser();
    const { token } = (await request.json().catch(() => ({}))) as { token?: string };
    const d = await db();
    if (token) {
      await d.run("DELETE FROM push_devices WHERE token = ? AND user_id = ?", token, user.id);
    } else {
      await d.run("DELETE FROM push_devices WHERE user_id = ?", user.id);
    }
    return Response.json({ ok: true });
  } catch (e) {
    if (e instanceof AuthError) return unauthorized();
    return Response.json({ error: String(e) }, { status: 500 });
  }
}
