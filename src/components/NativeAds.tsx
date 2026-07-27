"use client";

// ネイティブアプリ（Capacitor）かつ free プランのときだけ上部AdMobバナーを出す。
// Web/PWA では isNativePlatform() が false なので何もしない（既存挙動そのまま）。
import { useEffect } from "react";
import { isNativePlatform, removeTopBanner, showTopBanner } from "@/lib/native";

export default function NativeAds({ plan }: { plan: string }) {
  // ネイティブなら広告の有無に関わらずセーフエリア分の余白を確保する。
  // （これが無いとノッチ／ステータスバーの下に最上部の要素が入り込みタップできない）
  useEffect(() => {
    if (!isNativePlatform()) return;
    document.body.classList.add("native-app");
    return () => document.body.classList.remove("native-app");
  }, []);

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
