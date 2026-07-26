"use client";

// クライアント専用：App内課金（プレミアム ¥480/月）の RevenueCat ラッパー。
// native.ts と同じ方針で、SDKは動的 import しWebバンドルには含めない。
//  - NEXT_PUBLIC_REVENUECAT_IOS_KEY が設定され、かつネイティブ（Capacitor）内のときだけ動く
//  - ログイン後に configurePurchases(userId) を呼び appUserID=CashSyncのユーザーID で紐付ける
//    （サーバーのWebhook/syncはこのIDで users.plan を切り替える）
//  - 商品: App Store Connect のサブスク `cashsync_premium_monthly`（¥480/月）
//  - entitlement: RevenueCat ダッシュボードで `premium` を定義する
// セットアップ手順は cashsync-design/store/iap-setup-guide.md 参照。
import type { PurchasesPackage } from "@revenuecat/purchases-capacitor";
import { isNativePlatform } from "./native";

/** App Store Connect で作るサブスク商品のID */
export const PREMIUM_PRODUCT_ID = "cashsync_premium_monthly";
/** RevenueCat で定義する entitlement のID */
export const PREMIUM_ENTITLEMENT_ID = "premium";

const RC_IOS_KEY = process.env.NEXT_PUBLIC_REVENUECAT_IOS_KEY || "";

/** 課金導線を出せる状態か（ネイティブ かつ RevenueCat APIキー設定済み） */
export function isPurchasesAvailable(): boolean {
  return isNativePlatform() && !!RC_IOS_KEY;
}

async function rc() {
  return await import("@revenuecat/purchases-capacitor");
}

let configured: Promise<void> | null = null;
let lastUserId = ""; // 失敗後のリトライ用（ensureConfigured から再初期化する）

/**
 * RevenueCat SDK を初期化（初回のみ）。ログイン済み画面のマウント時に呼ぶ。
 * 非ネイティブ・キー未設定では何もしない。
 */
export function configurePurchases(userId: string): Promise<void> {
  if (!isPurchasesAvailable()) return Promise.resolve();
  lastUserId = userId;
  if (!configured) {
    configured = (async () => {
      const { Purchases } = await rc();
      await Purchases.configure({ apiKey: RC_IOS_KEY, appUserID: userId });
    })().catch((e) => {
      configured = null; // 失敗時は次回リトライ
      throw e;
    });
  }
  return configured;
}

/** 購入・復元の結果。active=premium entitlement が有効か（サーバーの /api/purchases/sync に渡す） */
export interface PurchaseResult {
  status: "purchased" | "restored" | "cancelled" | "not-entitled";
  active: boolean;
}

function isUserCancelled(e: unknown): boolean {
  if (!e || typeof e !== "object") return false;
  const err = e as { code?: unknown; userCancelled?: unknown };
  // PURCHASES_ERROR_CODE.PURCHASE_CANCELLED_ERROR = "1"（旧SDKは userCancelled フラグ）
  return err.userCancelled === true || String(err.code) === "1";
}

/** 現在のofferingからプレミアム月額のパッケージを選ぶ */
async function findPremiumPackage(): Promise<PurchasesPackage | null> {
  const { Purchases } = await rc();
  const offerings = await Purchases.getOfferings();
  const current = offerings.current;
  if (!current) return null;
  return (
    current.availablePackages.find((p) => p.product.identifier === PREMIUM_PRODUCT_ID) ??
    current.monthly ??
    current.availablePackages[0] ??
    null
  );
}

/**
 * プレミアム（¥480/月）を購入する。Appleの購入シートが開く。
 * キャンセルは { status: 'cancelled' }。それ以外の失敗は throw（呼び出し側で表示）。
 */
export async function purchasePremium(): Promise<PurchaseResult> {
  await ensureConfigured();
  const pkg = await findPremiumPackage();
  if (!pkg) {
    throw new Error("商品情報を取得できませんでした。時間をおいて再度お試しください。");
  }
  const { Purchases } = await rc();
  try {
    const { customerInfo } = await Purchases.purchasePackage({ aPackage: pkg });
    const active = !!customerInfo.entitlements.active[PREMIUM_ENTITLEMENT_ID];
    return { status: active ? "purchased" : "not-entitled", active };
  } catch (e) {
    if (isUserCancelled(e)) return { status: "cancelled", active: false };
    throw e;
  }
}

/** 機種変更等での「購入の復元」。App Store のアカウントから過去の購入を引き直す */
export async function restorePremium(): Promise<PurchaseResult> {
  await ensureConfigured();
  const { Purchases } = await rc();
  const { customerInfo } = await Purchases.restorePurchases();
  const active = !!customerInfo.entitlements.active[PREMIUM_ENTITLEMENT_ID];
  return { status: active ? "restored" : "not-entitled", active };
}

async function ensureConfigured(): Promise<void> {
  if (!isPurchasesAvailable()) {
    throw new Error("プレミアムはiOSアプリから購入できます。");
  }
  if (!configured && lastUserId) {
    configurePurchases(lastUserId); // 初期化失敗後のリトライ
  }
  if (!configured) {
    throw new Error("課金機能の初期化前です。アプリを再起動してお試しください。");
  }
  await configured;
}
