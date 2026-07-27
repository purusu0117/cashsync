"use client";

// 記録の編集シート（履歴・カレンダーで共有）。
// C7: 削除はこのシート内から行い、削除後は親がUndoつきトーストを出す（undo は削除前の内容で復元）。
// C8: 収入にも支出と同等の編集シート（金額・日付・メモ）。
import { useState } from "react";
import { CategoryIcon } from "@/components/Icons";
import { apiCall, apiJson } from "@/lib/clientApi";
import { todayLocal } from "@/lib/format";

export interface EditableExpense {
  id: string;
  date: string;
  amount: number;
  memo: string;
  category_id: string | null;
  source?: string;
  receipt_id?: string | null;
}

export interface EditableIncome {
  id: string;
  date: string;
  amount: number;
  memo: string;
}

interface SheetCategory {
  id: string;
  name: string;
  icon: string;
}

/** 削除した記録を元に戻す（Undo）ための再作成リクエストを組み立てる */
function restoreExpense(e: EditableExpense): Promise<unknown> {
  return apiCall(
    "/api/expenses",
    apiJson({
      amount: e.amount,
      date: e.date,
      memo: e.memo,
      categoryId: e.category_id,
      source: e.source ?? "manual",
      receiptId: e.receipt_id ?? null,
    }),
  );
}

export function ExpenseEditSheet({
  expense,
  categories,
  onClose,
  onSaved,
  onDeleted,
  onDuplicated,
}: {
  expense: EditableExpense;
  categories: SheetCategory[];
  onClose: () => void;
  /** PUT成功後（親が再読込＋完了トーストを出す） */
  onSaved: () => void;
  /** DELETE成功後。undo() は削除前の内容で復元する */
  onDeleted: (undo: () => Promise<unknown>) => void;
  /** 「もう一度」（同じ内容を今日の日付で記録）。undo() は作った記録を削除する。省略時はボタン非表示 */
  onDuplicated?: (undo: () => Promise<unknown>) => void;
}) {
  const [draft, setDraft] = useState<EditableExpense>({ ...expense });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function save() {
    setBusy(true);
    setError("");
    try {
      await apiCall(
        "/api/expenses",
        apiJson(
          {
            id: draft.id,
            date: draft.date,
            amount: draft.amount,
            categoryId: draft.category_id,
            memo: draft.memo,
          },
          "PUT",
        ),
      );
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : "保存に失敗しました。");
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    setBusy(true);
    setError("");
    try {
      await apiCall(`/api/expenses?id=${expense.id}`, { method: "DELETE" });
      onDeleted(() => restoreExpense(expense));
    } catch (e) {
      setError(e instanceof Error ? e.message : "削除に失敗しました。");
    } finally {
      setBusy(false);
    }
  }

  async function duplicate() {
    setBusy(true);
    setError("");
    try {
      const d = await apiCall<{ id: string }>(
        "/api/expenses",
        apiJson({
          amount: draft.amount,
          date: todayLocal(),
          categoryId: draft.category_id,
          memo: draft.memo,
          source: "manual",
        }),
      );
      onDuplicated?.(() => apiCall(`/api/expenses?id=${d.id}`, { method: "DELETE" }));
    } catch (e) {
      setError(e instanceof Error ? e.message : "登録に失敗しました。");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-[60] flex items-end bg-ink/40" onClick={onClose}>
      <div
        className="zig zig-t mx-auto max-h-[85dvh] w-full max-w-md overflow-y-auto px-5 pb-8 pt-5"
        onClick={(e) => e.stopPropagation()}
      >
        <p className="dot text-center text-xs text-ink-faint">＊ 編集 ＊</p>
        <div className="mt-3 space-y-3">
          <input
            type="number"
            inputMode="numeric"
            value={draft.amount || ""}
            onChange={(e) => setDraft({ ...draft, amount: Number(e.target.value) })}
            className="dot w-full rounded-md border border-rule bg-paper px-3 py-2 text-2xl tabular-nums outline-none focus:border-ink"
          />
          <input
            type="date"
            value={draft.date}
            onChange={(e) => setDraft({ ...draft, date: e.target.value })}
            className="w-full rounded-md border border-rule bg-paper px-3 py-2 text-base outline-none focus:border-ink"
          />
          <div className="flex flex-wrap gap-1.5">
            {categories.map((c) => (
              <button
                key={c.id}
                onClick={() => setDraft({ ...draft, category_id: c.id })}
                className={`flex items-center gap-1 rounded-full border px-3 py-1 text-sm ${
                  draft.category_id === c.id
                    ? "border-vermilion bg-vermilion text-card"
                    : "border-rule bg-paper"
                }`}
              >
                <CategoryIcon icon={c.icon} className="h-4 w-4" /> {c.name}
              </button>
            ))}
          </div>
          <input
            value={draft.memo}
            onChange={(e) => setDraft({ ...draft, memo: e.target.value })}
            placeholder="メモ"
            className="w-full rounded-md border border-rule bg-paper px-3 py-2 text-base outline-none focus:border-ink"
          />
        </div>
        {error && <p className="mt-2 text-sm text-vermilion">{error}</p>}
        <div className="mt-4 flex gap-2">
          <button
            onClick={remove}
            disabled={busy}
            className="rounded-md border border-vermilion px-4 py-3 text-sm text-vermilion disabled:opacity-50"
          >
            削除
          </button>
          {onDuplicated && (
            <button
              onClick={duplicate}
              disabled={busy}
              className="flex-1 rounded-md border border-rule py-3 text-sm disabled:opacity-50"
              title="同じ内容で今日の日付で記録"
            >
              もう一度
            </button>
          )}
          <button
            onClick={save}
            disabled={busy}
            className="dot flex-1 rounded-md bg-vermilion py-3 text-base text-card shadow-[0_2px_0_var(--vermilion-deep)] disabled:opacity-50"
          >
            保存
          </button>
        </div>
      </div>
    </div>
  );
}

export function IncomeEditSheet({
  income,
  onClose,
  onSaved,
  onDeleted,
}: {
  income: EditableIncome;
  onClose: () => void;
  onSaved: () => void;
  onDeleted: (undo: () => Promise<unknown>) => void;
}) {
  const [draft, setDraft] = useState<EditableIncome>({ ...income });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function save() {
    setBusy(true);
    setError("");
    try {
      await apiCall(
        "/api/incomes",
        apiJson({ id: draft.id, date: draft.date, amount: draft.amount, memo: draft.memo }, "PUT"),
      );
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : "保存に失敗しました。");
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    setBusy(true);
    setError("");
    try {
      await apiCall(`/api/incomes?id=${income.id}`, { method: "DELETE" });
      onDeleted(() =>
        apiCall(
          "/api/incomes",
          apiJson({ amount: income.amount, date: income.date, memo: income.memo }),
        ),
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : "削除に失敗しました。");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-[60] flex items-end bg-ink/40" onClick={onClose}>
      <div
        className="zig zig-t mx-auto w-full max-w-md px-5 pb-8 pt-5"
        onClick={(e) => e.stopPropagation()}
      >
        <p className="dot text-center text-xs text-sage">＊ 収入の編集 ＊</p>
        <div className="mt-3 space-y-3">
          <input
            type="number"
            inputMode="numeric"
            value={draft.amount || ""}
            onChange={(e) => setDraft({ ...draft, amount: Number(e.target.value) })}
            className="dot w-full rounded-md border border-rule bg-paper px-3 py-2 text-2xl tabular-nums outline-none focus:border-ink"
          />
          <input
            type="date"
            value={draft.date}
            onChange={(e) => setDraft({ ...draft, date: e.target.value })}
            className="w-full rounded-md border border-rule bg-paper px-3 py-2 text-base outline-none focus:border-ink"
          />
          <input
            value={draft.memo}
            onChange={(e) => setDraft({ ...draft, memo: e.target.value })}
            placeholder="メモ（仕送り・お小遣いなど）"
            className="w-full rounded-md border border-rule bg-paper px-3 py-2 text-base outline-none focus:border-ink"
          />
        </div>
        {error && <p className="mt-2 text-sm text-vermilion">{error}</p>}
        <div className="mt-4 flex gap-2">
          <button
            onClick={remove}
            disabled={busy}
            className="rounded-md border border-vermilion px-4 py-3 text-sm text-vermilion disabled:opacity-50"
          >
            削除
          </button>
          <button
            onClick={save}
            disabled={busy}
            className="dot flex-1 rounded-md bg-sage py-3 text-base text-card shadow-[0_2px_0_#1f6b42] disabled:opacity-50"
          >
            保存
          </button>
        </div>
      </div>
    </div>
  );
}
