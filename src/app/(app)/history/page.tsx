"use client";

// 履歴：月切替＋日別グルーピング。タップで編集/削除/複製（「もう一度」）。
// C7: 行の✕は廃止し、削除は編集シート内から（削除後はUndoつきトースト）。
import { useCallback, useEffect, useRef, useState } from "react";
import { ExpenseEditSheet, IncomeEditSheet } from "@/components/EditSheets";
import Loading from "@/components/Loading";
import { Toast, useToast } from "@/components/Toast";
import { cachedFetch } from "@/lib/cachedFetch";
import { fmtDateJa, fmtMonthJa, fmtYen, todayLocal } from "@/lib/format";

interface Expense {
  id: string;
  date: string;
  amount: number;
  memo: string;
  source: string;
  category_id: string | null;
  receipt_id?: string | null;
  category: string | null;
  icon: string | null;
}
interface Category {
  id: string;
  name: string;
  icon: string;
}
interface Income {
  id: string;
  date: string;
  amount: number;
  type: string;
  memo: string;
}

function shiftMonth(month: string, delta: number): string {
  const [y, m] = month.split("-").map(Number);
  const d = new Date(y, m - 1 + delta, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

export default function HistoryPage() {
  const [month, setMonth] = useState(todayLocal().slice(0, 7));
  const [expenses, setExpenses] = useState<Expense[]>([]);
  const [incomes, setIncomes] = useState<Income[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [editing, setEditing] = useState<Expense | null>(null);
  const [editingIncome, setEditingIncome] = useState<Income | null>(null); // C8: 収入の編集
  // B9: 集計期間（締め日基準。開始日1なら実カレンダー月と同じ）
  const [range, setRange] = useState<{ start: string; end: string } | null>(null);
  const [ready, setReady] = useState(false); // 初回データ（キャッシュ含む）が来るまでスケルトン表示
  const { toast, show, hide } = useToast(); // A6: 保存・削除・複製の完了フィードバック

  // 月切替の連打時に古い月のレスポンスで上書きされないよう、最新リクエストだけ反映する
  const reqRef = useRef(0);
  const load = useCallback(async (m: string) => {
    const req = ++reqRef.current;
    // キャッシュファースト＋並列取得：前回のデータを即表示→裏で最新に差し替え
    await Promise.all([
      cachedFetch<{ expenses?: Expense[]; range?: { start: string; end: string } }>(
        `/api/expenses?month=${m}`,
        (d) => {
          if (reqRef.current !== req) return;
          setExpenses(d.expenses ?? []);
          setRange(d.range ?? null);
          setReady(true);
        },
      ),
      cachedFetch<{ incomes?: Income[] }>(`/api/incomes?month=${m}`, (d) => {
        if (reqRef.current !== req) return;
        setIncomes(d.incomes ?? []);
      }),
    ]).catch(() => {
      /* 初回読み込み失敗時はスケルトンのまま（復帰時の visibilitychange で再試行される） */
    });
  }, []);

  useEffect(() => {
    load(month);
    cachedFetch<{ categories?: Category[] }>("/api/categories", (d) =>
      setCategories(d.categories ?? []),
    ).catch(() => {});
    // アプリに戻ってきたら最新化
    const onVisible = () => {
      if (document.visibilityState === "visible") load(month);
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [month, load]);

  const total = expenses.reduce((s, e) => s + e.amount, 0);
  const byDate = new Map<string, Expense[]>();
  for (const e of expenses) {
    const arr = byDate.get(e.date) ?? [];
    arr.push(e);
    byDate.set(e.date, arr);
  }

  // C7: 削除のUndo（8秒間「元に戻す」）。undo() は削除前の内容で復元する
  function afterDelete(kind: "支出" | "収入", undo: () => Promise<unknown>) {
    show(`${kind}を削除しました`, async () => {
      try {
        await undo();
        load(month);
        show("元に戻しました");
      } catch (e) {
        show(e instanceof Error ? e.message : "元に戻せませんでした。");
      }
    });
  }

  if (!ready) return <Loading />;

  return (
    <div className="space-y-4">
      <header className="flex items-center justify-between">
        <button onClick={() => setMonth(shiftMonth(month, -1))} className="dot px-3 py-1 text-lg">
          ◀
        </button>
        <h1 className="dot text-lg">{fmtMonthJa(month)}</h1>
        <button
          onClick={() => setMonth(shiftMonth(month, 1))}
          className="dot px-3 py-1 text-lg disabled:opacity-30"
          disabled={month >= todayLocal().slice(0, 7)}
        >
          ▶
        </button>
      </header>
      {/* B9: 締め日を変えている場合だけ集計期間を明示（開始日1なら出さない） */}
      {range && !range.start.endsWith("-01") && (
        <p className="-mt-2 text-center text-[10px] text-ink-faint">
          {fmtDateJa(range.start)}〜{fmtDateJa(range.end)}の集計
        </p>
      )}

      {/* 1ヶ月＝1枚の長いレシート：本物のレシート同様、切らずに続けて印字する */}
      <div className="zig zig-t zig-b px-5 pt-4 pb-4 shadow-sm">
        <div className="text-center">
          <p className="dot text-xs tracking-[0.18em] text-ink-faint">＊ 支出合計 ＊</p>
          <p className="dot mt-1 text-4xl leading-none tabular-nums">{fmtYen(total)}</p>
          <p className="mt-1 text-[11px] text-ink-faint">{expenses.length}件の記録</p>
        </div>

        {/* 収入（シフト給与以外：スクショ収入・仕送り等） */}
        {incomes.length > 0 && (
          <section className="cutline mt-3 pt-3">
            <h2 className="dot text-xs tracking-[0.1em] text-sage">収入（バイト給与を除く）</h2>
            <ul className="mt-0.5">
              {incomes.map((i) => (
                <li key={i.id}>
                  {/* C8: 行タップで支出と同等の編集シート（金額・日付・メモ。削除もシート内から） */}
                  <button
                    onClick={() => setEditingIncome({ ...i })}
                    className="flex w-full items-baseline gap-1 py-1.5 text-left text-sm"
                  >
                    <span className="shrink-0 text-ink-faint">{fmtDateJa(i.date)}</span>
                    <span className="ml-1 truncate">{i.memo || "収入"}</span>
                    <span className="leader" />
                    <span className="dot tabular-nums text-sage">+{fmtYen(i.amount)}</span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        )}

        {[...byDate.entries()].map(([date, list]) => {
          const dayTotal = list.reduce((s, e) => s + e.amount, 0);
          return (
            <section key={date} className="cutline mt-3 pt-2.5">
              <h2 className="flex items-baseline">
                <span className="dot text-[13px]">{fmtDateJa(date)}</span>
                <span className="leader" />
                <span className="dot text-[11px] tabular-nums text-ink-faint">
                  {list.length}件 {fmtYen(dayTotal)}
                </span>
              </h2>
              <div>
                {list.map((e) => (
                  /* C7: 行の✕は廃止（誤タップ対策）。タップ→編集シート内から削除する */
                  <button
                    key={e.id}
                    onClick={() => setEditing({ ...e })}
                    className="flex w-full items-baseline py-1.5 text-left text-sm"
                  >
                    <span className="truncate">{e.memo || e.category || "支出"}</span>
                    <span className="ml-1.5 shrink-0 text-[10px] text-ink-faint">
                      {e.category}
                      {e.source === "receipt" && "・自動"}
                      {e.source === "recurring" && "・定期"}
                    </span>
                    <span className="leader" />
                    <span className="dot text-[15px] tabular-nums">{fmtYen(e.amount)}</span>
                  </button>
                ))}
              </div>
            </section>
          );
        })}
        {expenses.length === 0 && (
          <p className="py-8 text-center text-xs text-ink-faint">この月の記録はありません。</p>
        )}

        <div className="barcode mt-4" />
        <p className="dot mt-1 text-center text-[10px] tracking-[0.3em] text-ink-faint">
          {month.replace("-", "")}
        </p>
      </div>

      {/* 編集シート（支出） */}
      {editing && (
        <ExpenseEditSheet
          expense={editing}
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
            afterDelete("支出", undo);
          }}
          onDuplicated={(undo) => {
            const amount = editing.amount;
            setEditing(null);
            const now = todayLocal().slice(0, 7);
            setMonth(now);
            load(now);
            show(`今日の日付で記録しました ${fmtYen(amount)}`, async () => {
              try {
                await undo();
                load(now);
                show("記録を取り消しました");
              } catch (e) {
                show(e instanceof Error ? e.message : "取り消しに失敗しました。");
              }
            });
          }}
        />
      )}

      {/* 編集シート（収入）C8 */}
      {editingIncome && (
        <IncomeEditSheet
          income={editingIncome}
          onClose={() => setEditingIncome(null)}
          onSaved={() => {
            setEditingIncome(null);
            load(month);
            show("保存しました");
          }}
          onDeleted={(undo) => {
            setEditingIncome(null);
            load(month);
            afterDelete("収入", undo);
          }}
        />
      )}

      <Toast toast={toast} hide={hide} />
    </div>
  );
}
