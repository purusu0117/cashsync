"use client";

// ネイティブアプリ（Capacitor）かつ free プランのときだけ上部AdMobバナーを出す。
// Web/PWA では isNativePlatform() が false なので何もしない（既存挙動そのまま）。
import { useEffect } from "react";
import { isNativePlatform, removeTopBanner, showTopBanner } from "@/lib/native";

export default function NativeAds({ plan }: { plan: string }) {
  useEffect(() => {
    if (!isNativePlatform() || plan !== "free") return;
    document.body.classList.add("native-banner");
    showTopBanner().catch(() => {
      // 広告が出せない場合は余白も戻す
      document.body.classList.remove("native-banner");
    });
    return () => {
      document.body.classList.remove("native-banner");
      removeTopBanner().catch(() => {});
    };
  }, [plan]);
  return null;
}
