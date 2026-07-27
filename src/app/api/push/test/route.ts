// 通知の疎通確認用。ログイン中のユーザー自身にテスト通知を送る。
// 「設定を入れたのに鳴らない」ときに、どこで止まっているか（端末未登録／送信失敗の理由）を切り分ける。
// APNs の生の応答(status/reason)まで返すので、失敗時も原因が一目で分かる。
import { apnsDiagnostics } from "@/lib/apns";
import { AuthError, requireUser, unauthorized } from "@/lib/auth";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";

export async function POST() {
  try {
    const user = await requireUser();
    const d = await db();
    const webSubs = await d.all<{ endpoint: string }>(
      "SELECT endpoint FROM push_subscriptions WHERE user_id = ?",
      user.id,
    );
    // ネイティブ（APNs）へ実際に送りつつ、Appleの応答を取得する
    const diag = await apnsDiagnostics(
      user.id,
      "CashSync テスト通知",
      "この通知が見えていれば、通知の設定は正しく動いています",
    );
    const delivered = diag.results.filter((r) => r.status === 200).length;
    return Response.json({
      delivered, // APNsが200で受理した件数（1以上なら端末に届くはず）
      devices: diag.results.length, // 登録されているiOS端末数（0なら端末登録がまだ）
      apnsConfigured: diag.configured,
      apnsResults: diag.results, // [{token:先頭8桁, status, reason}] 失敗時の理由確認用
      webSubscriptions: webSubs.length,
    });
  } catch (e) {
    if (e instanceof AuthError) return unauthorized();
    return Response.json({ error: String(e) }, { status: 500 });
  }
}
