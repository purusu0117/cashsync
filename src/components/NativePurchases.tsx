"use client";

// ネイティブアプリ（Capacitor）かつ RevenueCat キー設定済みのときだけ、
// ログイン後に App内課金SDK を appUserID=ユーザーID で初期化する。
// これでサーバーのWebhook（app_user_id）とCashSyncのユーザーが紐付く。
// Web/PWA・キー未設定では何もしない（SDKも動的importなので読み込まれない）。
import { useEffect } from "react";
import { configurePurchases, isPurchasesAvailable } from "@/lib/purchases";

export default function NativePurchases({ userId }: { userId: string }) {
  useEffect(() => {
    if (!isPurchasesAvailable()) return;
    configurePurchases(userId).catch(() => {
      // 初期化失敗は購入操作時にリトライされる（purchases.ts 側）
    });
  }, [userId]);
  return null;
}
