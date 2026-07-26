// サーバー専用：RevenueCat（App内課金）のイベント → users.plan への反映ロジック。
// ルール:
//  - founder は常に不変（購入・失効イベントが来ても昇格も降格もさせない）
//  - INITIAL_PURCHASE / RENEWAL / UNCANCELLATION / PRODUCT_CHANGE → 'premium'
//  - EXPIRATION → 'free'
//  - CANCELLATION は「自動更新OFF」の通知で、期限までは有効なのが通常。
//    expiration_at_ms が既に過ぎている（返金等での即時失効）ときだけ 'free' に落とす
// Webhookが正（真実のソース）。/api/purchases/sync はUI即時反映のための補完。
import { normalizePlan, type Plan } from "./aiUsage";
import { db } from "./db";

/** RevenueCat Webhookの event.type（https://www.revenuecat.com/docs/integrations/webhooks/event-types-and-fields） */
export type RevenueCatEventType =
  | "INITIAL_PURCHASE"
  | "RENEWAL"
  | "UNCANCELLATION"
  | "PRODUCT_CHANGE"
  | "CANCELLATION"
  | "EXPIRATION"
  | "NON_RENEWING_PURCHASE"
  | "BILLING_ISSUE"
  | "SUBSCRIPTION_PAUSED"
  | "TRANSFER"
  | "TEST"
  | (string & Record<never, never>);

const UPGRADE_EVENTS = new Set(["INITIAL_PURCHASE", "RENEWAL", "UNCANCELLATION", "PRODUCT_CHANGE"]);

export interface ApplyEventResult {
  /** 反映後のプラン。ユーザーが見つからない場合は null */
  plan: Plan | null;
  changed: boolean;
}

/**
 * RevenueCatのイベント1件を users.plan に反映する。
 * now は現在時刻（エポックms）。テストから固定時刻を注入できる。
 */
export async function applyPurchaseEvent(
  userId: string,
  eventType: RevenueCatEventType,
  opts: { expirationAtMs?: number | null; now?: number } = {},
): Promise<ApplyEventResult> {
  const d = await db();
  const row = await d.get<{ plan: string | null }>("SELECT plan FROM users WHERE id = ?", userId);
  if (!row) return { plan: null, changed: false };
  const current = normalizePlan(row.plan);
  if (current === "founder") return { plan: "founder", changed: false }; // founder は常に不変

  let next: Plan = current;
  if (UPGRADE_EVENTS.has(eventType)) {
    next = "premium";
  } else if (eventType === "EXPIRATION") {
    next = "free";
  } else if (eventType === "CANCELLATION") {
    // 通常のキャンセルは期限まで有効。即時失効（返金等）のときだけ降格
    const now = opts.now ?? Date.now();
    const exp = opts.expirationAtMs;
    if (typeof exp === "number" && exp <= now) next = "free";
  }
  if (next === current) return { plan: current, changed: false };
  await d.run("UPDATE users SET plan = ? WHERE id = ?", next, userId);
  return { plan: next, changed: true };
}

/**
 * entitlement の有効状態から plan を直接セットする（/api/purchases/sync 用）。
 * founder は不変。active → premium / inactive → free。
 */
export async function setPlanFromEntitlement(
  userId: string,
  active: boolean,
): Promise<Plan | null> {
  const d = await db();
  const row = await d.get<{ plan: string | null }>("SELECT plan FROM users WHERE id = ?", userId);
  if (!row) return null;
  const current = normalizePlan(row.plan);
  if (current === "founder") return "founder";
  const next: Plan = active ? "premium" : "free";
  if (next !== current) {
    await d.run("UPDATE users SET plan = ? WHERE id = ?", next, userId);
  }
  return next;
}
