// クライアント購入直後の即時反映（Webhook遅延の補完。真実のソースはWebhook側）。
// アプリが purchasePackage / restorePurchases の結果（entitlement有効か）をPOSTしてくる。
//  - REVENUECAT_SECRET_KEY があれば RevenueCat REST API で entitlement を照会して検証
//    （クライアント申告を信用しない）。未設定の間は申告値をそのまま使う
//    （最終的にはWebhookが上書き訂正するため恒久的な不正昇格はできない）。
//  - founder は常に不変（purchases-server.ts 側で保証）
import { getUserPlan } from "@/lib/aiUsage";
import { AuthError, requireUser, unauthorized } from "@/lib/auth";
import { setPlanFromEntitlement } from "@/lib/purchases-server";

export const dynamic = "force-dynamic";

// RevenueCat REST API（GET /v1/subscribers/{app_user_id}）のレスポンスの必要部分
interface SubscriberResponse {
  subscriber?: {
    entitlements?: Record<string, { expires_date?: string | null }>;
  };
}

/** RevenueCat REST APIで premium entitlement が有効か照会。判定不能なら null */
async function verifyWithRevenueCat(userId: string): Promise<boolean | null> {
  const secretKey = process.env.REVENUECAT_SECRET_KEY;
  if (!secretKey) return null;
  try {
    const res = await fetch(
      `https://api.revenuecat.com/v1/subscribers/${encodeURIComponent(userId)}`,
      { headers: { Authorization: `Bearer ${secretKey}` }, cache: "no-store" },
    );
    if (!res.ok) return null;
    const data = (await res.json()) as SubscriberResponse;
    const ent = data.subscriber?.entitlements?.premium;
    if (!ent) return false;
    // expires_date が null（生涯）または未来なら有効
    return !ent.expires_date || Date.parse(ent.expires_date) > Date.now();
  } catch {
    return null; // 照会失敗時は判定を保留（クライアント申告にフォールバック）
  }
}

export async function POST(request: Request) {
  try {
    const user = await requireUser();
    const body = (await request.json().catch(() => ({}))) as { active?: boolean };
    let active = body.active === true;
    const verified = await verifyWithRevenueCat(user.id);
    if (verified !== null) active = verified;
    const plan = (await setPlanFromEntitlement(user.id, active)) ?? (await getUserPlan(user.id));
    return Response.json({ ok: true, plan });
  } catch (e) {
    if (e instanceof AuthError) return unauthorized();
    return Response.json({ error: String(e) }, { status: 500 });
  }
}
