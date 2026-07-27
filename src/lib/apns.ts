// サーバー専用：iOSネイティブアプリへのプッシュ通知（APNs）。
//
// なぜ必要か: ネイティブアプリ（WKWebView）は Web Push を受け取れない。
// 「読み取りが終わりました」「同じスクショなので記録しませんでした」等をアプリを閉じた状態で
// 届けるには、Appleのサーバー（APNs）経由で送る必要がある。
//
// 認証はトークン方式（.p8のAPNs認証キー）。証明書と違い期限切れが無く、
// 1つのキーで全アプリに使える。必要な環境変数:
//   APNS_KEY_BASE64 … Apple Developer で作った APNs 認証キー(.p8) を base64 にしたもの
//   APNS_KEY_ID     … そのキーのID（10桁）
//   APNS_TEAM_ID    … チームID（10桁）
//   APNS_BUNDLE_ID  … 省略時 com.daito.cashsync
//   APNS_PRODUCTION … "1" で本番APNs（TestFlight/App Store配布はこちら）。既定は本番
import { db } from "./db";

interface ApnProvider {
  send(notification: unknown, tokens: string[]): Promise<{ failed: { device: string; status?: string }[] }>;
  shutdown(): void;
}

let providerPromise: Promise<ApnProvider | null> | null = null;

async function provider(): Promise<ApnProvider | null> {
  if (!providerPromise) {
    providerPromise = (async () => {
      const keyB64 = process.env.APNS_KEY_BASE64;
      const keyId = process.env.APNS_KEY_ID;
      const teamId = process.env.APNS_TEAM_ID;
      if (!keyB64 || !keyId || !teamId) return null; // 未設定なら黙って無効（Web Pushのみで動く）
      // Webビルドに含めないよう動的import
      const apn = await import("@parse/node-apn");
      const Provider = (apn as unknown as { Provider: new (opts: unknown) => ApnProvider }).Provider;
      return new Provider({
        token: {
          key: Buffer.from(keyB64, "base64"),
          keyId,
          teamId,
        },
        production: process.env.APNS_PRODUCTION !== "0",
      });
    })().catch(() => null);
  }
  return providerPromise;
}

/**
 * iOSネイティブアプリへ通知を送る。送れた件数を返す。
 * 端末トークンが無効（未インストール等）になっていたらDBから掃除する。
 */
export async function sendApns(userId: string, title: string, body: string): Promise<number> {
  const p = await provider();
  if (!p) return 0;
  const d = await db();
  const rows = await d.all<{ token: string }>(
    "SELECT token FROM push_devices WHERE user_id = ? AND platform = 'ios'",
    userId,
  );
  if (rows.length === 0) return 0;

  const apn = await import("@parse/node-apn");
  const NotificationCtor = (apn as unknown as { Notification: new () => Record<string, unknown> })
    .Notification;
  const note = new NotificationCtor() as Record<string, unknown> & {
    alert: unknown;
    topic: string;
    sound: string;
    pushType: string;
    expiry: number;
  };
  note.alert = { title, body };
  note.sound = "default";
  note.pushType = "alert";
  note.topic = process.env.APNS_BUNDLE_ID || "com.daito.cashsync";
  note.expiry = Math.floor(Date.now() / 1000) + 3600; // 1時間で失効（古い通知を出さない）

  const tokens = rows.map((r) => r.token);
  try {
    const result = await p.send(note, tokens);
    // 端末が無効になったトークンは掃除（410 Unregistered / BadDeviceToken）
    for (const f of result.failed ?? []) {
      if (f.status === "410" || f.status === "400") {
        await d.run("DELETE FROM push_devices WHERE token = ?", f.device).catch(() => {});
      }
    }
    return tokens.length - (result.failed?.length ?? 0);
  } catch {
    return 0;
  }
}
