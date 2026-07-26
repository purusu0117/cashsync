// プッシュ通知の購読管理。GET=公開鍵、POST=購読登録、DELETE=解除。
import { AuthError, requireUser, unauthorized } from "@/lib/auth";
import { db } from "@/lib/db";
import { vapidPublicKey } from "@/lib/push";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const user = await requireUser();
    const d = await db();
    const count = (
      (await d.get<{ c: number }>(
        "SELECT COUNT(*) AS c FROM push_subscriptions WHERE user_id = ?",
        user.id,
      )) as { c: number }
    ).c;
    return Response.json({ publicKey: vapidPublicKey(), subscribed: count > 0 });
  } catch (e) {
    if (e instanceof AuthError) return unauthorized();
    return Response.json({ error: String(e) }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const user = await requireUser();
    const sub = (await request.json()) as { endpoint?: string };
    if (!sub.endpoint) return Response.json({ error: "invalid subscription" }, { status: 400 });
    const d = await db();
    await d.run(
      "INSERT INTO push_subscriptions (endpoint, user_id, subscription, created_at) VALUES (?, ?, ?, ?) ON CONFLICT (endpoint) DO UPDATE SET user_id = excluded.user_id, subscription = excluded.subscription",
      sub.endpoint,
      user.id,
      JSON.stringify(sub),
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
    const { endpoint } = (await request.json()) as { endpoint?: string };
    const d = await db();
    if (endpoint) {
      await d.run(
        "DELETE FROM push_subscriptions WHERE endpoint = ? AND user_id = ?",
        endpoint,
        user.id,
      );
    } else {
      await d.run("DELETE FROM push_subscriptions WHERE user_id = ?", user.id);
    }
    return Response.json({ ok: true });
  } catch (e) {
    if (e instanceof AuthError) return unauthorized();
    return Response.json({ error: String(e) }, { status: 500 });
  }
}
