"use client";

// 自前・軽量アナリティクスの最小ダッシュ（管理者=founderのみ表示）。
// /api/events の集計を取得して、イベント名ごとの件数とユニークユーザー数を並べるだけ。
// 非管理者では 403 が返るので何も描画しない（過剰実装はしない）。
import { useEffect, useState } from "react";
import { netFetch } from "@/lib/cachedFetch";

interface Row {
  name: string;
  count: number;
  users: number;
}

// 表示名（内部イベント名 → 日本語ラベル）
const LABELS: Record<string, string> = {
  app_open: "アプリ起動",
  signup: "新規登録",
  activated: "初回記録（活性化）",
  scan_used: "レシート読取",
  parse_used: "AI解析",
  manual_add: "手入力記録",
  subscribe: "課金",
};

export default function AdminAnalytics() {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    netFetch("/api/events")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (d && Array.isArray(d.summary)) {
          setRows(d.summary);
          setVisible(true);
        }
      })
      .catch(() => {});
  }, []);

  if (!visible) return null;

  return (
    <section className="zig zig-t zig-b px-4 py-4 shadow-sm">
      <h2 className="dot mb-2 text-xs text-ink-faint">アナリティクス（管理者のみ）</h2>
      {rows && rows.length > 0 ? (
        <table className="w-full text-sm tabular-nums">
          <thead>
            <tr className="text-[11px] text-ink-faint">
              <th className="text-left font-normal">イベント</th>
              <th className="text-right font-normal">件数</th>
              <th className="text-right font-normal">人数</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.name} className="border-t border-rule/50">
                <td className="py-1">{LABELS[r.name] ?? r.name}</td>
                <td className="py-1 text-right">{r.count}</td>
                <td className="py-1 text-right">{r.users}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p className="text-xs text-ink-faint">まだデータがありません。</p>
      )}
    </section>
  );
}
