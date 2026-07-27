"use client";

// ネイティブアプリのとき、ホーム画面ウィジェットが使うAPIトークンを端末側（App Group）へ渡す。
// ウィジェットはアプリとは別プロセスでセッションCookieを読めないため、この橋渡しが無いと
// ウィジェットが「アプリでログインするとここに残額が出ます」のままになる。
// あわせて、記録リマインドをローカル通知として端末に仕込む（サーバープッシュはWebViewでは動かないため）。
import { useEffect } from "react";
import { isNativePlatform, scheduleLocalReminder, syncWidgetAuth } from "@/lib/native";

export default function NativeWidgetBridge() {
  useEffect(() => {
    if (!isNativePlatform()) return;
    let cancelled = false;
    (async () => {
      try {
        const d = await fetch("/api/profile").then((r) => r.json());
        if (cancelled) return;
        if (d.apiToken) await syncWidgetAuth(d.apiToken);
        // 設定済みのリマインド時刻を、この端末のローカル通知として登録し直す（冪等）
        if (typeof d.reminderHour === "number") await scheduleLocalReminder(d.reminderHour);
      } catch {
        /* 取得できなければ次回起動時に再試行 */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);
  return null;
}
