"use client";

// 履歴：月切替＋日別グルーピング。タップで編集/削除/複製（「もう一度」）。
// C7: 行の✕は廃止し、削除は編集シート内から（削除後はUndoつきトースト）。
// B11: 上部の検索ボックス（店名/メモ部分一致＋カテゴリ＋金額範囲。全期間・サーバー側ページング）。
// C15: 未来月へも送れる。予定（定期・分割・給料日）はカレンダーと同じ plan API から薄字で表示。
import { useCallback, useEffect, useRef, useState } from "react";
import { ExpenseEditSheet, IncomeEditSheet } from "@/components/EditSheets";
import Loading from "@/components/Loading";
import { Toast, useToast } from "@/components/Toast";
import { cachedFetch, netFetch } from "@/lib/cachedFetch";
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
interface Tag {
  id: string;
  name: string;
}
interface Income {
  id: string;
  date: string;
  amount: number;
  type: string;
  memo: string;
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
  amount: number; // 0 = シフト未入力で金額未定
  confirmed: boolean;
}
interface MonthPlan {
  expenses: PlannedRecurring[];
  incomes: PlannedRecurring[];
  paydays: PlannedPayday[];
  expenseTotal: number;
  incomeTotal: number;
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
  const [tags, setTags] = useState<Tag[]>([]);
  const [editing, setEditing] = useState<Expense | null>(null);
  const [editingIncome, setEditingIncome] = useState<Income | null>(null); // C8: 収入の編集
  // B9: 集計期間（締め日基準。開始日1なら実カレンダー月と同じ）
  const [range, setRange] = useState<{ start: string; end: string } | null>(null);
  // C15: 未来月の予定（カレンダーと同じ plan API）
  const [plan, setPlan] = useState<MonthPlan | null>(null);
  const [ready, setReady] = useState(false); // 初回データ（キャッシュ含む）が来るまでスケルトン表示
  const { toast, show, hide } = useToast(); // A6: 保存・削除・複製の完了フィードバック

  // --- B11: 検索 ---
  const [q, setQ] = useState("");
  const [filterOpen, setFilterOpen] = useState(false);
  const [fCat, setFCat] = useState("");
  const [fMin, setFMin] = useState("");
  const [fMax, setFMax] = useState("");
  const [results, setResults] = useState<Expense[]>([]);
  const [resultTotal, setResultTotal] = useState(0);
  const [searchBusy, setSearchBusy] = useState(false);
  const searching = q.trim() !== "" || fCat !== "" || fMin !== "" || fMax !== "";

  const searchReq = useRef(0);
  const runSearch = useCallback(
    async (offset: number, append: boolean) => {
      const req = ++searchReq.current;
      setSearchBusy(true);
      try {
        const params = new URLSearchParams({ search: "1", offset: String(offset) });
        if (q.trim()) params.set("q", q.trim());
        if (fCat) params.set("category", fCat);
        if (fMin) params.set("min", fMin);
        if (fMax) params.set("max", fMax);
        const res = await netFetch(`/api/expenses?${params}`);
        const d = (await res.json()) as { expenses?: Expense[]; total?: number; error?: string };
        if (!res.ok) throw new Error(d.error ?? "検索に失敗しました。");
        if (searchReq.current !== req) return;
        setResults((prev) => (append ? [...prev, ...(d.expenses ?? [])] : (d.expenses ?? [])));
        setResultTotal(d.total ?? 0);
      } catch {
        if (searchReq.current === req && !append) {
          setResults([]);
          setResultTotal(0);
        }
      } finally {
        if (searchReq.current === req) setSearchBusy(false);
      }
    },
    [q, fCat, fMin, fMax],
  );

  // 入力から300ms待って検索（連打でサーバーを叩きすぎない）
  useEffect(() => {
    if (!searching) {
      searchReq.current++;
      setResults([]);
      setResultTotal(0);
      return;
    }
    const t = setTimeout(() => runSearch(0, false), 300);
    return () => clearTimeout(t);
  }, [searching, runSearch]);

  // 月切替の連打時に古い月のレスポンスで上書きされないよう、最新リクエストだけ反映する
  const reqRef = useRef(0);
  const load = useCallback(async (m: string) => {
    const req = ++reqRef.current;
    const future = m > todayLocal().slice(0, 7);
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
      // C15: 未来月は予定（定期・分割・給料日）も取得して薄字で出す
      future
        ? cachedFetch<{ plan?: MonthPlan }>(`/api/calendar?month=${m}`, (d) => {
            if (reqRef.current !== req) return;
            setPlan(d.plan ?? null);
          })
        : Promise.resolve(setPlan(null)),
    ]).catch(() => {
      /* 初回読み込み失敗時はスケルトンのまま（復帰時の visibilitychange で再試行される） */
    });
  }, []);

  useEffect(() => {
    load(month);
    cachedFetch<{ categories?: Category[] }>("/api/categories", (d) =>
      setCategories(d.categories ?? []),
    ).catch(() => {});
    cachedFetch<{ tags?: Tag[] }>("/api/tags", (d) => setTags(d.tags ?? [])).catch(() => {});
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
  // C15: 予定（支出・収入・給料日）を日付順の1本のリストにまとめる
  const planItems: { key: string; date: string; label: string; sub: string; amount: number; income: boolean }[] = [];
  if (plan) {
    for (const p of plan.expenses) {
      planItems.push({ key: `pe${p.recurringId}${p.date}`, date: p.date, label: p.name, sub: p.category ?? "", amount: p.amount, income: false });
    }
    for (const p of plan.incomes) {
      planItems.push({ key: `pi${p.recurringId}${p.date}`, date: p.date, label: p.name, sub: "定期収入", amount: p.amount, income: true });
    }
    for (const p of plan.paydays) {
      planItems.push({
        key: `pp${p.jobId}${p.date}`,
        date: p.date,
        label: `${p.jobName} 給料日`,
        sub: p.confirmed ? "入力済みシフト分" : "シフト未入力・金額未定",
        amount: p.amount,
        income: true,
      });
    }
    planItems.sort((a, b) => a.date.localeCompare(b.date));
  }

  // C7: 削除のUndo（8秒間「元に戻す」）。undo() は削除前の内容で復元する
  function afterDelete(kind: "支出" | "収入", undo: () => Promise<unknown>) {
    show(`${kind}を削除しました`, async () => {
      try {
        await undo();
        load(month);
        if (searching) runSearch(0, false);
        show("元に戻しました");
      } catch (e) {
        show(e instanceof Error ? e.message : "元に戻せませんでした。");
      }
    });
  }

  if (!ready) return <Loading />;

  const inputCls =
    "rounded-md border border-rule bg-paper px-3 py-2 text-sm outline-none focus:border-ink";

  return (
    <div className="space-y-4">
      {/* B11: 検索（全期間から店名/メモ・カテゴリ・金額で絞り込む） */}
      <div className="space-y-2">
        <div className="flex gap-2">
          <input
            type="search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="店名・メモで検索（全期間）"
            className={`${inputCls} min-w-0 flex-1`}
          />
          <button
            onClick={() => setFilterOpen(!filterOpen)}
            aria-expanded={filterOpen}
            className={`dot shrink-0 rounded-md border px-3 py-2 text-xs ${
              fCat || fMin || fMax ? "border-ink text-ink" : "border-rule text-ink-faint"
            }`}
          >
            絞り込み{filterOpen ? "▲" : "▼"}
          </button>
        </div>
        {filterOpen && (
          <div className="grid grid-cols-2 gap-2">
            <select value={fCat} onChange={(e) => setFCat(e.target.value)} className={`${inputCls} col-span-2 min-w-0`}>
              <option value="">カテゴリ：すべて</option>
              {categories.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
            <input
              type="number"
              inputMode="numeric"
              value={fMin}
              onChange={(e) => setFMin(e.target.value)}
              placeholder="金額 下限"
              className={`${inputCls} min-w-0 tabular-nums`}
            />
            <input
              type="number"
              inputMode="numeric"
              value={fMax}
              onChange={(e) => setFMax(e.target.value)}
              placeholder="金額 上限"
              className={`${inputCls} min-w-0 tabular-nums`}
            />
          </div>
        )}
      </div>

      {searching ? (
        /* B11: 検索結果（全期間・日付降順・ページング） */
        <div className="zig zig-t zig-b px-5 pt-4 pb-4 shadow-sm">
          <p className="dot text-center text-xs tracking-[0.18em] text-ink-faint">＊ 検索結果 ＊</p>
          <p className="mt-1 text-center text-[11px] text-ink-faint">
            {searchBusy && results.length === 0 ? "検索中・・・" : `${resultTotal}件見つかりました`}
          </p>
          <div className="cutline mt-2 pt-1">
            {results.map((e) => (
              <button
                key={e.id}
                onClick={() => setEditing({ ...e })}
                className="flex w-full items-baseline py-1.5 text-left text-sm"
              >
                <span className="shrink-0 text-[11px] text-ink-faint tabular-nums">
                  {e.date.slice(2).replace(/-/g, "/")}
                </span>
                <span className="ml-1.5 truncate">{e.memo || e.category || "支出"}</span>
                <span className="ml-1.5 shrink-0 text-[10px] text-ink-faint">{e.category}</span>
                <span className="leader" />
                <span className="dot text-[15px] tabular-nums">{fmtYen(e.amount)}</span>
              </button>
            ))}
            {!searchBusy && results.length === 0 && (
              <p className="py-8 text-center text-xs text-ink-faint">見つかりませんでした。</p>
            )}
          </div>
          {results.length < resultTotal && (
            <button
              onClick={() => runSearch(results.length, true)}
              disabled={searchBusy}
              className="dot mt-3 w-full rounded-md border border-rule py-2.5 text-sm text-ink-faint disabled:opacity-50"
            >
              {searchBusy ? "読み込み中・・・" : `もっと見る（あと${resultTotal - results.length}件）`}
            </button>
          )}
          <div className="barcode mt-4" />
        </div>
      ) : (
        <>
      <header className="flex items-center justify-between">
        <button onClick={() => setMonth(shiftMonth(month, -1))} className="dot px-3 py-1 text-lg">
          ◀
        </button>
        <h1 className="dot text-lg">{fmtMonthJa(month)}</h1>
        {/* C15: 未来月へも送れる（予定を薄字で表示） */}
        <button onClick={() => setMonth(shiftMonth(month, 1))} className="dot px-3 py-1 text-lg">
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
          {/* C15: 未来月は予定の合計も添える */}
          {plan && (plan.expenseTotal > 0 || plan.incomeTotal > 0) && (
            <p className="dot mt-1 text-[11px] text-ink-faint">
              予定：支出 −{fmtYen(plan.expenseTotal)} ・ 収入 +{fmtYen(plan.incomeTotal)}
            </p>
          )}
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
                      {e.source === "import" && "・取り込み"}
                    </span>
                    <span className="leader" />
                    <span className="dot text-[15px] tabular-nums">{fmtYen(e.amount)}</span>
                  </button>
                ))}
              </div>
            </section>
          );
        })}
        {expenses.length === 0 && incomes.length === 0 && planItems.length === 0 && (
          <p className="py-8 text-center text-xs text-ink-faint">この月の記録はありません。</p>
        )}

        {/* C15: 予定（定期・分割・給料日）。カレンダーと同じデータを薄字で印字する */}
        {planItems.length > 0 && (
          <section className="cutline mt-3 pt-2.5">
            <h2 className="dot text-[11px] text-ink-faint">＊ 予定（まだ記帳前） ＊</h2>
            <div className="opacity-70">
              {planItems.map((p) => (
                <div key={p.key} className="flex items-baseline py-1.5 text-sm">
                  <span className="shrink-0 text-[11px] text-ink-faint">{fmtDateJa(p.date)}</span>
                  <span className="ml-1.5 truncate text-ink-faint">{p.label}</span>
                  {p.sub && <span className="ml-1.5 shrink-0 text-[10px] text-ink-faint">{p.sub}</span>}
                  <span className="leader" />
                  {p.amount > 0 ? (
                    <span className={`dot tabular-nums ${p.income ? "text-sage/80" : "text-ink-faint"}`}>
                      {p.income ? "+" : "-"}
                      {fmtYen(p.amount)}
                    </span>
                  ) : (
                    <span className="shrink-0 text-[10px] text-ink-faint">金額未定</span>
                  )}
                </div>
              ))}
            </div>
            <p className="mt-1 text-[10px] text-ink-faint">
              予定はその月が来ると自動で記帳されます（設定 › 定期支出・収入）
            </p>
          </section>
        )}

        <div className="barcode mt-4" />
        <p className="dot mt-1 text-center text-[10px] tracking-[0.3em] text-ink-faint">
          {month.replace("-", "")}
        </p>
      </div>
        </>
      )}

      {/* 編集シート（支出） */}
      {editing && (
        <ExpenseEditSheet
          expense={editing}
          categories={categories}
          tags={tags}
          onTagsChanged={() =>
            netFetch("/api/tags")
              .then((r) => r.json())
              .then((d: { tags?: Tag[] }) => setTags(d.tags ?? []))
              .catch(() => {})
          }
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            load(month);
            if (searching) runSearch(0, false);
            show("保存しました");
          }}
          onDeleted={(undo) => {
            setEditing(null);
            load(month);
            if (searching) runSearch(0, false);
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
