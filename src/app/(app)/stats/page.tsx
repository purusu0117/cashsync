"use client";

// グラフ：月次の収入/支出バー（ページャで何ヶ月でも遡れる）＋選択月のカテゴリ内訳
import { useCallback, useEffect, useRef, useState } from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import Assets from "@/components/Assets";
import { CategoryIcon } from "@/components/Icons";
import Loading from "@/components/Loading";
import WeeklyReview from "@/components/WeeklyReview";
import { cachedFetch } from "@/lib/cachedFetch";
import { fmtMonthJa, fmtYen, todayLocal } from "@/lib/format";

interface Point {
  month: string;
  income: number;
  expense: number;
  savings: number;
}
interface Breakdown {
  category: string;
  icon: string;
  amount: number;
  fixedAmount?: number; // C12: うち固定費（旧キャッシュには無いので optional）
}
interface CategoryDelta {
  category: string;
  icon: string;
  current: number;
  prev: number;
  delta: number;
}
interface Compare {
  expense: { current: number; prev: number | null; prevYear: number | null };
  income: { current: number; prev: number | null; prevYear: number | null };
  increased: CategoryDelta[];
  decreased: CategoryDelta[];
}
interface Pocket {
  id: string;
  name: string;
  icon: string;
  budget: number;
  spent: number;
  carryover?: number; // C13: 1=繰り越しON（旧キャッシュには無いので optional）
  carryoverAmount?: number; // C13: 前月の余り（0下限）
}
interface TagStat {
  id: string;
  name: string;
  amount: number;
  count: number;
}
interface Review {
  headline: string;
  overspend: { category: string; amount: number; prevAmount: number; comment: string }[];
  good: string[];
  advice: { title: string; detail: string; saveEstimate: number }[];
}

const INCOME = "#2f8f5b";
const EXPENSE = "#e8442e";
const WINDOW = 6;

function shiftMonth(month: string, delta: number): string {
  const [y, m] = month.split("-").map(Number);
  const d = new Date(y, m - 1 + delta, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

export default function StatsPage() {
  // C9: 週次振り返りをグラフ画面に常設（「週/月/年/資産」切替。既定は月。C14: 年間ビュー・資産ビュー追加）
  const [view, setView] = useState<"month" | "week" | "year" | "assets">("month");
  const [before, setBefore] = useState(todayLocal().slice(0, 7));
  const [selected, setSelected] = useState(todayLocal().slice(0, 7));
  const [series, setSeries] = useState<Point[]>([]);
  const [breakdown, setBreakdown] = useState<Breakdown[]>([]);
  const [compare, setCompare] = useState<Compare | null>(null); // 前月比・前年同月比
  const [review, setReview] = useState<Review | null>(null);
  const [reviewLoading, setReviewLoading] = useState(false);
  const [reviewError, setReviewError] = useState("");
  const [pockets, setPockets] = useState<Pocket[]>([]);
  const [tagStats, setTagStats] = useState<TagStat[]>([]); // 選択月のタグ別支出
  const [editPocket, setEditPocket] = useState<string | null>(null);
  const [pocketAmount, setPocketAmount] = useState("");
  const [pocketCarry, setPocketCarry] = useState(false); // C13: 繰り越しトグル
  // C14: 年間ビュー（1〜12月の収支バー＋年合計。過去は全期間さかのぼり可能）
  const [year, setYear] = useState(Number(todayLocal().slice(0, 4)));
  const [yearSeries, setYearSeries] = useState<Point[]>([]);

  const [ready, setReady] = useState(false); // 初回データ（キャッシュ含む）が来るまでスケルトン表示
  const [loadStalled, setLoadStalled] = useState(false); // 初回読み込みが失敗して固まったまま

  const loadPockets = useCallback(async () => {
    await cachedFetch<{ pockets?: Pocket[] }>("/api/budgets", (d) =>
      setPockets(d.pockets ?? []),
    ).catch(() => {});
  }, []);

  useEffect(() => {
    loadPockets();
  }, [loadPockets]);

  async function savePocket(categoryId: string) {
    await fetch("/api/budgets", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        categoryId,
        amount: Number(pocketAmount) || 0,
        carryover: pocketCarry, // C13: 前月の余りを当月予算に繰り越す
      }),
    });
    setEditPocket(null);
    setPocketAmount("");
    loadPockets();
  }

  // 期間切替の連打時に古いレスポンスで上書きされないよう、最新リクエストだけ反映する
  const reqRef = useRef(0);
  const load = useCallback(async (b: string, sel: string) => {
    const req = ++reqRef.current;
    // キャッシュファースト：前回のデータを即表示→裏で最新に差し替え
    await cachedFetch<{ series?: Point[]; breakdown?: Breakdown[]; compare?: Compare | null }>(
      `/api/stats?months=${WINDOW}&before=${b}&month=${sel}&compare=1`,
      (d) => {
        if (reqRef.current !== req) return;
        setSeries(d.series ?? []);
        setBreakdown(d.breakdown ?? []);
        setCompare(d.compare ?? null);
        setReady(true);
      },
    ).catch(() => {
      /* 初回読み込み失敗時はスケルトンのまま（復帰時の visibilitychange で再試行される） */
    });
  }, []);

  useEffect(() => {
    // ホームの「先月の振り返り」カード等からの ?m=YYYY-MM 指定
    const m = new URLSearchParams(location.search).get("m");
    if (m && /^\d{4}-\d{2}$/.test(m)) {
      setSelected(m);
      setBefore(m < todayLocal().slice(0, 7) ? todayLocal().slice(0, 7) : m);
    }
  }, []);

  // 選択月のタグ別支出（横断タグ）。カテゴリ内訳とは別軸で今月の内訳を見る
  useEffect(() => {
    cachedFetch<{ stats?: TagStat[] }>(`/api/tags?stats=${selected}`, (d) =>
      setTagStats(d.stats ?? []),
    ).catch(() => {});
  }, [selected]);

  useEffect(() => {
    load(before, selected);
    setReview(null);
    setReviewError("");
    // アプリに戻ってきたら最新化
    const onVisible = () => {
      if (document.visibilityState === "visible") load(before, selected);
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [before, selected, load]);

  // 初回読み込みが一定時間で来ないなら、Loadingで固まらず「再試行」に切り替える（履歴と同じ挙動）
  useEffect(() => {
    if (ready) return;
    const t = setTimeout(() => setLoadStalled(true), 8000);
    return () => clearTimeout(t);
  }, [ready]);

  // C14: 年間ビューのデータ（1〜12月）。before=YYYY-12 & months=12 でその年が丸ごと返る
  const yearReq = useRef(0);
  useEffect(() => {
    if (view !== "year") return;
    const req = ++yearReq.current;
    cachedFetch<{ series?: Point[] }>(`/api/stats?months=12&before=${year}-12`, (d) => {
      if (yearReq.current === req) setYearSeries(d.series ?? []);
    }).catch(() => {});
  }, [view, year]);

  async function loadReview() {
    setReviewLoading(true);
    setReviewError("");
    try {
      const res = await fetch(`/api/review?month=${selected}`);
      const d = await res.json();
      if (!res.ok) throw new Error(d.error ?? "レポート作成に失敗しました。");
      setReview(d.review);
    } catch (e) {
      setReviewError(e instanceof Error ? e.message : "レポート作成に失敗しました。");
    } finally {
      setReviewLoading(false);
    }
  }

  const sel = series.find((p) => p.month === selected);
  const maxBd = Math.max(1, ...breakdown.map((b) => b.amount));

  if (!ready)
    return loadStalled ? (
      <div className="mt-16 text-center">
        <p className="text-sm font-bold text-vermilion">読み込めませんでした</p>
        <button
          onClick={() => {
            setLoadStalled(false);
            load(before, selected);
          }}
          className="mt-4 rounded-xl border border-ink px-6 py-2.5 text-sm font-bold active:translate-y-0.5"
        >
          再試行
        </button>
      </div>
    ) : (
      <Loading label="集計中・・・" />
    );

  // 比較1行：base=null は「比較データなし」。支出は増＝悪化(朱赤)、収入は増＝改善(緑)。
  const cmpLine = (label: string, current: number, base: number | null, higherIsGood: boolean) => {
    if (base === null) {
      return (
        <div className="flex items-baseline text-xs">
          <span className="text-ink-faint">{label}</span>
          <span className="leader" />
          <span className="text-ink-faint">比較データなし</span>
        </div>
      );
    }
    const diff = current - base;
    const good = diff === 0 ? null : higherIsGood ? diff > 0 : diff < 0;
    const color = good === null ? "text-ink-faint" : good ? "text-sage" : "text-vermilion";
    const sign = diff > 0 ? "+" : diff < 0 ? "−" : "±";
    const pct = base !== 0 ? Math.round((Math.abs(diff) / base) * 100) : null;
    return (
      <div className="flex items-baseline text-xs">
        <span className="text-ink-faint">
          {label} {fmtYen(base)}
        </span>
        <span className="leader" />
        <span className={`font-bold tabular-nums ${color}`}>
          {sign}
          {fmtYen(Math.abs(diff))}
          {pct !== null ? `・${sign}${pct}%` : ""}
        </span>
      </div>
    );
  };

  const segBtn = (v: "month" | "week" | "year" | "assets", label: string) => (
    <button
      onClick={() => setView(v)}
      aria-pressed={view === v}
      className={`flex-1 rounded-lg py-1.5 text-sm font-bold ${
        view === v ? "bg-ink text-card" : "text-ink-faint"
      }`}
    >
      {label}
    </button>
  );

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <h1 className="text-lg font-bold tracking-[0.04em]">
          {view === "week"
            ? "週の振り返り"
            : view === "year"
              ? "年間の収支"
              : view === "assets"
                ? "資産・純資産"
                : "収支グラフ"}
        </h1>
        {/* C9: 週/月/年/資産切替（週＝先週の振り返り・月＝従来のグラフと内訳・年＝C14年間ビュー・資産＝口座残高と純資産推移） */}
        <div className="flex w-60 shrink-0 rounded-md border border-rule bg-paper p-0.5">
          {segBtn("week", "週")}
          {segBtn("month", "月")}
          {segBtn("year", "年")}
          {segBtn("assets", "資産")}
        </div>
      </div>

      {view === "assets" && <Assets />}

      {view === "week" && <WeeklyReview />}

      {/* C14: 年間ビュー（月ごとの収支バー12ヶ月＋年合計。過去年へは無制限にさかのぼれる） */}
      {view === "year" && (
        <>
          <section className="rounded-2xl border border-rule bg-card p-4 shadow-sm">
            <div className="flex items-center justify-between px-1">
              <button
                onClick={() => setYear(year - 1)}
                aria-label="前の年"
                className="px-2 text-lg"
              >
                ◀
              </button>
              <p className="text-sm font-bold">{year}年</p>
              <button
                onClick={() => setYear(year + 1)}
                disabled={year >= Number(todayLocal().slice(0, 4))}
                aria-label="次の年"
                className="px-2 text-lg disabled:opacity-30"
              >
                ▶
              </button>
            </div>
            <div className="mt-2 flex justify-center gap-4 text-[11px]">
              <span className="flex items-center gap-2">
                <span className="h-2.5 w-2.5 rounded-sm" style={{ background: INCOME }} />
                収入
              </span>
              <span className="flex items-center gap-2">
                <span className="h-2.5 w-2.5 rounded-sm" style={{ background: EXPENSE }} />
                支出
              </span>
            </div>
            <div className="mt-1 h-52">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={yearSeries} margin={{ top: 8, right: 8, left: 0, bottom: 0 }} barGap={1}>
                  <CartesianGrid vertical={false} stroke="var(--rule)" strokeDasharray="2 4" />
                  <XAxis
                    dataKey="month"
                    tickFormatter={(m: string) => `${Number(m.slice(5))}`}
                    tick={{ fontSize: 10, fill: "var(--ink-faint)" }}
                    axisLine={{ stroke: "var(--rule)" }}
                    tickLine={false}
                  />
                  <YAxis
                    tickFormatter={(v: number) => (v >= 10000 ? `${v / 10000}万` : String(v))}
                    tick={{ fontSize: 10, fill: "var(--ink-faint)" }}
                    axisLine={false}
                    tickLine={false}
                    width={34}
                  />
                  <Tooltip
                    cursor={{ fill: "rgba(33,29,24,0.05)" }}
                    content={({ active, payload, label }) => {
                      if (!active || !payload?.length) return null;
                      const p = payload[0].payload as Point;
                      return (
                        <div className="rounded-lg border border-rule bg-card px-3 py-2 text-xs shadow-md">
                          <p className="font-bold">{fmtMonthJa(String(label))}</p>
                          <p style={{ color: INCOME }}>収入 {fmtYen(p.income)}</p>
                          <p style={{ color: EXPENSE }}>支出 {fmtYen(p.expense)}</p>
                          <p className="text-ink-faint">実績（収入−支出） {fmtYen(p.savings)}</p>
                        </div>
                      );
                    }}
                  />
                  <Bar dataKey="income" fill={INCOME} radius={[1, 1, 0, 0]} maxBarSize={10} />
                  <Bar dataKey="expense" fill={EXPENSE} radius={[1, 1, 0, 0]} maxBarSize={10} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </section>

          <section className="rounded-2xl border border-rule bg-card p-4 shadow-sm">
            <h2 className="text-sm font-bold tracking-[0.04em]">{year}年の合計</h2>
            {(() => {
              const inc = yearSeries.reduce((s, p) => s + p.income, 0);
              const exp = yearSeries.reduce((s, p) => s + p.expense, 0);
              const sav = inc - exp;
              return (
                <div className="mt-2 space-y-1 text-sm">
                  <div className="flex items-baseline">
                    <span className="text-ink-faint">収入</span>
                    <span className="leader" />
                    <span className="font-bold tabular-nums" style={{ color: INCOME }}>
                      +{fmtYen(inc)}
                    </span>
                  </div>
                  <div className="flex items-baseline">
                    <span className="text-ink-faint">支出</span>
                    <span className="leader" />
                    <span className="font-bold tabular-nums" style={{ color: EXPENSE }}>
                      −{fmtYen(exp)}
                    </span>
                  </div>
                  <div className="my-1.5 border-t border-rule" />
                  <div className="flex items-baseline">
                    <span className="text-ink-faint">年間の実績（収入−支出）</span>
                    <span className="leader" />
                    <span
                      className="text-xl font-black tabular-nums"
                      style={{ color: sav >= 0 ? INCOME : EXPENSE }}
                    >
                      {sav >= 0 ? "+" : ""}
                      {fmtYen(sav)}
                    </span>
                  </div>
                </div>
              );
            })()}
          </section>
        </>
      )}

      {view === "month" && (
        <>
      <section className="rounded-2xl border border-rule bg-card p-4 shadow-sm">
        <div className="flex items-center justify-between px-1">
          <button
            onClick={() => setBefore(shiftMonth(before, -WINDOW))}
            aria-label="前の6ヶ月"
            className="px-2 text-lg"
          >
            ◀
          </button>
          <p className="text-xs text-ink-faint">
            {fmtMonthJa(series[0]?.month ?? before)} 〜 {fmtMonthJa(series.at(-1)?.month ?? before)}
          </p>
          <button
            onClick={() => setBefore(shiftMonth(before, WINDOW))}
            disabled={before >= todayLocal().slice(0, 7)}
            aria-label="次の6ヶ月"
            className="px-2 text-lg disabled:opacity-30"
          >
            ▶
          </button>
        </div>
        {/* 凡例（2系列なので常設） */}
        <div className="mt-2 flex justify-center gap-4 text-[11px]">
          <span className="flex items-center gap-2">
            <span className="h-2.5 w-2.5 rounded-sm" style={{ background: INCOME }} />
            収入
          </span>
          <span className="flex items-center gap-2">
            <span className="h-2.5 w-2.5 rounded-sm" style={{ background: EXPENSE }} />
            支出
          </span>
        </div>
        <div className="mt-1 h-52">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart
              data={series}
              margin={{ top: 8, right: 8, left: 0, bottom: 0 }}
              barGap={2}
              onClick={(s) => {
                const m = (s as { activeLabel?: string })?.activeLabel;
                if (m) setSelected(m);
              }}
            >
              <CartesianGrid vertical={false} stroke="var(--rule)" strokeDasharray="2 4" />
              <XAxis
                dataKey="month"
                tickFormatter={(m: string) => `${Number(m.slice(5))}月`}
                tick={{ fontSize: 10, fill: "var(--ink-faint)" }}
                axisLine={{ stroke: "var(--rule)" }}
                tickLine={false}
              />
              <YAxis
                tickFormatter={(v: number) => (v >= 10000 ? `${v / 10000}万` : String(v))}
                tick={{ fontSize: 10, fill: "var(--ink-faint)" }}
                axisLine={false}
                tickLine={false}
                width={34}
              />
              <Tooltip
                cursor={{ fill: "rgba(33,29,24,0.05)" }}
                content={({ active, payload, label }) => {
                  if (!active || !payload?.length) return null;
                  const p = payload[0].payload as Point;
                  return (
                    <div className="rounded-lg border border-rule bg-card px-3 py-2 text-xs shadow-md">
                      <p className="font-bold">{fmtMonthJa(String(label))}</p>
                      <p style={{ color: INCOME }}>収入 {fmtYen(p.income)}</p>
                      <p style={{ color: EXPENSE }}>支出 {fmtYen(p.expense)}</p>
                      <p className="text-ink-faint">実績（収入−支出） {fmtYen(p.savings)}</p>
                    </div>
                  );
                }}
              />
              <Bar dataKey="income" fill={INCOME} radius={[1, 1, 0, 0]} maxBarSize={18} />
              <Bar dataKey="expense" fill={EXPENSE} radius={[1, 1, 0, 0]} maxBarSize={18} />
            </BarChart>
          </ResponsiveContainer>
        </div>
        <p className="text-center text-[11px] text-ink-faint">バーをタップすると下の内訳が切り替わります</p>
      </section>

      <section className="rounded-2xl border border-rule bg-card p-4 shadow-sm">
        <h2 className="text-sm font-bold tracking-[0.04em]">{fmtMonthJa(selected)} の内訳</h2>
        {sel && (
          <div className="mt-2 flex items-baseline text-sm">
            {/* A8: 予測（ホームの「月末までの予測」）と区別するため「実績」と明示 */}
            <span className="text-ink-faint">{Number(selected.slice(5))}月の実績（収入−支出）</span>
            <span className="leader" />
            <span
              className="text-xl font-black tabular-nums"
              style={{ color: sel.savings >= 0 ? INCOME : EXPENSE }}
            >
              {sel.savings >= 0 ? "+" : ""}
              {fmtYen(sel.savings)}
            </span>
          </div>
        )}
        {/* C12: 内訳を固定費（定期の家賃・サブスク等）と変動費に分けて印字する */}
        {(() => {
          const fixedRows = breakdown
            .map((b) => ({ ...b, amount: b.fixedAmount ?? 0 }))
            .filter((b) => b.amount > 0);
          const varRows = breakdown
            .map((b) => ({ ...b, amount: b.amount - (b.fixedAmount ?? 0) }))
            .filter((b) => b.amount > 0);
          const fixedTotal = fixedRows.reduce((s, b) => s + b.amount, 0);
          const varTotal = varRows.reduce((s, b) => s + b.amount, 0);
          const renderRows = (rows: typeof fixedRows) =>
            rows.map((b) => {
              const share = sel && sel.expense > 0 ? Math.round((b.amount / sel.expense) * 100) : 0;
              return (
                <li key={b.category}>
                  <div className="flex items-baseline text-sm">
                    {b.category !== "未分類" && (
                      <CategoryIcon icon={b.icon} className="mr-1 h-4 w-4 shrink-0 self-center text-ink-faint" />
                    )}
                    <span>{b.category}</span>
                    <span className="ml-1.5 text-[10px] text-ink-faint">{share}%</span>
                    <span className="leader" />
                    <span className="font-bold tabular-nums text-[15px]">{fmtYen(b.amount)}</span>
                  </div>
                  <div className="mt-1 h-1 rounded-full bg-paper">
                    <div
                      className="h-full rounded-full bg-ink/50"
                      style={{ width: `${(b.amount / maxBd) * 100}%` }}
                    />
                  </div>
                </li>
              );
            });
          if (breakdown.length === 0) {
            return (
              <p className="mt-3 border-t border-rule py-4 pt-3 text-center text-xs text-ink-faint">
                この月の支出はありません。
              </p>
            );
          }
          // 固定費が無い月は従来どおり1本のリスト（見出しを増やさない）
          if (fixedTotal === 0) {
            return <ul className="mt-3 space-y-2.5 border-t border-rule pt-3">{renderRows(varRows)}</ul>;
          }
          return (
            <div className="mt-3 border-t border-rule pt-3">
              <h3 className="flex items-baseline text-xs">
                <span className="text-ink-faint">固定費（定期・分割）</span>
                <span className="leader" />
                <span className="font-bold tabular-nums">{fmtYen(fixedTotal)}</span>
              </h3>
              <ul className="mt-2 space-y-2.5">{renderRows(fixedRows)}</ul>
              <h3 className="mt-3 flex items-baseline text-xs">
                <span className="text-ink-faint">変動費（日々の支出）</span>
                <span className="leader" />
                <span className="font-bold tabular-nums">{fmtYen(varTotal)}</span>
              </h3>
              <ul className="mt-2 space-y-2.5">{renderRows(varRows)}</ul>
            </div>
          );
        })()}
      </section>

      {/* 前月比・前年同月比（マネフォのマンスリーレポート的な定型比較。選択月に対して算出） */}
      {compare && (
        <section className="rounded-2xl border border-rule bg-card p-4 shadow-sm">
          <h2 className="text-sm font-bold tracking-[0.04em]">前月比・前年同月比</h2>
          {/* 支出（増＝悪化を朱赤で） */}
          <div className="mt-3">
            <div className="flex items-baseline text-sm">
              <span className="font-bold">支出</span>
              <span className="leader" />
              <span className="text-lg font-bold tabular-nums">{fmtYen(compare.expense.current)}</span>
            </div>
            <div className="mt-1 space-y-0.5 pl-1">
              {cmpLine("前月", compare.expense.current, compare.expense.prev, false)}
              {cmpLine("前年同月", compare.expense.current, compare.expense.prevYear, false)}
            </div>
          </div>
          {/* 収入（増＝改善を緑で） */}
          <div className="mt-3">
            <div className="flex items-baseline text-sm">
              <span className="font-bold">収入</span>
              <span className="leader" />
              <span className="text-lg font-bold tabular-nums">{fmtYen(compare.income.current)}</span>
            </div>
            <div className="mt-1 space-y-0.5 pl-1">
              {cmpLine("前月", compare.income.current, compare.income.prev, true)}
              {cmpLine("前年同月", compare.income.current, compare.income.prevYear, true)}
            </div>
          </div>
          {/* カテゴリの増減（今月 vs 前月・上位3件ずつ） */}
          {(compare.increased.length > 0 || compare.decreased.length > 0) && (
            <div className="mt-3 border-t border-rule pt-3">
              <p className="text-xs text-ink-faint">前月比 カテゴリの増減</p>
              <ul className="mt-2 space-y-1.5">
                {compare.increased.map((c) => (
                  <li key={`inc-${c.category}`} className="flex items-baseline text-sm">
                    {c.category !== "未分類" && (
                      <CategoryIcon icon={c.icon} className="mr-1 h-4 w-4 shrink-0 self-center text-ink-faint" />
                    )}
                    <span>{c.category}</span>
                    <span className="leader" />
                    <span className="font-bold tabular-nums text-vermilion">▲ +{fmtYen(c.delta)}</span>
                  </li>
                ))}
                {compare.decreased.map((c) => (
                  <li key={`dec-${c.category}`} className="flex items-baseline text-sm">
                    {c.category !== "未分類" && (
                      <CategoryIcon icon={c.icon} className="mr-1 h-4 w-4 shrink-0 self-center text-ink-faint" />
                    )}
                    <span>{c.category}</span>
                    <span className="leader" />
                    <span className="font-bold tabular-nums text-sage">▼ −{fmtYen(-c.delta)}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </section>
      )}

      {/* 横断タグ別の支出（カテゴリとは別軸。旅行・推し活など複数カテゴリをまたぐ集計） */}
      {(() => {
        const rows = tagStats.filter((t) => t.amount > 0);
        const maxTag = Math.max(1, ...rows.map((t) => t.amount));
        return (
          <section className="rounded-2xl border border-rule bg-card p-4 shadow-sm">
            <h2 className="text-sm font-bold tracking-[0.04em]">タグ別の支出（{fmtMonthJa(selected)}）</h2>
            {rows.length === 0 ? (
              <p className="mt-3 border-t border-rule py-4 pt-3 text-center text-xs text-ink-faint">
                {tagStats.length === 0
                  ? "タグはまだありません。記録の編集画面からタグを付けられます。"
                  : "この月はタグ付きの支出がありません。"}
              </p>
            ) : (
              <ul className="mt-3 space-y-2.5 border-t border-rule pt-3">
                {rows.map((t) => (
                  <li key={t.id}>
                    <div className="flex items-baseline text-sm">
                      <span className="text-sage">#{t.name}</span>
                      <span className="ml-1.5 text-[10px] text-ink-faint">{t.count}件</span>
                      <span className="leader" />
                      <span className="font-bold tabular-nums text-[15px]">{fmtYen(t.amount)}</span>
                    </div>
                    <div className="mt-1 h-1 rounded-full bg-paper">
                      <div
                        className="h-full rounded-full bg-sage/60"
                        style={{ width: `${(t.amount / maxTag) * 100}%` }}
                      />
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </section>
        );
      })()}

      {/* 袋分けポケット：カテゴリ別の今月予算と残り */}
      <section className="rounded-2xl border border-rule bg-card p-4 shadow-sm">
        <h2 className="text-sm font-bold tracking-[0.04em]">袋分けポケット（今月）</h2>
        <p className="mt-0.5 text-[11px] text-ink-faint">
          カテゴリごとに月予算を決めて封筒に入れるイメージ。残りが見えると使いすぎが止まります。
        </p>
        {pockets.length === 0 && (
          <p className="mt-3 border-t border-rule py-4 pt-3 text-center text-xs text-ink-faint">
            カテゴリを作ると、ここで袋分けの月予算を決められます。
          </p>
        )}
        <ul className="mt-3 space-y-2.5">
          {pockets.map((p) => {
            const pct = p.budget > 0 ? Math.min(150, Math.round((p.spent / p.budget) * 100)) : 0;
            const over = p.budget > 0 && p.spent > p.budget;
            const near = p.budget > 0 && !over && p.spent >= p.budget * 0.8;
            const barColor = over ? "bg-vermilion" : near ? "bg-caution" : "bg-sage";
            return (
              <li key={p.id}>
                <div className="flex items-baseline text-sm">
                  <CategoryIcon icon={p.icon} className="mr-1 h-4 w-4 shrink-0 self-center text-ink-faint" />
                  <span>{p.name}</span>
                  <span className="leader" />
                  {p.budget > 0 ? (
                    <span className={`font-bold tabular-nums ${over ? "text-vermilion" : ""}`}>
                      {over ? `${fmtYen(p.spent - p.budget)}オーバー` : `残り${fmtYen(p.budget - p.spent)}`}
                    </span>
                  ) : (
                    <span className="text-[11px] text-ink-faint">予算なし</span>
                  )}
                  <button
                    onClick={() => {
                      setEditPocket(editPocket === p.id ? null : p.id);
                      setPocketAmount(p.budget ? String(p.budget) : "");
                    }}
                    className="ml-2 shrink-0 text-xs text-ink-faint underline underline-offset-2"
                  >
                    {p.budget > 0 ? "変更" : "設定"}
                  </button>
                </div>
                {p.budget > 0 && (
                  <div className="mt-1 h-1.5 rounded-full bg-paper">
                    <div
                      className={`h-full rounded-full ${barColor}`}
                      style={{ width: `${Math.min(100, pct)}%` }}
                    />
                  </div>
                )}
                {editPocket === p.id && (
                  <div className="mt-1.5 flex gap-2">
                    <input
                      type="number"
                      inputMode="numeric"
                      value={pocketAmount}
                      onChange={(e) => setPocketAmount(e.target.value)}
                      placeholder="月予算（0で解除）"
                      className="min-w-0 flex-1 rounded-md border border-rule bg-paper px-3 py-1.5 text-sm tabular-nums outline-none focus:border-ink"
                    />
                    <button
                      onClick={() => savePocket(p.id)}
                      className="shrink-0 rounded-lg border border-ink px-3 text-sm font-bold"
                    >
                      保存
                    </button>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      </section>

      {/* 月次振り返りレポート（終わった月のみ・AIが分析） */}
      {selected < todayLocal().slice(0, 7) && (
        <section className="rounded-2xl border border-rule bg-card p-4 shadow-sm">
          {!review && (
            <>
              <button
                onClick={loadReview}
                disabled={reviewLoading}
                className={`w-full rounded-xl py-3 text-base font-bold ${
                  reviewLoading
                    ? "border border-rule bg-paper text-ink-faint"
                    : "bg-vermilion text-card shadow-[0_2px_0_var(--vermilion-deep)] active:translate-y-0.5"
                }`}
              >
                {reviewLoading ? "分析中・・・" : `${fmtMonthJa(selected)}の振り返りレポート`}
              </button>
              {reviewLoading && (
                <p className="mt-2 text-center text-[11px] text-ink-faint">
                  AIが使いすぎポイントと貯金アドバイスをまとめています（数十秒）
                </p>
              )}
              {reviewError && <p className="mt-2 text-sm text-vermilion">{reviewError}</p>}
            </>
          )}
          {review && (
            <div>
              <p className="text-center text-xs text-ink-faint">
                {fmtMonthJa(selected)} の振り返り
              </p>
              <p className="mt-2 text-center text-lg font-bold">{review.headline}</p>
              {review.overspend.length > 0 && (
                <div className="mt-3">
                  <h3 className="text-xs font-bold text-vermilion">▲ 使いすぎポイント</h3>
                  <ul className="mt-1 space-y-1.5">
                    {review.overspend.map((o, i) => (
                      <li key={i} className="text-sm">
                        <span className="flex items-baseline">
                          <span>{o.category}</span>
                          <span className="leader" />
                          <span className="font-bold tabular-nums text-vermilion">{fmtYen(o.amount)}</span>
                          {o.prevAmount > 0 && (
                            <span className="ml-1 text-[10px] text-ink-faint">
                              (前月{fmtYen(o.prevAmount)})
                            </span>
                          )}
                        </span>
                        <span className="block text-[11px] text-ink-faint">{o.comment}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {review.good.length > 0 && (
                <div className="mt-3">
                  <h3 className="text-xs font-bold" style={{ color: INCOME }}>
                    ○ よかったところ
                  </h3>
                  <ul className="mt-1 space-y-0.5">
                    {review.good.map((g, i) => (
                      <li key={i} className="text-sm">
                        {g}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {review.advice.length > 0 && (
                <div className="mt-3 border-t border-rule pt-3">
                  <h3 className="text-xs text-ink-faint">◇ 来月のアドバイス</h3>
                  <ul className="mt-1 space-y-2">
                    {review.advice.map((a, i) => (
                      <li key={i} className="text-sm">
                        <span className="flex items-baseline">
                          <span className="font-semibold">{a.title}</span>
                          <span className="leader" />
                          {a.saveEstimate > 0 && (
                            <span className="font-bold tabular-nums" style={{ color: INCOME }}>
                              月{fmtYen(a.saveEstimate)}浮く
                            </span>
                          )}
                        </span>
                        <span className="block text-[11px] text-ink-faint">{a.detail}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}
        </section>
      )}
        </>
      )}
    </div>
  );
}
