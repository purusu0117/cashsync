// RevenueCat Webhook 受け口（真実のソース）。
// RevenueCatダッシュボードで Webhook URL と Authorization ヘッダ値を登録すると、
// 購入・更新・失効イベントがここに届き users.plan を premium/free に切り替える。
//  - 認証: Authorization ヘッダが環境変数 REVENUECAT_WEBHOOK_AUTH と完全一致すること
//  - app_user_id: 購入時に configure({ appUserID: ユーザーID }) で紐付けた CashSync のユーザーID
//  - founder は常に不変（purchases-server.ts 側で保証）
// 2xx 以外を返すと RevenueCat が自動リトライするため、
// 「処理対象外イベント」「未知のユーザー」は 200 で受け流す（リトライ嵐を防ぐ）。
import { timingSafeEqual } from "node:crypto";
import { applyPurchaseEvent } from "@/lib/purchases-server";

export const dynamic = "force-dynamic";

// RevenueCat Webhook ペイロードの必要部分だけ
interface RevenueCatWebhookBody {
  event?: {
    type?: string;
    app_user_id?: string;
    expiration_at_ms?: number | null;
  };
}

function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

export async function POST(request: Request) {
  const secret = process.env.REVENUECAT_WEBHOOK_AUTH;
  if (!secret) {
    // 未設定＝課金機能OFF。設定漏れに気づけるようエラーで返す
    return Response.json({ error: "webhook not configured" }, { status: 503 });
  }
  const auth = request.headers.get("authorization") ?? "";
  if (!safeEqual(auth, secret)) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  let body: RevenueCatWebhookBody;
  try {
    body = (await request.json()) as RevenueCatWebhookBody;
  } catch {
    return Response.json({ error: "invalid json" }, { status: 400 });
  }
  const event = body.event;
  const type = event?.type ?? "";
  const appUserId = event?.app_user_id ?? "";

  // 匿名ID（configure前の購入等）はユーザーに紐付けられない → 受領だけ返す。
  // その後アプリ内で configure(appUserID) されると TRANSFER が届き、復元/syncで反映される
  if (!type || !appUserId || appUserId.startsWith("$RCAnonymousID:")) {
    return Response.json({ ok: true, skipped: true });
  }

  try {
    const result = await applyPurchaseEvent(appUserId, type, {
      expirationAtMs: event?.expiration_at_ms ?? null,
    });
    if (result.plan === null) {
      console.warn(`[purchases/webhook] 未知の app_user_id: ${appUserId} (${type})`);
      return Response.json({ ok: true, skipped: true });
    }
    console.log(
      `[purchases/webhook] ${type} user=${appUserId} → plan=${result.plan}${result.changed ? "（変更）" : "（変更なし）"}`,
    );
    return Response.json({ ok: true, plan: result.plan, changed: result.changed });
  } catch (e) {
    // DB障害等は 500 → RevenueCat が後で自動リトライしてくれる
    console.error("[purchases/webhook] 反映失敗:", e);
    return Response.json({ error: "internal" }, { status: 500 });
  }
}
