"use client";

// お金カレンダー：日付ごとの−支出/+収入と給料日を月表示。タップで詳細。
// 上部に「今日使えるお金」の計算内訳（何がいくらで、どう割られているか）を表示。
// 日別シートからその日にシフトを直接追加できる（複数日まとめて・音声はシフト画面のまま）。
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { ExpenseEditSheet } from "@/components/EditSheets";
import { CategoryIcon } from "@/components/Icons";
import Loading from "@/components/Loading";
import { Toast, useToast } from "@/components/Toast";
import { cachedFetch } from "@/lib/cachedFetch";
import { fmtDateJa, fmtMonthJa, fmtYen, todayLocal } from "@/lib/format";

interface CalExpense {
  id: string;
  date: string;
  amount: number;
  memo: string;
  source: string;
  category_id?: string | null;
  receipt_id?: string | null;
  category: string | null;
  icon: string | null;
}
interface Category {
  id: string;
  name: string;
  icon: string;
}
interface CalIncome {
  id: string;
  date: string;
  amount: number;
  type: string;
  memo: string;
}
interface Payday {
  date: string;
  jobId: string;
  jobName: string;
  color: string;
  amount: number;
  periodStart: string;
  periodEnd: string;
}
interface PlannedRecurring {
  recurringId: string;
  kind: "expense" | "income";
  date: string;
  name: string;
  amount: number;
  category: string | null;
  icon: string | null;
}
interface PlannedPayday {
  date: string;
  jobId: string;
  jobName: string;
  color: string;
  amount: number; // 0 = シフト未入力で金額未定
  periodStart: string;
  periodEnd: string;
  confirmed: boolean;
}
interface MonthPlan {
  expenses: PlannedRecurring[];
  incomes: PlannedRecurring[];
  paydays: PlannedPayday[];
  expenseTotal: number;
  incomeTotal: number;
}
interface CalData {
  month: string;
  expenses: CalExpense[];
  incomes: CalIncome[];
  paydays: Payday[];
  plan?: MonthPlan; // 未来月のみ中身が入る（旧キャッシュには無いので optional）
  breakdown: {
    planned?: boolean; // true=未来月（予定込みの1系統で表示。実績行は出さない）
    // B9: 集計期間（締め日基準。開始日1なら実カレンダー月と同じ。旧キャッシュには無いので optional）
    range?: { start: string; end: string };
    shiftIncome: number;
    otherIncome: number;
    incomeTotal: number; // 未来月は予定収入込み
    savingsGoal: number;
    expenseTotal: number; // 未来月は予定支出込み
    fixedTotal?: number | null; // 今月の固定費（先取り済み。今月のみ）
    remain: number;
    daysRemaining: number | null;
    // 日次予算＋繰り越し方式の内訳（今月のみ。旧キャッシュには無いので optional）
    todayBudget?: number | null;
    spentToday?: number | null;
    spentBeforeToday?: number | null;
    allowance: number | null; // 今日あと使える額（今日の予算 − 今日の変動支出）
  };
}

function shiftMonth(month: string, delta: number): string {
  const [y, m] = month.split("-").map(Number);
  const d = new Date(y, m - 1 + delta, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

export default function CalendarPage() {
  const [month, setMonth] = useState(todayLocal().slice(0, 7));
  const [data, setData] = useState<CalData | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [showCalc, setShowCalc] = useState(false);
  // C10: 日付シートの支出行タップ→履歴と同じ編集シートを開く
  const [categories, setCategories] = useState<Category[]>([]);
  const [editing, setEditing] = useState<CalExpense | null>(null);
  const { toast, show, hide } = useToast();
  // カレンダーからのシフト直接入力（複数日まとめて・音声はシフト画面のまま）
  const [jobs, setJobs] = useState<{ id: string; name: string; color: string }[]>([]);
  const [showShiftAdd, setShowShiftAdd] = useState(false);
  const [shiftJob, setShiftJob] = useState("");
  const [shiftStart, setShiftStart] = useState("17:00");
  const [shiftEnd, setShiftEnd] = useState("22:00");
  const [shiftBreak, setShiftBreak] = useState("0");
  const [shiftBusy, setShiftBusy] = useState(false);

  async function addShift() {
    if (!shiftJob || !selected || shiftBusy) return;
    const toMin = (t: string) => {
      const [h, m] = t.split(":").map(Number);
      return (h || 0) * 60 + (m || 0);
    };
    setShiftBusy(true);
    try {
      const r = await fetch("/api/shifts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jobId: shiftJob,
          date: selected,
          startMin: toMin(shiftStart),
          endMin: toMin(shiftEnd),
          breakMin: Number(shiftBreak) || 0,
          source: "calendar",
        }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || "追加に失敗しました。");
      setShowShiftAdd(false);
      load(month);
      show("シフトを追加しました（給料は給料日に反映）");
    } catch (e) {
      show(e instanceof Error ? e.message : "追加に失敗しました。");
    } finally {
      setShiftBusy(false);
    }
  }

  // 月切替の連打時に古い月のレスポンスで上書きされないよう、最新リクエストだけ反映する
  const reqRef = useRef(0);
  const load = useCallback(async (m: string) => {
    const req = ++reqRef.current;
    try {
      // キャッシュファースト：見たことのある月は即表示→裏で最新に差し替え
      await cachedFetch<CalData>(`/api/calendar?month=${m}`, (d) => {
        if (reqRef.current === req) setData(d);
      });
    } catch {
      /* 初回読み込み失敗時はスケルトンのまま（復帰時の visibilitychange で再試行される） */
    }
  }, []);

  useEffect(() => {
    cachedFetch<{ categories?: Category[] }>("/api/categories", (d) =>
      setCategories(d.categories ?? []),
    ).catch(() => {});
    // シフト直接入力のためのバイト先一覧
    cachedFetch<{ jobs?: { id: string; name: string; color: string }[] }>("/api/jobs", (d) => {
      setJobs(d.jobs ?? []);
      if (d.jobs && d.jobs[0]) setShiftJob((p) => p || d.jobs![0].id);
    }).catch(() => {});
  }, []);

  useEffect(() => {
    load(month);
    const onVisible = () => {
      if (document.visibilityState === "visible") load(month);
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [month, load]);

  if (!data) return <Loading />;

  const [y, m] = month.split("-").map(Number);
  const first = new Date(y, m - 1, 1);
  const days = new Date(y, m, 0).getDate();
  const cells: (string | null)[] = [
    ...Array<null>(first.getDay()).fill(null),
    ...Array.from({ length: days }, (_, i) => `${month}-${String(i + 1).padStart(2, "0")}`),
  ];
  const expByDate = new Map<string, CalExpense[]>();
  for (const e of data.expenses) {
    const a = expByDate.get(e.date) ?? [];
    a.push(e);
    expByDate.set(e.date, a);
  }
  const incByDate = new Map<string, CalIncome[]>();
  for (const i of data.incomes) {
    const a = incByDate.get(i.date) ?? [];
    a.push(i);
    incByDate.set(i.date, a);
  }
  const pdByDate = new Map<string, Payday[]>();
  for (const p of data.paydays) {
    const a = pdByDate.get(p.date) ?? [];
    a.push(p);
    pdByDate.set(p.date, a);
  }
  // 未来月の「予定」（定期・分割・給料日）。実記録と別マップにして薄い表示で区別する
  const plan = data.plan;
  const planExpByDate = new Map<string, PlannedRecurring[]>();
  const planIncByDate = new Map<string, PlannedRecurring[]>();
  const planPdByDate = new Map<string, PlannedPayday[]>();
  for (const e of plan?.expenses ?? []) {
    const a = planExpByDate.get(e.date) ?? [];
    a.push(e);
    planExpByDate.set(e.date, a);
  }
  for (const i of plan?.incomes ?? []) {
    const a = planIncByDate.get(i.date) ?? [];
    a.push(i);
    planIncByDate.set(i.date, a);
  }
  for (const p of plan?.paydays ?? []) {
    const a = planPdByDate.get(p.date) ?? [];
    a.push(p);
    planPdByDate.set(p.date, a);
  }
  const hasPlan = !!plan && (plan.expenses.length > 0 || plan.incomes.length > 0 || plan.paydays.length > 0);
  const b = data.breakdown;
  const selExp = selected ? (expByDate.get(selected) ?? []) : [];
  const selInc = selected ? (incByDate.get(selected) ?? []) : [];
  const selPd = selected ? (pdByDate.get(selected) ?? []) : [];
  const selPlanExp = selected ? (planExpByDate.get(selected) ?? []) : [];
  const selPlanInc = selected ? (planIncByDate.get(selected) ?? []) : [];
  const selPlanPd = selected ? (planPdByDate.get(selected) ?? []) : [];

  return (
    <div className="space-y-4">
      <header className="flex items-center justify-between">
        <button onClick={() => setMonth(shiftMonth(month, -1))} className="dot px-3 py-1 text-lg">
          ◀
        </button>
        <h1 className="dot text-lg">{fmtMonthJa(month)}のお金</h1>
        <button onClick={() => setMonth(shiftMonth(month, 1))} className="dot px-3 py-1 text-lg">
          ▶
        </button>
      </header>

      {/* カレンダー：箱を並べず、印字だけで組む（データのない日は静かに、使った日は濃く） */}
      <div className="zig zig-t zig-b px-2 py-4 shadow-sm">
        <div className="grid grid-cols-7 text-center text-[11px]">
          {["日", "月", "火", "水", "木", "金", "土"].map((d, i) => (
            <span
              key={d}
              className={`py-1 ${i === 0 ? "text-vermilion" : "text-ink-faint"}`}
            >
              {d}
            </span>
          ))}
        </div>
        <div className="grid grid-cols-7">
          {cells.map((date, i) => {
            if (!date) return <span key={`x${i}`} />;
            const day = Number(date.slice(8));
            const exp = expByDate.get(date);
            const inc = incByDate.get(date);
            const pd = pdByDate.get(date);
            const spent = exp?.reduce((s, e) => s + e.amount, 0) ?? 0;
            const got =
              (inc?.reduce((s, x) => s + x.amount, 0) ?? 0) +
              (pd?.reduce((s, x) => s + x.amount, 0) ?? 0);
            // 予定（未来月のみ入る）。薄い表示で実記録と区別する
            const ppd = planPdByDate.get(date);
            const planSpent = planExpByDate.get(date)?.reduce((s, e) => s + e.amount, 0) ?? 0;
            const planGot =
              (planIncByDate.get(date)?.reduce((s, x) => s + x.amount, 0) ?? 0) +
              (ppd?.reduce((s, x) => s + x.amount, 0) ?? 0);
            const today = date === todayLocal();
            const hasData = spent > 0 || got > 0;
            return (
              <button
                key={date}
                onClick={() => setSelected(date)}
                className="flex h-14 flex-col items-center gap-0.5 pt-1"
              >
                <span
                  className={`dot flex h-6 w-6 items-center justify-center rounded-full text-[13px] leading-none ${
                    today
                      ? "bg-vermilion text-card"
                      : hasData
                        ? "text-ink"
                        : "text-ink-faint/70"
                  }`}
                >
                  {day}
                </span>
                {(pd || ppd) && (
                  <span className={`dot text-[9px] leading-none ${pd ? "text-sage" : "text-sage/55"}`}>
                    給料日
                  </span>
                )}
                {got > 0 && (
                  <span className="dot text-[10px] leading-none tabular-nums text-sage">
                    +{got.toLocaleString()}
                  </span>
                )}
                {spent > 0 && (
                  <span className="dot text-[10px] leading-none tabular-nums text-ink">
                    -{spent.toLocaleString()}
                  </span>
                )}
                {planGot > 0 && (
                  <span className="dot text-[10px] leading-none tabular-nums text-sage/55">
                    +{planGot.toLocaleString()}
                  </span>
                )}
                {planSpent > 0 && (
                  <span className="dot text-[10px] leading-none tabular-nums text-ink-faint/80">
                    -{planSpent.toLocaleString()}
                  </span>
                )}
              </button>
            );
          })}
        </div>
        <p className="cutline mt-2 pt-2 text-center text-[11px] text-ink-faint">
          {hasPlan ? "薄い数字は予定（まだ記帳前）・日付をタップで詳細" : "日付をタップで詳細"}
        </p>
      </div>

      {/* 今日使えるお金の計算内訳 */}
      <section className="rounded-sm border border-rule bg-card px-5 py-3 shadow-sm">
        <button onClick={() => setShowCalc(!showCalc)} className="flex w-full items-baseline">
          <h2 className="dot text-xs text-ink-faint">
            {b.allowance !== null
              ? "＊ 今日あと使えるお金の計算 ＊"
              : b.planned
                ? "＊ この月の予定収支 ＊"
                : "＊ この月の収支 ＊"}
          </h2>
          <span className="leader" />
          {b.allowance !== null && (
            <span className={`dot text-lg tabular-nums ${b.allowance < 0 ? "text-vermilion" : ""}`}>
              {fmtYen(b.allowance)}
            </span>
          )}
          <span className="ml-1 text-xs text-ink-faint">{showCalc ? "▲" : "▼"}</span>
        </button>
        {/* B9: 締め日を変えている場合だけ、この収支の集計期間を明示する */}
        {b.range && !b.range.start.endsWith("-01") && (
          <p className="mt-0.5 text-[10px] text-ink-faint">
            {fmtDateJa(b.range.start)}〜{fmtDateJa(b.range.end)}の集計
          </p>
        )}
        {b.planned && (b.expenseTotal > 0 || b.incomeTotal > 0) && (
          <div className="mt-1.5 flex items-baseline text-xs">
            <span className="text-ink-faint">予定合計</span>
            <span className="leader" />
            <span className="dot shrink-0 tabular-nums text-ink-faint">
              支出 −{fmtYen(b.expenseTotal)} ・ 収入 +{fmtYen(b.incomeTotal)}
            </span>
          </div>
        )}
        {showCalc && b.planned && (
          /* A1: 未来月は「予定込みの1系統」。実績行（¥0の行）は出さない */
          <div className="mt-2 space-y-1 text-sm">
            <div className="flex items-baseline">
              <span className="text-ink-faint">予定収入（定期＋入力済みシフトの給料）</span>
              <span className="leader" />
              <span className="dot shrink-0 tabular-nums text-sage">+{fmtYen(b.incomeTotal)}</span>
            </div>
            {b.savingsGoal > 0 && (
              <div className="flex items-baseline">
                <span className="text-ink-faint">貯金目標（先取り）</span>
                <span className="leader" />
                <span className="dot tabular-nums">−{fmtYen(b.savingsGoal)}</span>
              </div>
            )}
            <div className="flex items-baseline">
              <span className="text-ink-faint">予定支出（定期・分割）</span>
              <span className="leader" />
              <span className="dot tabular-nums text-vermilion">−{fmtYen(b.expenseTotal)}</span>
            </div>
            <div className="cutline my-1.5" />
            <div className="flex items-baseline">
              <span className="text-ink-faint">残り</span>
              <span className="leader" />
              <span className={`dot tabular-nums ${b.remain < 0 ? "text-vermilion" : ""}`}>
                {fmtYen(b.remain)}
              </span>
            </div>
            <p className="pt-1 text-[10px] text-ink-faint">
              シフト未入力の給料日は金額未定のため含みません
            </p>
          </div>
        )}
        {showCalc && !b.planned && (
          <div className="mt-2 space-y-1 text-sm">
            <div className="flex items-baseline">
              <span className="text-ink-faint">バイト給料（今月支払い分）</span>
              <span className="leader" />
              <span className="dot tabular-nums text-sage">+{fmtYen(b.shiftIncome)}</span>
            </div>
            <div className="flex items-baseline">
              <span className="text-ink-faint">その他の収入</span>
              <span className="leader" />
              <span className="dot tabular-nums text-sage">+{fmtYen(b.otherIncome)}</span>
            </div>
            {b.savingsGoal > 0 && (
              <div className="flex items-baseline">
                <span className="text-ink-faint">貯金目標（先取り）</span>
                <span className="leader" />
                <span className="dot tabular-nums">−{fmtYen(b.savingsGoal)}</span>
              </div>
            )}
            {b.allowance !== null && (b.fixedTotal ?? 0) > 0 && (
              <div className="flex items-baseline">
                <span className="text-ink-faint">今月の固定費（先取り済み）</span>
                <span className="leader" />
                <span className="dot tabular-nums text-vermilion">−{fmtYen(b.fixedTotal ?? 0)}</span>
              </div>
            )}
            <div className="flex items-baseline">
              <span className="text-ink-faint">
                {b.allowance !== null ? "昨日までの変動支出" : "この月の支出"}
              </span>
              <span className="leader" />
              <span className="dot tabular-nums text-vermilion">
                −{fmtYen(b.allowance !== null ? (b.spentBeforeToday ?? b.expenseTotal) : b.expenseTotal)}
              </span>
            </div>
            <div className="cutline my-1.5" />
            <div className="flex items-baseline">
              <span className="text-ink-faint">残り</span>
              <span className="leader" />
              <span className={`dot tabular-nums ${b.remain < 0 ? "text-vermilion" : ""}`}>
                {fmtYen(b.remain)}
              </span>
            </div>
            {b.allowance !== null && b.daysRemaining !== null && (
              <>
                <div className="flex items-baseline">
                  <span className="text-ink-faint">÷ 残り{b.daysRemaining}日</span>
                  <span className="leader" />
                  <span className="dot tabular-nums">
                    = 今日の予算 {fmtYen(b.todayBudget ?? b.allowance)}
                  </span>
                </div>
                <div className="flex items-baseline">
                  <span className="text-ink-faint">− 今日使った分</span>
                  <span className="leader" />
                  <span className="dot tabular-nums text-vermilion">−{fmtYen(b.spentToday ?? 0)}</span>
                </div>
                <div className="flex items-baseline">
                  <span className="text-ink-faint">= 今日あと使える</span>
                  <span className="leader" />
                  <span className={`dot tabular-nums ${b.allowance < 0 ? "text-vermilion" : ""}`}>
                    {fmtYen(b.allowance)}
                  </span>
                </div>
              </>
            )}
          </div>
        )}
      </section>


      {/* 日別詳細シート */}
      {selected && (
        <div className="fixed inset-0 z-50 flex items-end bg-ink/40" onClick={() => setSelected(null)}>
          <div
            className="zig zig-t mx-auto max-h-[75dvh] w-full max-w-md overflow-y-auto px-5 pb-8 pt-5"
            onClick={(e) => e.stopPropagation()}
          >
            <p className="dot text-center text-xs text-ink-faint">＊ {fmtDateJa(selected)} ＊</p>
            {selPd.map((p) => (
              <div key={p.jobId} className="mt-3 rounded-md border px-3 py-2" style={{ borderColor: p.color }}>
                <div className="flex items-baseline text-sm">
                  <span
                    className="mr-1.5 inline-block h-2.5 w-2.5 self-center rounded-full"
                    style={{ backgroundColor: p.color }}
                  />
                  <span>{p.jobName} 給料日</span>
                  <span className="leader" />
                  <span className="dot tabular-nums text-sage">+{fmtYen(p.amount)}</span>
                </div>
                <p className="mt-0.5 text-[11px] text-ink-faint">
                  {p.periodStart === p.periodEnd
                    ? "当日の勤務分（当日払い）"
                    : `${fmtDateJa(p.periodStart)}〜${fmtDateJa(p.periodEnd)}の勤務分`}
                </p>
              </div>
            ))}
            {selInc.length > 0 && (
              <ul className="mt-3">
                {selInc.map((x) => (
                  <li key={x.id} className="flex items-baseline py-1 text-sm">
                    <span className="text-sage">＋</span>
                    <span className="ml-1 truncate">{x.memo || "収入"}</span>
                    <span className="leader" />
                    <span className="dot tabular-nums text-sage">+{fmtYen(x.amount)}</span>
                  </li>
                ))}
              </ul>
            )}
            {selExp.length > 0 && (
              <ul className="mt-3 cutline pt-2">
                {selExp.map((e) => (
                  <li key={e.id}>
                    {/* C10: 行タップで履歴と同じ編集シート（削除もシート内から） */}
                    <button
                      onClick={() => setEditing({ ...e })}
                      className="flex w-full items-baseline gap-1 py-1 text-left text-sm"
                    >
                      {e.category && (
                        <CategoryIcon icon={e.icon} className="h-4 w-4 shrink-0 self-center text-ink-faint" />
                      )}
                      <span className="truncate">{e.memo || e.category || "支出"}</span>
                      <span className="leader" />
                      <span className="dot tabular-nums text-vermilion">−{fmtYen(e.amount)}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
            {(selPlanPd.length > 0 || selPlanInc.length > 0 || selPlanExp.length > 0) && (
              <div className="mt-3 cutline pt-2">
                <p className="dot text-[11px] text-ink-faint">＊ 予定（まだ記帳前） ＊</p>
                {selPlanPd.map((p) => (
                  <div
                    key={p.jobId}
                    className="mt-2 rounded-md border border-dashed px-3 py-2 opacity-80"
                    style={{ borderColor: p.color }}
                  >
                    <div className="flex items-baseline text-sm">
                      <span
                        className="mr-1.5 inline-block h-2.5 w-2.5 self-center rounded-full opacity-70"
                        style={{ backgroundColor: p.color }}
                      />
                      <span>{p.jobName} 給料日</span>
                      <span className="ml-1 shrink-0 text-[10px] text-ink-faint">予定</span>
                      <span className="leader" />
                      {p.amount > 0 ? (
                        <span className="dot shrink-0 tabular-nums text-sage">+{fmtYen(p.amount)}</span>
                      ) : (
                        <span className="shrink-0 text-[11px] text-ink-faint">金額未定</span>
                      )}
                    </div>
                    <p className="mt-0.5 text-[11px] text-ink-faint">
                      {p.confirmed
                        ? `${fmtDateJa(p.periodStart)}〜${fmtDateJa(p.periodEnd)}の入力済みシフト分`
                        : "シフト未入力のため金額は未定です"}
                    </p>
                  </div>
                ))}
                {selPlanInc.length > 0 && (
                  <ul className="mt-2">
                    {selPlanInc.map((x) => (
                      <li key={x.recurringId} className="flex items-baseline py-1 text-sm opacity-80">
                        <span className="text-sage">＋</span>
                        <span className="ml-1 truncate">{x.name}</span>
                        <span className="ml-1 shrink-0 text-[10px] text-ink-faint">予定</span>
                        <span className="leader" />
                        <span className="dot shrink-0 tabular-nums text-sage">+{fmtYen(x.amount)}</span>
                      </li>
                    ))}
                  </ul>
                )}
                {selPlanExp.length > 0 && (
                  <ul className="mt-2">
                    {selPlanExp.map((x) => (
                      <li key={x.recurringId} className="flex items-baseline gap-1 py-1 text-sm opacity-80">
                        {x.category && (
                          <CategoryIcon icon={x.icon} className="h-4 w-4 shrink-0 self-center text-ink-faint" />
                        )}
                        <span className="truncate">{x.name}</span>
                        <span className="shrink-0 text-[10px] text-ink-faint">予定</span>
                        <span className="leader" />
                        <span className="dot shrink-0 tabular-nums text-ink-faint">−{fmtYen(x.amount)}</span>
                      </li>
                    ))}
                  </ul>
                )}
                <p className="mt-2 text-[10px] text-ink-faint">
                  予定はその月が来ると自動で記帳されます。内容は「設定 › 定期支出・収入」から変更できます。
                </p>
              </div>
            )}
            {selPd.length === 0 &&
              selInc.length === 0 &&
              selExp.length === 0 &&
              selPlanPd.length === 0 &&
              selPlanInc.length === 0 &&
              selPlanExp.length === 0 && (
              <p className="mt-4 pb-2 text-center text-xs text-ink-faint">
                この日のお金の動きはありません（ノーマネーデー）
              </p>
            )}

            {/* この日にシフトを直接追加（カレンダーから。複数日まとめて・音声はシフト画面のまま） */}
            <div className="mt-4 cutline pt-3">
              {jobs.length === 0 ? (
                <Link
                  href="/settings#jobs"
                  className="dot block text-center text-[11px] text-ink-faint underline underline-offset-2"
                >
                  バイト先を登録すると、ここからシフトを入れられます
                </Link>
              ) : !showShiftAdd ? (
                <button
                  onClick={() => setShowShiftAdd(true)}
                  className="dot w-full rounded-md border border-ink py-2 text-sm active:translate-y-0.5"
                >
                  ＋ この日にシフトを追加
                </button>
              ) : (
                <div className="space-y-2">
                  {jobs.length > 1 && (
                    <select
                      value={shiftJob}
                      onChange={(e) => setShiftJob(e.target.value)}
                      className="w-full rounded-md border border-rule bg-paper px-3 py-2 text-sm"
                    >
                      {jobs.map((j) => (
                        <option key={j.id} value={j.id}>
                          {j.name}
                        </option>
                      ))}
                    </select>
                  )}
                  <div className="flex items-center gap-2 text-sm">
                    <input
                      type="time"
                      value={shiftStart}
                      onChange={(e) => setShiftStart(e.target.value)}
                      className="flex-1 rounded-md border border-rule bg-paper px-2 py-2"
                    />
                    <span className="text-ink-faint">〜</span>
                    <input
                      type="time"
                      value={shiftEnd}
                      onChange={(e) => setShiftEnd(e.target.value)}
                      className="flex-1 rounded-md border border-rule bg-paper px-2 py-2"
                    />
                  </div>
                  <div className="flex items-center gap-2 text-sm">
                    <label className="flex flex-1 items-center gap-1.5 text-ink-faint">
                      休憩
                      <input
                        type="number"
                        inputMode="numeric"
                        value={shiftBreak}
                        onChange={(e) => setShiftBreak(e.target.value)}
                        className="w-16 rounded-md border border-rule bg-paper px-2 py-1.5 text-right"
                      />
                      分
                    </label>
                    <button
                      onClick={() => setShowShiftAdd(false)}
                      className="rounded-md border border-rule px-3 py-1.5 text-xs text-ink-faint"
                    >
                      やめる
                    </button>
                    <button
                      onClick={addShift}
                      disabled={shiftBusy || !shiftJob}
                      className="dot rounded-md bg-vermilion px-4 py-1.5 text-sm text-card active:translate-y-0.5 disabled:opacity-50"
                    >
                      追加
                    </button>
                  </div>
                  <p className="text-[10px] text-ink-faint">
                    複数日まとめて・音声での入力は「シフト」タブから
                  </p>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* C10: 履歴と同じ編集シート */}
      {editing && (
        <ExpenseEditSheet
          expense={{
            id: editing.id,
            date: editing.date,
            amount: editing.amount,
            memo: editing.memo,
            category_id: editing.category_id ?? null,
            source: editing.source,
            receipt_id: editing.receipt_id ?? null,
          }}
          categories={categories}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            load(month);
            show("保存しました");
          }}
          onDeleted={(undo) => {
            setEditing(null);
            load(month);
            show("支出を削除しました", async () => {
              try {
                await undo();
                load(month);
                show("元に戻しました");
              } catch (e) {
                show(e instanceof Error ? e.message : "元に戻せませんでした。");
              }
            });
          }}
        />
      )}

      <Toast toast={toast} hide={hide} />
    </div>
  );
}
