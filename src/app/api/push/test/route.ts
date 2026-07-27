// 通知の疎通確認用。ログイン中のユーザー自身にテスト通知を送る。
// 「設定を入れたのに鳴らない」ときに、どこで止まっているか（端末未登録／キー未設定／送信失敗）を切り分ける。
import { AuthError, requireUser, unauthorized } from "@/lib/auth";
import { db } from "@/lib/db";
import { pushToUser } from "@/lib/push";

export const dynamic = "force-dynamic";

export async function POST() {
  try {
    const user = await requireUser();
    const d = await db();
    const devices = await d.all<{ platform: string }>(
      "SELECT platform FROM push_devices WHERE user_id = ?",
      user.id,
    );
    const webSubs = await d.all<{ endpoint: string }>(
      "SELECT endpoint FROM push_subscriptions WHERE user_id = ?",
      user.id,
    );
    const sent = await pushToUser(
      user.id,
      "CashSync テスト通知",
      "この通知が見えていれば、通知の設定は正しく動いています",
    );
    return Response.json({
      sent,
      devices: devices.length, // ネイティブアプリの端末数（0なら端末登録がまだ）
      webSubscriptions: webSubs.length,
      apnsConfigured: !!process.env.APNS_KEY_BASE64 && !!process.env.APNS_KEY_ID && !!process.env.APNS_TEAM_ID,
    });
  } catch (e) {
    if (e instanceof AuthError) return unauthorized();
    return Response.json({ error: String(e) }, { status: 500 });
  }
}
