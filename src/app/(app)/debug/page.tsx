"use client";

// ネイティブ連携の診断ページ（/debug）。
// 「ウィジェットに出ない」「通知が来ない」ときに、WebViewから見えている実際の状態を表示する。
// 推測で往復しないための画面。問題が落ち着いたら削除してよい。
import { useEffect, useState } from "react";
import { isNativePlatform, nativePlugin, registerPushDevice, syncWidgetAuth } from "@/lib/native";

type Row = { label: string; value: string; ok?: boolean };

export default function DebugPage() {
  const [rows, setRows] = useState<Row[]>([]);
  const [log, setLog] = useState<string[]>([]);

  const add = (label: string, value: unknown, ok?: boolean) =>
    setRows((r) => [...r, { label, value: String(value), ok }]);

  useEffect(() => {
    (async () => {
      const w = window as unknown as { Capacitor?: Record<string, unknown> };
      const cap = w.Capacitor;
      add("window.Capacitor", cap ? "あり" : "無し（＝ネイティブブリッジ未注入）", !!cap);
      add("Capacitorのキー", cap ? Object.keys(cap).join(", ") : "-");
      add(
        "Capacitor.Plugins",
        cap?.Plugins ? Object.keys(cap.Plugins as object).join(", ") || "（空）" : "無し",
        !!cap?.Plugins,
      );
      add("isNativePlatform()", isNativePlatform(), isNativePlatform());

      const pc = await nativePlugin<Record<string, unknown>>("PhotoCleaner");
      add("PhotoCleanerプラグイン", pc ? "取得できた" : "取得できない", !!pc);
      if (pc) {
        add(
          "使えるメソッド",
          ["setWidgetAuth", "clearWidgetAuth", "scheduleReminder", "deletePhotos"]
            .filter((m) => typeof (pc as Record<string, unknown>)[m] === "function")
            .join(", ") || "（無し）",
        );
      }

      try {
        const p = await fetch("/api/profile").then((r) => r.json());
        add("APIトークン", p.apiToken ? `取得できた（${String(p.apiToken).slice(0, 6)}…）` : "無し", !!p.apiToken);
        if (p.apiToken) {
          await syncWidgetAuth(p.apiToken);
          setLog((l) => [...l, "syncWidgetAuth を実行しました"]);
        }
      } catch (e) {
        add("APIトークン", `失敗: ${e instanceof Error ? e.message : e}`, false);
      }
    })().catch((e) => setLog((l) => [...l, `エラー: ${e}`]));
  }, []);

  return (
    <div className="space-y-3 pb-8">
      <h1 className="text-base font-bold tracking-[0.04em]">ネイティブ連携の診断</h1>
      <div className="divide-y divide-rule rounded-2xl border border-rule bg-card px-4 shadow-sm">
        {rows.map((r, i) => (
          <div key={i} className="py-2 text-xs">
            <div className="text-ink-faint">{r.label}</div>
            <div className={r.ok === false ? "text-vermilion" : r.ok ? "text-sage" : ""}>{r.value}</div>
          </div>
        ))}
      </div>
      <button
        onClick={async () => {
          setLog((l) => [...l, "端末登録を実行中…"]);
          await registerPushDevice();
          const r = await fetch("/api/push/test", { method: "POST" }).then((x) => x.json());
          setLog((l) => [...l, `テスト通知: ${JSON.stringify(r)}`]);
        }}
        className="w-full rounded-xl border border-ink py-3 text-sm font-semibold active:translate-y-0.5"
      >
        通知の端末登録＋テスト送信
      </button>
      <button
        onClick={async () => {
          const p = await fetch("/api/profile").then((r) => r.json());
          await syncWidgetAuth(p.apiToken ?? "");
          setLog((l) => [...l, "ウィジェットへトークンを再送しました"]);
        }}
        className="w-full rounded-xl border border-ink py-3 text-sm font-semibold active:translate-y-0.5"
      >
        ウィジェットにトークンを送る
      </button>
      {log.length > 0 && (
        <div className="rounded-md border border-rule bg-card p-3 text-[11px] break-all">
          {log.map((l, i) => (
            <p key={i}>{l}</p>
          ))}
        </div>
      )}
    </div>
  );
}
