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
import { CategoryIcon } from "@/components/Icons";
import Loading from "@/components/Loading";
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
}
interface Pocket {
  id: string;
  name: string;
  icon: string;
  budget: number;
  spent: number;
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
  const [before, setBefore] = useState(todayLocal().slice(0, 7));
  const [selected, setSelected] = useState(todayLocal().slice(0, 7));
  const [series, setSeries] = useState<Point[]>([]);
  const [breakdown, setBreakdown] = useState<Breakdown[]>([]);
  const [review, setReview] = useState<Review | null>(null);
  const [reviewLoading, setReviewLoading] = useState(false);
  const [reviewError, setReviewError] = useState("");
  const [pockets, setPockets] = useState<Pocket[]>([]);
  const [editPocket, setEditPocket] = useState<string | null>(null);
  const [pocketAmount, setPocketAmount] = useState("");

  const [ready, setReady] = useState(false); // 初回データ（キャッシュ含む）が来るまでスケルトン表示

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
      body: JSON.stringify({ categoryId, amount: Number(pocketAmount) || 0 }),
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
    await cachedFetch<{ series?: Point[]; breakdown?: Breakdown[] }>(
      `/api/stats?months=${WINDOW}&before=${b}&month=${sel}`,
      (d) => {
        if (reqRef.current !== req) return;
        setSeries(d.series ?? []);
        setBreakdown(d.breakdown ?? []);
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

  if (!ready) return <Loading label="集計中・・・" />;

  return (
    <div className="space-y-4">
      <h1 className="dot text-lg">収支グラフ</h1>

      <section className="zig zig-t zig-b px-3 py-4 shadow-sm">
        <div className="flex items-center justify-between px-1">
          <button onClick={() => setBefore(shiftMonth(before, -WINDOW))} className="dot px-2 text-lg">
            ◀
          </button>
          <p className="dot text-xs text-ink-faint">
            {fmtMonthJa(series[0]?.month ?? before)} 〜 {fmtMonthJa(series.at(-1)?.month ?? before)}
          </p>
          <button
            onClick={() => setBefore(shiftMonth(before, WINDOW))}
            disabled={before >= todayLocal().slice(0, 7)}
            className="dot px-2 text-lg disabled:opacity-30"
          >
            ▶
          </button>
        </div>
        {/* 凡例（2系列なので常設） */}
        <div className="mt-2 flex justify-center gap-4 text-[11px]">
          <span className="flex items-center gap-1.5">
            <span className="h-2.5 w-2.5 rounded-[3px]" style={{ background: INCOME }} />
            収入
          </span>
          <span className="flex items-center gap-1.5">
            <span className="h-2.5 w-2.5 rounded-[3px]" style={{ background: EXPENSE }} />
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
                    <div className="zig zig-b rounded-t-sm px-3 py-2 text-xs shadow-md">
                      <p className="dot">{fmtMonthJa(String(label))}</p>
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

      <section className="zig zig-t zig-b px-5 py-4 shadow-sm">
        <h2 className="dot text-sm tracking-[0.1em]">{fmtMonthJa(selected)} の内訳</h2>
        {sel && (
          <div className="mt-2 flex items-baseline text-sm">
            {/* A8: 予測（ホームの「月末までの予測」）と区別するため「実績」と明示 */}
            <span className="text-ink-faint">{Number(selected.slice(5))}月の実績（収入−支出）</span>
            <span className="leader" />
            <span
              className="dot text-xl tabular-nums"
              style={{ color: sel.savings >= 0 ? INCOME : EXPENSE }}
            >
              {sel.savings >= 0 ? "+" : ""}
              {fmtYen(sel.savings)}
            </span>
          </div>
        )}
        <ul className="cutline mt-3 space-y-2.5 pt-3">
          {breakdown.length === 0 && (
            <li className="py-4 text-center text-xs text-ink-faint">この月の支出はありません。</li>
          )}
          {breakdown.map((b) => {
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
                  <span className="dot text-[15px] tabular-nums">{fmtYen(b.amount)}</span>
                </div>
                <div className="mt-1 h-1 rounded-full bg-paper">
                  <div
                    className="h-full rounded-full bg-ink/50"
                    style={{ width: `${(b.amount / maxBd) * 100}%` }}
                  />
                </div>
              </li>
            );
          })}
        </ul>
        <div className="barcode mt-5" />
      </section>

      {/* 袋分けポケット：カテゴリ別の今月予算と残り */}
      <section className="zig zig-t zig-b px-5 py-4 shadow-sm">
        <h2 className="dot text-sm tracking-[0.1em]">袋分けポケット（今月）</h2>
        <p className="mt-0.5 text-[11px] text-ink-faint">
          カテゴリごとに月予算を決めて封筒に入れるイメージ。残りが見えると使いすぎが止まります。
        </p>
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
                    <span className={`dot tabular-nums ${over ? "text-vermilion" : ""}`}>
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
                      className="dot shrink-0 rounded-md border border-ink px-3 text-sm"
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
        <section className="zig zig-t zig-b px-5 py-4 shadow-sm">
          {!review && (
            <>
              <button
                onClick={loadReview}
                disabled={reviewLoading}
                className={`dot w-full rounded-md py-3 text-base ${
                  reviewLoading
                    ? "printing border-2 border-ink bg-paper"
                    : "bg-vermilion text-card shadow-[0_2px_0_var(--vermilion-deep)] active:translate-y-0.5"
                }`}
              >
                {reviewLoading ? "＊＊＊ 分析中・・・ ＊＊＊" : `${fmtMonthJa(selected)}の振り返りレポート`}
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
              <p className="dot text-center text-xs text-ink-faint">
                ＊ {fmtMonthJa(selected)} の振り返り ＊
              </p>
              <p className="dot mt-2 text-center text-lg">{review.headline}</p>
              {review.overspend.length > 0 && (
                <div className="mt-3">
                  <h3 className="dot text-xs text-vermilion">▲ 使いすぎポイント</h3>
                  <ul className="mt-1 space-y-1.5">
                    {review.overspend.map((o, i) => (
                      <li key={i} className="text-sm">
                        <span className="flex items-baseline">
                          <span>{o.category}</span>
                          <span className="leader" />
                          <span className="dot tabular-nums text-vermilion">{fmtYen(o.amount)}</span>
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
                  <h3 className="dot text-xs" style={{ color: INCOME }}>
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
                <div className="mt-3 cutline pt-3">
                  <h3 className="dot text-xs text-ink-faint">◇ 来月のアドバイス</h3>
                  <ul className="mt-1 space-y-2">
                    {review.advice.map((a, i) => (
                      <li key={i} className="text-sm">
                        <span className="flex items-baseline">
                          <span className="dot">{a.title}</span>
                          <span className="leader" />
                          {a.saveEstimate > 0 && (
                            <span className="dot tabular-nums" style={{ color: INCOME }}>
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
              <div className="barcode mt-4" />
            </div>
          )}
        </section>
      )}
    </div>
  );
}
