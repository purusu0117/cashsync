"use client";

// お金カレンダー：日付ごとの−支出/+収入と給料日を月表示。タップで詳細。
// 上部に「今日使えるお金」の計算内訳（何がいくらで、どう割られているか）を表示。
import { useCallback, useEffect, useState } from "react";
import { fmtDateJa, fmtMonthJa, fmtYen, todayLocal } from "@/lib/format";

interface CalExpense {
  id: string;
  date: string;
  amount: number;
  memo: string;
  source: string;
  category: string | null;
  icon: string | null;
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
interface CalData {
  month: string;
  expenses: CalExpense[];
  incomes: CalIncome[];
  paydays: Payday[];
  breakdown: {
    shiftIncome: number;
    otherIncome: number;
    incomeTotal: number;
    savingsGoal: number;
    expenseTotal: number;
    remain: number;
    daysRemaining: number | null;
    allowance: number | null;
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

  const load = useCallback(async (m: string) => {
    const res = await fetch(`/api/calendar?month=${m}`);
    if (res.status === 401) {
      location.href = "/login";
      return;
    }
    const d = await res.json();
    setData(d);
  }, []);

  useEffect(() => {
    load(month);
    const onVisible = () => {
      if (document.visibilityState === "visible") load(month);
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [month, load]);

  if (!data)
    return (
      <div className="mt-16 flex flex-col items-center gap-3 text-ink-faint">
        <div className="zig zig-b h-24 w-40 printing" />
        <p className="dot text-sm">読み込み中・・・</p>
      </div>
    );

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
  const b = data.breakdown;
  const selExp = selected ? (expByDate.get(selected) ?? []) : [];
  const selInc = selected ? (incByDate.get(selected) ?? []) : [];
  const selPd = selected ? (pdByDate.get(selected) ?? []) : [];

  async function removeExpense(e: CalExpense) {
    if (!confirm(`「${e.memo || e.category || "支出"} ${fmtYen(e.amount)}」を削除しますか？`)) return;
    await fetch(`/api/expenses?id=${e.id}`, { method: "DELETE" });
    load(month);
  }

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

      {/* 今日使えるお金の計算内訳 */}
      <section className="zig zig-t zig-b px-5 py-4 shadow-sm">
        <button onClick={() => setShowCalc(!showCalc)} className="flex w-full items-baseline">
          <h2 className="dot text-xs text-ink-faint">
            {b.allowance !== null ? "＊ 今日使えるお金の計算 ＊" : "＊ この月の収支 ＊"}
          </h2>
          <span className="leader" />
          {b.allowance !== null && (
            <span className="dot text-lg tabular-nums">{fmtYen(Math.max(0, b.allowance))}</span>
          )}
          <span className="ml-1 text-xs text-ink-faint">{showCalc ? "▲" : "▼"}</span>
        </button>
        {showCalc && (
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
            <div className="flex items-baseline">
              <span className="text-ink-faint">今月の支出</span>
              <span className="leader" />
              <span className="dot tabular-nums text-vermilion">−{fmtYen(b.expenseTotal)}</span>
            </div>
            <div className="cutline my-1.5" />
            <div className="flex items-baseline">
              <span className="text-ink-faint">残り</span>
              <span className="leader" />
              <span className="dot tabular-nums">{fmtYen(b.remain)}</span>
            </div>
            {b.allowance !== null && b.daysRemaining !== null && (
              <div className="flex items-baseline">
                <span className="text-ink-faint">÷ 残り{b.daysRemaining}日</span>
                <span className="leader" />
                <span className="dot tabular-nums">= {fmtYen(Math.max(0, b.allowance))}/日</span>
              </div>
            )}
          </div>
        )}
      </section>

      {/* カレンダー */}
      <div className="zig zig-t zig-b px-2 py-4 shadow-sm">
        <div className="grid grid-cols-7 text-center text-[11px] text-ink-faint">
          {["日", "月", "火", "水", "木", "金", "土"].map((d) => (
            <span key={d} className="py-1">
              {d}
            </span>
          ))}
        </div>
        <div className="grid grid-cols-7 gap-0.5">
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
            const today = date === todayLocal();
            return (
              <button
                key={date}
                onClick={() => setSelected(date)}
                className={`flex h-14 flex-col items-center justify-start rounded-md pt-0.5 ${
                  today ? "border-2 border-ink bg-card" : "border border-rule/60 bg-paper"
                }`}
              >
                <span className={`dot text-xs ${pd ? "text-sage" : ""}`}>
                  {day}
                  {pd && "💰"}
                </span>
                {got > 0 && (
                  <span className="dot text-[9px] leading-tight tabular-nums text-sage">
                    +{got >= 1000 ? `${Math.floor(got / 1000)}k` : got}
                  </span>
                )}
                {spent > 0 && (
                  <span className="dot text-[9px] leading-tight tabular-nums text-vermilion">
                    -{spent >= 1000 ? `${Math.floor(spent / 1000)}k` : spent}
                  </span>
                )}
              </button>
            );
          })}
        </div>
        <p className="mt-2 text-center text-[11px] text-ink-faint">
          日付をタップで詳細。💰=給料日（千円以上は k 表示）
        </p>
      </div>

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
                  <span>💰 {p.jobName} 給料日</span>
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
                    <span>💰 {x.memo || "収入"}</span>
                    <span className="leader" />
                    <span className="dot tabular-nums text-sage">+{fmtYen(x.amount)}</span>
                  </li>
                ))}
              </ul>
            )}
            {selExp.length > 0 && (
              <ul className="mt-3 cutline pt-2">
                {selExp.map((e) => (
                  <li key={e.id} className="flex items-baseline gap-1 py-1 text-sm">
                    <span>{e.icon}</span>
                    <span className="truncate">{e.memo || e.category || "支出"}</span>
                    <span className="leader" />
                    <span className="dot tabular-nums text-vermilion">−{fmtYen(e.amount)}</span>
                    <button
                      onClick={() => removeExpense(e)}
                      className="shrink-0 px-1 text-xs text-vermilion"
                      aria-label="削除"
                    >
                      ✕
                    </button>
                  </li>
                ))}
              </ul>
            )}
            {selPd.length === 0 && selInc.length === 0 && selExp.length === 0 && (
              <p className="mt-4 pb-2 text-center text-xs text-ink-faint">
                この日のお金の動きはありません 🈚
              </p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
