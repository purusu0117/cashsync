// サーバー専用：Web Push送信（使いすぎ予兆通知など）。VAPIDキーは .env.local。
import webpush from "web-push";
import { db } from "./db";

let configured = false;
function setup(): boolean {
  if (configured) return true;
  const pub = process.env.VAPID_PUBLIC_KEY;
  const priv = process.env.VAPID_PRIVATE_KEY;
  if (!pub || !priv) return false;
  webpush.setVapidDetails(process.env.VAPID_SUBJECT || "mailto:admin@example.com", pub, priv);
  configured = true;
  return true;
}

export function vapidPublicKey(): string {
  return process.env.VAPID_PUBLIC_KEY ?? "";
}

/** ユーザーの全端末に通知を送る。無効になった購読は掃除する */
export async function pushToUser(userId: string, title: string, body: string): Promise<number> {
  if (!setup()) return 0;
  const d = await db();
  const subs = await d.all<{ endpoint: string; subscription: string }>(
    "SELECT endpoint, subscription FROM push_subscriptions WHERE user_id = ?",
    userId,
  );
  let sent = 0;
  for (const s of subs) {
    try {
      await webpush.sendNotification(JSON.parse(s.subscription), JSON.stringify({ title, body }));
      sent++;
    } catch (e) {
      const status = (e as { statusCode?: number }).statusCode;
      if (status === 404 || status === 410) {
        await d.run("DELETE FROM push_subscriptions WHERE endpoint = ?", s.endpoint);
      }
    }
  }
  return sent;
}
