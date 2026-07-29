"use client";

// 週次振り返り（先週・月〜日）のレシート風カード。/weekly と /stats の「週」タブで共用（C9）。
// B3: 記録0件の週は「支出ゼロ！」と称賛せず、記録開始の案内カードに切り替える。
import Link from "next/link";
import { useEffect, useState } from "react";
import { CategoryIcon } from "@/components/Icons";
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
  recordCount?: number; // 旧キャッシュには無いので optional
}

export default function WeeklyReview({ showStatsLink = false }: { showStatsLink?: boolean }) {
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

  // B3: 先週の記録が1件もない＝振り返る材料がない。称賛ではなく記録開始の案内を出す
  if ((data.recordCount ?? (data.total > 0 ? 1 : 0)) === 0) {
    return (
      <div className="space-y-4">
        <p className="text-xs text-ink-faint">
          {fmtDateJa(data.range.start)} 〜 {fmtDateJa(data.range.end)}
        </p>
        <section className="rounded-2xl border border-rule bg-card p-4 text-center shadow-sm">
          <p className="text-xs text-ink-faint">週の振り返り</p>
          <p className="mt-3 text-sm leading-relaxed">
            記録を始めると週の振り返りが届きます
          </p>
          <p className="mt-1 text-[11px] text-ink-faint">
            先週の支出合計・使ったカテゴリ・ノーマネーデーをここで振り返れます
          </p>
          <Link
            href="/"
            className="mt-4 inline-block rounded-xl border border-ink px-4 py-2 text-sm font-semibold active:translate-y-0.5"
          >
            ホームで記録する
          </Link>
        </section>
      </div>
    );
  }

  const diff = data.total - data.prevTotal;
  const diffPct = data.prevTotal > 0 ? Math.round((diff / data.prevTotal) * 100) : null;
  const saved = diff < 0;

  return (
    <div className="space-y-4">
      <p className="text-xs text-ink-faint">
        {fmtDateJa(data.range.start)} 〜 {fmtDateJa(data.range.end)}
      </p>

      {/* カード1：支出合計と先週比 */}
      <section className="rounded-3xl border border-rule bg-card p-4 text-center shadow-sm">
        <p className="text-xs text-ink-faint">先週つかったお金（固定費除く）</p>
        <p className="mt-2 text-5xl font-black tabular-nums">{fmtYen(data.total)}</p>
        {diffPct !== null ? (
          <p className={`mt-2 text-sm ${saved ? "text-sage" : "text-vermilion"}`}>
            前の週より {saved ? "▼" : "▲"}
            {fmtYen(Math.abs(diff))}（{Math.abs(diffPct)}%{saved ? "節約" : "増"}）
          </p>
        ) : (
          <p className="mt-2 text-xs text-ink-faint">前の週の記録はありません</p>
        )}
      </section>

      {/* カード2：内訳ハイライト */}
      <section className="rounded-2xl border border-rule bg-card p-4 shadow-sm">
        <p className="text-xs text-ink-faint">ハイライト</p>
        {data.top && (
          <div className="mt-2 flex items-baseline text-sm">
            <span className="flex items-center gap-1">
              いちばん使ったのは <CategoryIcon icon={data.top.icon} className="h-4 w-4 text-ink-faint" />
              {data.top.category}
            </span>
            <span className="leader" />
            <span className="font-bold tabular-nums">{fmtYen(data.top.amount)}</span>
          </div>
        )}
        {data.max && (
          <div className="mt-1.5 flex items-baseline text-sm">
            <span className="truncate">最大の買い物：{data.max.memo || "支出"}</span>
            <span className="leader" />
            <span className="font-bold tabular-nums">{fmtYen(data.max.amount)}</span>
          </div>
        )}
        {!data.top && !data.max && (
          <p className="mt-2 text-center text-xs text-ink-faint">先週は支出ゼロでした！完璧です</p>
        )}
      </section>

      {/* カード3：ノーマネーデー */}
      <section className="rounded-2xl border border-rule bg-card p-4 text-center shadow-sm">
        <p className="text-xs text-ink-faint">ノーマネーデー</p>
        <p className="mt-1 text-3xl font-black tabular-nums">
          <span>無</span> × {data.noMoneyDays}
          <span className="text-base text-ink-faint">/7日</span>
        </p>
        <p className="mt-1 text-xs text-ink-faint">
          {data.noMoneyDays >= 4
            ? "半分以上お金を使わない日でした。すばらしい！"
            : data.noMoneyDays >= 2
              ? "いい調子。あと1日増やせるとさらに貯まります"
              : "今週は「買わない日」を1日つくってみましょう"}
        </p>
      </section>

      {showStatsLink && (
        <Link
          href="/stats"
          className="block rounded-xl border border-dashed border-rule py-3 text-center text-sm font-semibold text-ink-faint"
        >
          月全体のグラフを見る
        </Link>
      )}
    </div>
  );
}
