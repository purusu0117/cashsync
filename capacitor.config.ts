// Capacitor ネイティブシェル設定（remote URL 方式）。
// Next.js は SSR/API ありのため web 資産はバンドルせず、
// WebView が本番URL（Vercel）を直接読み込む。webDir はプレースホルダのみ。
//  - CAPACITOR_SERVER_URL     … 読み込み先URLの上書き（既定: 本番Vercel）
//  - CAPACITOR_SERVER_CLEARTEXT=1 … ローカル開発時に http を許可
import type { CapacitorConfig } from "@capacitor/cli";

const serverUrl = process.env.CAPACITOR_SERVER_URL || "https://cashsync-eight.vercel.app";

const config: CapacitorConfig = {
  appId: "com.daito.cashsync",
  appName: "CashSync",
  // remote URL 方式のため実質未使用（cap sync が要求するので最小のプレースホルダを置く）
  webDir: "native/www",
  server: {
    url: serverUrl,
    cleartext: process.env.CAPACITOR_SERVER_CLEARTEXT === "1",
  },
  plugins: {
    AdMob: {
      // AdMob 初期化はアプリ側（src/lib/native.ts）で行う。ここは予約領域。
    },
    PushNotifications: {
      // アプリを前面で開いている間もバナー＋音で通知を表示する。
      // これが無いと iOS 既定で「使用中アプリ自身の通知」は画面に出ない（背面/ロック時のみ表示）。
      // テスト通知が前面で出なかった原因（2026-07-28・APNsは200で届いていた）。
      presentationOptions: ["badge", "sound", "alert"],
    },
  },
};

export default config;
