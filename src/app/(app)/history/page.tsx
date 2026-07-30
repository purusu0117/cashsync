"use client";

// 履歴：月切替＋日別グルーピング。タップで編集/削除/複製（「もう一度」）。
// C7: 行の✕は廃止し、削除は編集シート内から（削除後はUndoつきトースト）。
// B11: 上部の検索ボックス（店名/メモ部分一致＋カテゴリ＋金額範囲。全期間・サーバー側ページング）。
// C15: 未来月へも送れる。予定（定期・分割・給料日）はカレンダーと同じ plan API から薄字で表示。
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { ExpenseEditSheet, IncomeEditSheet } from "@/components/EditSheets";
import { CategoryIcon } from "@/components/Icons";
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
  const [loadStalled, setLoadStalled] = useState(false); // C2: 初回読み込みが失敗して固まったまま
  // グラフの内訳からの遷移：その月×このカテゴリだけに絞る（id=null は未分類。null 自体は「絞り込みなし」）
  const [catFilter, setCatFilter] = useState<{ id: string | null } | null>(null);
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
  const [searchError, setSearchError] = useState(false); // R2: 通信失敗を「0件」と区別する
  const [appendError, setAppendError] = useState(false); // R3: 「もっと見る」失敗の小さな知らせ
  const searching = q.trim() !== "" || fCat !== "" || fMin !== "" || fMax !== "";

  const searchReq = useRef(0);
  const runSearch = useCallback(
    async (offset: number, append: boolean) => {
      const req = ++searchReq.current;
      setSearchBusy(true);
      if (append) setAppendError(false);
      else setSearchError(false);
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
        if (searchReq.current === req) {
          // 通信失敗：0件（見つからない）ではなく「検索できませんでした」として区別する
          if (append) {
            setAppendError(true);
          } else {
            setResults([]);
            setResultTotal(0);
            setSearchError(true);
          }
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
      setSearchError(false);
      setAppendError(false);
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

  // グラフの内訳からの ?month=YYYY-MM & cat=<id|none> 指定を初回に反映
  useEffect(() => {
    const sp = new URLSearchParams(location.search);
    const m = sp.get("month");
    const cat = sp.get("cat");
    if (m && /^\d{4}-\d{2}$/.test(m)) setMonth(m);
    if (cat) setCatFilter({ id: cat === "none" ? null : cat });
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

  // C2: 初回読み込みが一定時間で来ないなら、Loadingで固まらず「再試行」に切り替える
  // （ready になれば早期リターンで loadStalled は参照されないため、同期 setState はしない）
  useEffect(() => {
    if (ready) return;
    const t = setTimeout(() => setLoadStalled(true), 8000);
    return () => clearTimeout(t);
  }, [ready]);

  // catFilter がある時はその月のこのカテゴリだけに絞る（内訳の金額と一致する明細を見せる）
  const shown = catFilter
    ? expenses.filter((e) => (e.category_id ?? null) === catFilter.id)
    : expenses;
  const catInfo = catFilter
    ? catFilter.id === null
      ? { name: "未分類", icon: null as string | null }
      : (categories.find((c) => c.id === catFilter.id) ?? { name: "カテゴリ", icon: null as string | null })
    : null;
  const total = shown.reduce((s, e) => s + e.amount, 0);
  const byDate = new Map<string, Expense[]>();
  for (const e of shown) {
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

  if (!ready)
    return loadStalled ? (
      <div className="mt-16 text-center">
        <p className="text-sm font-bold text-vermilion">読み込めませんでした</p>
        <button
          onClick={() => {
            setLoadStalled(false);
            load(month);
          }}
          className="mt-4 rounded-xl border border-ink px-6 py-2.5 text-sm active:translate-y-0.5"
        >
          再試行
        </button>
      </div>
    ) : (
      <Loading />
    );

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
            className={`shrink-0 rounded-md border px-3 py-2 text-xs ${
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
            {fMin && fMax && Number(fMin) > Number(fMax) && (
              <p className="col-span-2 text-[11px] text-caution">
                下限が上限より大きいため、条件に合う記録が出ないことがあります。
              </p>
            )}
          </div>
        )}
      </div>

      {searching ? (
        /* B11: 検索結果（全期間・日付降順・ページング） */
        <div className="rounded-2xl border border-rule bg-card p-4 shadow-sm">
          <h2 className="text-sm font-bold tracking-[0.04em]">検索結果</h2>
          <p
            className={`mt-0.5 text-[11px] ${
              searchError && results.length === 0 ? "text-vermilion" : "text-ink-faint"
            }`}
          >
            {searchBusy && results.length === 0
              ? "検索中・・・"
              : searchError && results.length === 0
                ? "検索できませんでした"
                : `${resultTotal}件見つかりました`}
          </p>
          <div className="mt-2">
            {results.map((e) => (
              <button
                key={e.id}
                onClick={() => setEditing({ ...e })}
                className="flex w-full items-center gap-3 border-b border-rule/70 py-2.5 text-left"
              >
                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-paper text-ink-faint">
                  <CategoryIcon icon={e.icon} className="h-5 w-5" />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm">{e.memo || e.category || "支出"}</p>
                  <p className="text-[11px] text-ink-faint">
                    {fmtDateJa(e.date)}
                    {e.category && `・${e.category}`}
                  </p>
                </div>
                <span className="shrink-0 font-bold tabular-nums">{fmtYen(e.amount)}</span>
              </button>
            ))}
            {!searchBusy &&
              results.length === 0 &&
              (searchError ? (
                <div className="py-8 text-center">
                  <button
                    onClick={() => runSearch(0, false)}
                    className="rounded-xl border border-ink px-6 py-2 text-sm active:translate-y-0.5"
                  >
                    再試行
                  </button>
                </div>
              ) : (
                <p className="py-8 text-center text-xs text-ink-faint">見つかりませんでした。</p>
              ))}
          </div>
          {results.length < resultTotal && (
            <button
              onClick={() => runSearch(results.length, true)}
              disabled={searchBusy}
              className="mt-3 w-full rounded-xl border border-rule py-2.5 text-sm text-ink-faint disabled:opacity-50"
            >
              {searchBusy ? "読み込み中・・・" : `もっと見る（あと${resultTotal - results.length}件）`}
            </button>
          )}
          {appendError && (
            <p className="mt-2 text-center text-[11px] text-vermilion">
              読み込めませんでした。もう一度お試しください。
            </p>
          )}
        </div>
      ) : (
        <>
      <header className="flex items-center justify-between">
        <button
          onClick={() => setMonth(shiftMonth(month, -1))}
          aria-label="前の月"
          className="px-3 py-1 text-lg text-ink-faint active:translate-y-0.5"
        >
          ◀
        </button>
        <h1 className="text-base font-bold tracking-[0.04em]">{fmtMonthJa(month)}</h1>
        {/* C15: 未来月へも送れる（予定を薄字で表示） */}
        <button
          onClick={() => setMonth(shiftMonth(month, 1))}
          aria-label="次の月"
          className="px-3 py-1 text-lg text-ink-faint active:translate-y-0.5"
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

      {/* グラフの内訳から来た時のカテゴリ絞り込み表示（解除でその月の全記録に戻る） */}
      {catFilter && (
        <div className="flex items-center justify-between rounded-xl border border-ink/20 bg-paper px-3 py-2">
          <span className="flex items-center gap-1.5 text-sm font-bold">
            {catInfo?.icon && <CategoryIcon icon={catInfo.icon} className="h-4 w-4 text-ink-faint" />}
            「{catInfo?.name}」で絞り込み中
          </span>
          <button
            onClick={() => setCatFilter(null)}
            className="shrink-0 text-xs text-ink-faint underline underline-offset-2"
          >
            解除
          </button>
        </div>
      )}

      {/* 月の支出合計とその月の記録一覧 */}
      <div className="rounded-3xl border border-rule bg-card p-5 shadow-sm">
        <div className="text-center">
          <p className="text-[11px] tracking-[0.14em] text-ink-faint">支出合計</p>
          <p className="mt-1 text-4xl font-black leading-none tabular-nums">{fmtYen(total)}</p>
          <p className="mt-1 text-[11px] text-ink-faint">{shown.length}件の記録</p>
          {/* C9: ホームは行末✕、履歴はタップ→編集シート内削除。導線の違いを一言で示す */}
          {(shown.length > 0 || (!catFilter && incomes.length > 0)) && (
            <p className="text-[10px] text-ink-faint">記録をタップで編集・削除できます</p>
          )}
          {/* C15: 未来月は予定の合計も添える（カテゴリ絞り込み中は隠す） */}
          {!catFilter && plan && (plan.expenseTotal > 0 || plan.incomeTotal > 0) && (
            <p className="mt-1 text-[11px] text-ink-faint">
              予定：支出 −{fmtYen(plan.expenseTotal)} ・ 収入 +{fmtYen(plan.incomeTotal)}
            </p>
          )}
        </div>

        {/* 収入（シフト給与以外：スクショ収入・仕送り等）。カテゴリ絞り込み中は支出だけに集中するため隠す */}
        {!catFilter && incomes.length > 0 && (
          <section className="mt-4 border-t border-rule pt-4">
            <h2 className="text-sm font-bold tracking-[0.04em] text-sage">その他の収入（バイト給与を除く）</h2>
            <ul className="mt-1">
              {incomes.map((i) => (
                <li key={i.id}>
                  {/* C8: 行タップで支出と同等の編集シート（金額・日付・メモ。削除もシート内から） */}
                  <button
                    onClick={() => setEditingIncome({ ...i })}
                    className="flex w-full items-center gap-3 border-b border-rule/70 py-2.5 text-left"
                  >
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm">{i.memo || "収入"}</p>
                      <p className="text-[11px] text-ink-faint">{fmtDateJa(i.date)}</p>
                    </div>
                    <span className="shrink-0 font-bold tabular-nums text-sage">+{fmtYen(i.amount)}</span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        )}

        {[...byDate.entries()].map(([date, list]) => {
          const dayTotal = list.reduce((s, e) => s + e.amount, 0);
          return (
            <section key={date} className="mt-4 border-t border-rule pt-4">
              <div className="flex items-baseline justify-between">
                <h2 className="text-sm font-bold tracking-[0.04em]">{fmtDateJa(date)}</h2>
                <span className="text-[11px] tabular-nums text-ink-faint">
                  {list.length}件 {fmtYen(dayTotal)}
                </span>
              </div>
              <div className="mt-1">
                {list.map((e) => (
                  /* C7: 行の✕は廃止（誤タップ対策）。タップ→編集シート内から削除する */
                  <button
                    key={e.id}
                    onClick={() => setEditing({ ...e })}
                    className="flex w-full items-center gap-3 border-b border-rule/70 py-2.5 text-left"
                  >
                    <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-paper text-ink-faint">
                      <CategoryIcon icon={e.icon} className="h-5 w-5" />
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm">{e.memo || e.category || "支出"}</p>
                      <p className="text-[11px] text-ink-faint">
                        {e.category}
                        {e.source === "receipt" && "・自動"}
                        {e.source === "recurring" && "・定期"}
                        {e.source === "import" && "・取り込み"}
                      </p>
                    </div>
                    <span className="shrink-0 font-bold tabular-nums">{fmtYen(e.amount)}</span>
                  </button>
                ))}
              </div>
            </section>
          );
        })}
        {/* カテゴリ絞り込み中は「このカテゴリの記録なし」、通常はその月の記録なし */}
        {catFilter
          ? shown.length === 0 && (
              <div className="mt-4 border-t border-rule py-8 pt-8 text-center">
                <p className="text-xs text-ink-faint">
                  この月に「{catInfo?.name}」の記録はありません。
                </p>
              </div>
            )
          : expenses.length === 0 &&
            incomes.length === 0 &&
            planItems.length === 0 && (
              <div className="mt-4 border-t border-rule py-8 pt-8 text-center">
                <p className="text-xs text-ink-faint">この月の記録はありません。</p>
                <Link
                  href="/add"
                  className="mt-3 inline-block rounded-xl border border-ink px-5 py-2 text-sm active:translate-y-0.5"
                >
                  記録する
                </Link>
              </div>
            )}

        {/* C15: 予定（定期・分割・給料日）。カレンダーと同じデータを薄字で表示する（カテゴリ絞り込み中は隠す） */}
        {!catFilter && planItems.length > 0 && (
          <section className="mt-4 border-t border-rule pt-4">
            <h2 className="text-sm font-bold tracking-[0.04em] text-ink-faint">予定（まだ記帳前）</h2>
            <div className="mt-1 opacity-80">
              {planItems.map((p) => (
                <div key={p.key} className="flex items-center gap-3 border-b border-rule/70 py-2.5">
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm text-ink-faint">{p.label}</p>
                    <p className="text-[11px] text-ink-faint">
                      {fmtDateJa(p.date)}
                      {p.sub && `・${p.sub}`}
                    </p>
                  </div>
                  {p.amount > 0 ? (
                    <span className={`shrink-0 font-bold tabular-nums ${p.income ? "text-sage/80" : "text-ink-faint"}`}>
                      {p.income ? "+" : "-"}
                      {fmtYen(p.amount)}
                    </span>
                  ) : (
                    <span className="shrink-0 text-[11px] text-ink-faint">金額未定</span>
                  )}
                </div>
              ))}
            </div>
            <p className="mt-2 text-[10px] text-ink-faint">
              予定はその月が来ると自動で記帳されます（設定 › 定期支出・収入）
            </p>
          </section>
        )}
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
