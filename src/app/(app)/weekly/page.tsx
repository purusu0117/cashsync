"use client";

// 週次振り返り：先週（月〜日）の支出をレシート風カード3枚で。
import Link from "next/link";
import { useEffect, useState } from "react";
import Loading from "@/components/Loading";
import { cachedFetch } from "@/lib/cachedFetch";
import { fmtDateJa, fmtYen } from "@/lib/format";

interface Weekly {
  range: { start: string; end: string };
  total: number;
  prevTotal: number;
  top: { category: string; icon: string; amount: number } | null;
  max: { memo: string; amount: number; date: string } | null;
  noMoneyDays: number;
}

export default function WeeklyPage() {
  const [data, setData] = useState<Weekly | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    // キャッシュファースト：前回のデータを即表示→裏で最新に差し替え
    cachedFetch<Weekly>("/api/weekly", (d) => setData(d)).catch((e) =>
      setError(e instanceof Error ? e.message : "読み込みに失敗しました。"),
    );
  }, []);

  if (error && !data) return <p className="mt-10 text-center text-sm text-vermilion">{error}</p>;
  if (!data) return <Loading label="集計中・・・" />;

  const diff = data.total - data.prevTotal;
  const diffPct = data.prevTotal > 0 ? Math.round((diff / data.prevTotal) * 100) : null;
  const saved = diff < 0;

  return (
    <div className="space-y-4">
      <h1 className="dot text-lg">先週の振り返り</h1>
      <p className="text-xs text-ink-faint">
        {fmtDateJa(data.range.start)} 〜 {fmtDateJa(data.range.end)}
      </p>

      {/* カード1：支出合計と先週比 */}
      <section className="zig zig-t zig-b px-5 py-5 text-center shadow-sm">
        <p className="dot text-xs text-ink-faint">＊ 先週つかったお金（固定費除く）＊</p>
        <p className="dot mt-2 text-5xl tabular-nums">{fmtYen(data.total)}</p>
        {diffPct !== null ? (
          <p className={`dot mt-2 text-sm ${saved ? "text-sage" : "text-vermilion"}`}>
            前の週より {saved ? "▼" : "▲"}
            {fmtYen(Math.abs(diff))}（{Math.abs(diffPct)}%{saved ? "節約" : "増"}）
            {saved && " 🎉"}
          </p>
        ) : (
          <p className="mt-2 text-xs text-ink-faint">前の週の記録はありません</p>
        )}
      </section>

      {/* カード2：内訳ハイライト */}
      <section className="zig zig-t zig-b px-5 py-4 shadow-sm">
        <p className="dot text-xs text-ink-faint">＊ ハイライト ＊</p>
        {data.top && (
          <div className="mt-2 flex items-baseline text-sm">
            <span>いちばん使ったのは {data.top.icon} {data.top.category}</span>
            <span className="leader" />
            <span className="dot tabular-nums">{fmtYen(data.top.amount)}</span>
          </div>
        )}
        {data.max && (
          <div className="mt-1.5 flex items-baseline text-sm">
            <span className="truncate">最大の買い物：{data.max.memo || "支出"}</span>
            <span className="leader" />
            <span className="dot tabular-nums">{fmtYen(data.max.amount)}</span>
          </div>
        )}
        {!data.top && !data.max && (
          <p className="mt-2 text-center text-xs text-ink-faint">先週は支出ゼロでした！完璧です</p>
        )}
      </section>

      {/* カード3：ノーマネーデー */}
      <section className="zig zig-t zig-b px-5 py-4 text-center shadow-sm">
        <p className="dot text-xs text-ink-faint">＊ ノーマネーデー ＊</p>
        <p className="dot mt-1 text-3xl">
          🈚 × {data.noMoneyDays}<span className="text-base text-ink-faint">/7日</span>
        </p>
        <p className="mt-1 text-xs text-ink-faint">
          {data.noMoneyDays >= 4
            ? "半分以上お金を使わない日でした。すばらしい！"
            : data.noMoneyDays >= 2
              ? "いい調子。あと1日増やせるとさらに貯まります"
              : "今週は「買わない日」を1日つくってみましょう"}
        </p>
        <div className="barcode mt-4" />
      </section>

      <Link
        href="/stats"
        className="block rounded-md border border-dashed border-rule py-3 text-center text-sm text-ink-faint"
      >
        📊 月全体のグラフを見る
      </Link>
    </div>
  );
}
