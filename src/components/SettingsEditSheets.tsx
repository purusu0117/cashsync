"use client";

// B7: 設定画面の編集シート（バイト先・カテゴリ・かんたん入力ボタン）。
// 追加フォームと同じ入力項目を下からのシートで出し、既存レコードを更新する。
import { useState } from "react";
import { CategoryIcon } from "@/components/Icons";
import { apiCall, apiJson } from "@/lib/clientApi";
import { CATEGORY_ICON_KEYS, DEFAULT_CATEGORY_ICON } from "@/lib/categoryIcons";

const input =
  "rounded-md border border-rule bg-paper px-3 py-2 text-base outline-none focus:border-ink";

function Sheet({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  return (
    <div className="fixed inset-0 z-[60] flex items-end bg-ink/40" onClick={onClose}>
      <div
        className="zig zig-t mx-auto max-h-[85dvh] w-full max-w-md overflow-y-auto px-5 pb-8 pt-5"
        onClick={(e) => e.stopPropagation()}
      >
        <p className="dot text-center text-xs text-ink-faint">＊ {title} ＊</p>
        {children}
      </div>
    </div>
  );
}

function SheetButtons({
  busy,
  error,
  onCancel,
  onSave,
  disabled,
}: {
  busy: boolean;
  error: string;
  onCancel: () => void;
  onSave: () => void;
  disabled?: boolean;
}) {
  return (
    <>
      {error && <p className="mt-2 text-sm text-vermilion">{error}</p>}
      <div className="mt-4 flex gap-2">
        <button
          onClick={onCancel}
          disabled={busy}
          className="flex-1 rounded-md border border-rule py-3 text-sm text-ink-faint disabled:opacity-50"
        >
          やめる
        </button>
        <button
          onClick={onSave}
          disabled={busy || disabled}
          className="dot flex-[2] rounded-md bg-vermilion py-3 text-base text-card shadow-[0_2px_0_var(--vermilion-deep)] disabled:opacity-50"
        >
          {busy ? "保存中・・・" : "保存"}
        </button>
      </div>
    </>
  );
}

// --- バイト先（名前・時給・締め日・支払月・支払日） ---
export interface EditableJob {
  id: string;
  name: string;
  weekday_rate: number;
  weekend_holiday_rate: number;
  closing_day: number;
  pay_month_offset: number;
  pay_day: number;
  pay_same_day: number;
}

export function JobEditSheet({
  job,
  onClose,
  onSaved,
}: {
  job: EditableJob;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState(job.name);
  const [wdRate, setWdRate] = useState(String(job.weekday_rate || ""));
  const [weRate, setWeRate] = useState(String(job.weekend_holiday_rate || ""));
  const [closing, setClosing] = useState(String(job.closing_day));
  const [payOffset, setPayOffset] = useState(
    job.pay_same_day ? "same" : String(job.pay_month_offset),
  );
  const [payDay, setPayDay] = useState(String(job.pay_day));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  // 追加フォームの選択肢に無い既存値（任意の日）はそのまま選択肢に含めて保持する
  const closingOpts = Array.from(new Set(["31", "10", "15", "20", "25", closing]));
  const payDayOpts = Array.from(new Set(["10", "15", "20", "25", "31", payDay]));
  // 締め日は payPeriodFor が 28以上を月末締め扱いにするため 28〜31 を「末日」表示のまま。
  // 支払日（給料日）は daysInMonth にクランプされる実挙動なので 31 のときだけ「末日」。
  const closingLabel = (d: string) => (Number(d) >= 28 ? "末日" : `${d}日`);
  const payLabel = (d: string) => (Number(d) >= 31 ? "末日" : `${d}日`);

  async function save() {
    setBusy(true);
    setError("");
    try {
      await apiCall(
        "/api/jobs",
        apiJson({
          id: job.id,
          name,
          weekdayRate: Number(wdRate),
          weekendHolidayRate: Number(weRate || wdRate),
          closingDay: Number(closing) || 31,
          payMonthOffset: payOffset === "same" ? 0 : Number(payOffset),
          payDay: Number(payDay),
          paySameDay: payOffset === "same",
        }),
      );
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : "保存に失敗しました。");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Sheet title="バイト先の編集" onClose={onClose}>
      <div className="mt-3 grid grid-cols-2 gap-2">
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="バイト先名"
          className={`${input} col-span-2`}
        />
        <input
          type="number"
          inputMode="numeric"
          value={wdRate}
          onChange={(e) => setWdRate(e.target.value)}
          placeholder="平日時給"
          className={`${input} tabular-nums`}
        />
        <input
          type="number"
          inputMode="numeric"
          value={weRate}
          onChange={(e) => setWeRate(e.target.value)}
          placeholder="土日祝時給"
          className={`${input} tabular-nums`}
        />
        <select value={closing} onChange={(e) => setClosing(e.target.value)} className={input}>
          {closingOpts.map((d) => (
            <option key={d} value={d}>
              {closingLabel(d)}締め
            </option>
          ))}
        </select>
        <select value={payOffset} onChange={(e) => setPayOffset(e.target.value)} className={input}>
          <option value="0">当月払い</option>
          <option value="1">翌月払い</option>
          <option value="same">当日払い</option>
        </select>
        {payOffset !== "same" && (
          <select
            value={payDay}
            onChange={(e) => setPayDay(e.target.value)}
            className={`${input} col-span-2`}
          >
            {payDayOpts.map((d) => (
              <option key={d} value={d}>
                支払日：{payLabel(d)}
              </option>
            ))}
          </select>
        )}
      </div>
      <SheetButtons
        busy={busy}
        error={error}
        onCancel={onClose}
        onSave={save}
        disabled={!name.trim() || !Number(wdRate)}
      />
    </Sheet>
  );
}

// --- カテゴリ（名前・アイコン） ---
export interface EditableCategory {
  id: string;
  name: string;
  icon: string;
}

export function CategoryEditSheet({
  category,
  onClose,
  onSaved,
}: {
  category: EditableCategory;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState(category.name);
  const [icon, setIcon] = useState(category.icon || DEFAULT_CATEGORY_ICON);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function save() {
    setBusy(true);
    setError("");
    try {
      await apiCall("/api/categories", apiJson({ id: category.id, name, icon }, "PUT"));
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : "保存に失敗しました。");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Sheet title="カテゴリの編集" onClose={onClose}>
      <div className="mt-3 space-y-3">
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="カテゴリ名"
          className={`${input} w-full`}
        />
        <div>
          <p className="text-[11px] text-ink-faint">アイコン</p>
          <div className="mt-1 grid grid-cols-8 gap-1">
            {[DEFAULT_CATEGORY_ICON, ...CATEGORY_ICON_KEYS].map((k) => (
              <button
                key={k}
                onClick={() => setIcon(k)}
                aria-label={`アイコン ${k}`}
                className={`rounded-md border p-1.5 ${
                  icon === k ? "border-ink bg-card text-ink" : "border-rule bg-paper text-ink-faint"
                }`}
              >
                <CategoryIcon icon={k} className="mx-auto h-5 w-5" />
              </button>
            ))}
          </div>
        </div>
      </div>
      <SheetButtons
        busy={busy}
        error={error}
        onCancel={onClose}
        onSave={save}
        disabled={!name.trim()}
      />
    </Sheet>
  );
}

// --- かんたん入力ボタン（名前・金額・カテゴリ） ---
export interface EditablePreset {
  id: string;
  label: string;
  amount: number;
  category_id: string | null;
}

export function PresetEditSheet({
  preset,
  categories,
  onClose,
  onSaved,
}: {
  preset: EditablePreset;
  categories: EditableCategory[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [label, setLabel] = useState(preset.label);
  const [amount, setAmount] = useState(String(preset.amount || ""));
  const [categoryId, setCategoryId] = useState(preset.category_id ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function save() {
    setBusy(true);
    setError("");
    try {
      await apiCall(
        "/api/presets",
        apiJson(
          { id: preset.id, label, amount: Number(amount), categoryId: categoryId || null },
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

  return (
    <Sheet title="かんたん入力ボタンの編集" onClose={onClose}>
      <div className="mt-3 space-y-3">
        <input
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          placeholder="名前（例：Suicaチャージ）"
          maxLength={20}
          className={`${input} w-full`}
        />
        <input
          type="number"
          inputMode="numeric"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          placeholder="金額"
          className={`${input} w-full tabular-nums`}
        />
        <select
          value={categoryId}
          onChange={(e) => setCategoryId(e.target.value)}
          className={`${input} w-full`}
        >
          <option value="">カテゴリなし</option>
          {categories.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
      </div>
      <SheetButtons
        busy={busy}
        error={error}
        onCancel={onClose}
        onSave={save}
        disabled={!label.trim() || !(Number(amount) > 0)}
      />
    </Sheet>
  );
}
