// プッシュ通知の購読管理。GET=公開鍵、POST=購読登録、DELETE=解除。
import { AuthError, requireUser, unauthorized } from "@/lib/auth";
import { db } from "@/lib/db";
import { vapidPublicKey } from "@/lib/push";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const user = await requireUser();
    const count = (
      db()
        .prepare("SELECT COUNT(*) AS c FROM push_subscriptions WHERE user_id = ?")
        .get(user.id) as { c: number }
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
    db()
      .prepare(
        "INSERT INTO push_subscriptions (endpoint, user_id, subscription, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(endpoint) DO UPDATE SET user_id = excluded.user_id, subscription = excluded.subscription",
      )
      .run(sub.endpoint, user.id, JSON.stringify(sub), Date.now());
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
    if (endpoint) {
      db()
        .prepare("DELETE FROM push_subscriptions WHERE endpoint = ? AND user_id = ?")
        .run(endpoint, user.id);
    } else {
      db().prepare("DELETE FROM push_subscriptions WHERE user_id = ?").run(user.id);
    }
    return Response.json({ ok: true });
  } catch (e) {
    if (e instanceof AuthError) return unauthorized();
    return Response.json({ error: String(e) }, { status: 500 });
  }
}
