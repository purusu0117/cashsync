"use client";

// 履歴：月切替＋日別グルーピング。タップで編集/削除/複製（「もう一度」）。
import { useCallback, useEffect, useRef, useState } from "react";
import Loading from "@/components/Loading";
import { cachedFetch } from "@/lib/cachedFetch";
import { apiCall, apiJson } from "@/lib/clientApi";
import { fmtDateJa, fmtMonthJa, fmtYen, todayLocal } from "@/lib/format";

interface Expense {
  id: string;
  date: string;
  amount: number;
  memo: string;
  source: string;
  category_id: string | null;
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
  const [busy, setBusy] = useState(false);
  const [editError, setEditError] = useState("");
  const [ready, setReady] = useState(false); // 初回データ（キャッシュ含む）が来るまでスケルトン表示

  // 月切替の連打時に古い月のレスポンスで上書きされないよう、最新リクエストだけ反映する
  const reqRef = useRef(0);
  const load = useCallback(async (m: string) => {
    const req = ++reqRef.current;
    // キャッシュファースト＋並列取得：前回のデータを即表示→裏で最新に差し替え
    await Promise.all([
      cachedFetch<{ expenses?: Expense[] }>(`/api/expenses?month=${m}`, (d) => {
        if (reqRef.current !== req) return;
        setExpenses(d.expenses ?? []);
        setReady(true);
      }),
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

  async function saveEdit() {
    if (!editing) return;
    setBusy(true);
    setEditError("");
    try {
      await apiCall(
        "/api/expenses",
        apiJson(
          {
            id: editing.id,
            date: editing.date,
            amount: editing.amount,
            categoryId: editing.category_id,
            memo: editing.memo,
          },
          "PUT",
        ),
      );
      setEditing(null);
      load(month);
    } catch (e) {
      setEditError(e instanceof Error ? e.message : "保存に失敗しました。");
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!editing) return;
    setBusy(true);
    setEditError("");
    try {
      await apiCall(`/api/expenses?id=${editing.id}`, { method: "DELETE" });
      setEditing(null);
      load(month);
    } catch (e) {
      setEditError(e instanceof Error ? e.message : "削除に失敗しました。");
    } finally {
      setBusy(false);
    }
  }

  async function removeRow(e: Expense) {
    if (!confirm(`「${e.memo || e.category || "支出"} ${fmtYen(e.amount)}」を削除しますか？`)) return;
    try {
      await apiCall(`/api/expenses?id=${e.id}`, { method: "DELETE" });
      load(month);
    } catch {
      /* apiCall内で401はログインへ */
    }
  }

  async function duplicate() {
    if (!editing) return;
    setBusy(true);
    setEditError("");
    try {
      await apiCall(
        "/api/expenses",
        apiJson({
          amount: editing.amount,
          categoryId: editing.category_id,
          memo: editing.memo,
          source: "manual",
        }),
      );
      setEditing(null);
      setMonth(todayLocal().slice(0, 7));
      load(todayLocal().slice(0, 7));
    } catch (e) {
      setEditError(e instanceof Error ? e.message : "登録に失敗しました。");
    } finally {
      setBusy(false);
    }
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

      <div className="zig zig-t zig-b px-5 pt-4 pb-3 text-center shadow-sm">
        <p className="dot text-xs tracking-[0.18em] text-ink-faint">＊ 支出合計 ＊</p>
        <p className="dot mt-1 text-4xl leading-none tabular-nums">{fmtYen(total)}</p>
        <p className="mt-1 text-[11px] text-ink-faint">{expenses.length}件の記録</p>
      </div>

      {/* 収入（シフト給与以外：スクショ収入・仕送り等） */}
      {incomes.length > 0 && (
        <section className="zig zig-t zig-b px-4 py-3 shadow-sm">
          <h2 className="dot text-xs tracking-[0.1em] text-sage">この月の収入（バイト給与を除く）</h2>
          <ul className="mt-1">
            {incomes.map((i) => (
              <li key={i.id} className="flex items-baseline gap-1 py-1.5 text-sm">
                <span className="shrink-0 text-ink-faint">{fmtDateJa(i.date)}</span>
                <span className="ml-1 truncate">{i.memo || "収入"}</span>
                <span className="leader" />
                <span className="dot tabular-nums text-sage">{fmtYen(i.amount)}</span>
                <button
                  onClick={async () => {
                    if (!confirm(`収入「${i.memo || ""} ${fmtYen(i.amount)}」を削除しますか？`)) return;
                    await fetch(`/api/incomes?id=${i.id}`, { method: "DELETE" });
                    load(month);
                  }}
                  className="shrink-0 px-1 text-xs text-vermilion"
                  aria-label="削除"
                >
                  ✕
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      {[...byDate.entries()].map(([date, list]) => {
        const dayTotal = list.reduce((s, e) => s + e.amount, 0);
        return (
          <section key={date}>
            <h2 className="flex items-baseline">
              <span className="dot text-[13px]">{fmtDateJa(date)}</span>
              {list.length > 1 && (
                <span className="ml-2 text-[11px] text-ink-faint">
                  計 {fmtYen(dayTotal)}
                </span>
              )}
            </h2>
            <div className="zig zig-b mt-1 px-4 py-2 shadow-sm">
              {list.map((e) => (
                <div key={e.id} className="flex items-baseline gap-1 py-2 text-sm">
                  <button
                    onClick={() => {
                      setEditError("");
                      setEditing({ ...e });
                    }}
                    className="flex min-w-0 flex-1 items-baseline text-left"
                  >
                    <span className="mr-1">{e.icon}</span>
                    <span className="truncate">{e.memo || e.category || "支出"}</span>
                    {e.source === "receipt" && (
                      <span className="ml-1.5 shrink-0 text-[9px] tracking-wide text-ink-faint">
                        自動
                      </span>
                    )}
                    {e.source === "recurring" && (
                      <span className="ml-1.5 shrink-0 text-[9px] tracking-wide text-ink-faint">
                        定期
                      </span>
                    )}
                    <span className="leader" />
                    <span className="dot text-[15px] tabular-nums">{fmtYen(e.amount)}</span>
                  </button>
                  <button
                    onClick={() => removeRow(e)}
                    className="shrink-0 px-1 text-xs text-ink-faint"
                    aria-label="削除"
                  >
                    ✕
                  </button>
                </div>
              ))}
            </div>
          </section>
        );
      })}
      {expenses.length === 0 && (
        <p className="py-8 text-center text-xs text-ink-faint">この月の記録はありません。</p>
      )}

      {/* 編集シート */}
      {editing && (
        <div className="fixed inset-0 z-50 flex items-end bg-ink/40" onClick={() => setEditing(null)}>
          <div
            className="zig zig-t w-full max-w-md mx-auto px-5 pb-8 pt-5"
            onClick={(e) => e.stopPropagation()}
          >
            <p className="dot text-center text-xs text-ink-faint">＊ 編集 ＊</p>
            <div className="mt-3 space-y-3">
              <input
                type="number"
                inputMode="numeric"
                value={editing.amount || ""}
                onChange={(e) => setEditing({ ...editing, amount: Number(e.target.value) })}
                className="dot w-full rounded-md border border-rule bg-paper px-3 py-2 text-2xl tabular-nums outline-none focus:border-ink"
              />
              <input
                type="date"
                value={editing.date}
                onChange={(e) => setEditing({ ...editing, date: e.target.value })}
                className="w-full rounded-md border border-rule bg-paper px-3 py-2 text-base outline-none focus:border-ink"
              />
              <div className="flex flex-wrap gap-1.5">
                {categories.map((c) => (
                  <button
                    key={c.id}
                    onClick={() => setEditing({ ...editing, category_id: c.id })}
                    className={`rounded-full border px-3 py-1 text-sm ${
                      editing.category_id === c.id
                        ? "border-vermilion bg-vermilion text-card"
                        : "border-rule bg-paper"
                    }`}
                  >
                    {c.icon} {c.name}
                  </button>
                ))}
              </div>
              <input
                value={editing.memo}
                onChange={(e) => setEditing({ ...editing, memo: e.target.value })}
                placeholder="メモ"
                className="w-full rounded-md border border-rule bg-paper px-3 py-2 text-base outline-none focus:border-ink"
              />
            </div>
            {editError && <p className="mt-2 text-sm text-vermilion">{editError}</p>}
            <div className="mt-4 flex gap-2">
              <button
                onClick={remove}
                disabled={busy}
                className="rounded-md border border-vermilion px-4 py-3 text-sm text-vermilion"
              >
                削除
              </button>
              <button
                onClick={duplicate}
                disabled={busy}
                className="flex-1 rounded-md border border-rule py-3 text-sm"
                title="同じ内容で今日の日付で記録"
              >
                もう一度
              </button>
              <button
                onClick={saveEdit}
                disabled={busy}
                className="dot flex-1 rounded-md bg-vermilion py-3 text-base text-card shadow-[0_2px_0_var(--vermilion-deep)]"
              >
                保存
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
