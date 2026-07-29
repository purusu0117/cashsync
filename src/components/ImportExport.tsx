"use client";

// B10: データのエクスポート（CSV） ＋ C2: 他のアプリから引っ越し（CSV/スクショ取り込み）。
// 設定画面のセクションとして使う。プレビュー → 選択 → 一括登録の流れで、勝手に保存しない。
import { useEffect, useRef, useState } from "react";
import { cachedFetch, clearApiCache } from "@/lib/cachedFetch";
import { netFetch } from "@/lib/clientApi";
import { fmtYen, todayLocal } from "@/lib/format";
import { isNativePlatform } from "@/lib/native";

interface Category {
  id: string;
  name: string;
  icon: string;
}

interface PreviewRow {
  date: string;
  kind: "expense" | "income";
  amount: number;
  category: string;
  categoryId: string | null;
  memo: string;
}

interface Preview {
  format: string;
  rows: PreviewRow[];
  skipped: number;
}

const FORMAT_LABELS: Record<string, string> = {
  zaim: "Zaim形式",
  moneyforward: "マネーフォワード形式",
  generic: "CSV",
  scan: "スクショ読み取り",
};

const input =
  "rounded-md border border-rule bg-paper px-3 py-2 text-base outline-none focus:border-ink";
const addBtn =
  "rounded-xl border border-ink px-4 py-2 text-sm font-semibold active:translate-y-0.5 disabled:opacity-40";

export function ExportSection() {
  const [period, setPeriod] = useState<"all" | "year" | "month">("all");
  const [month, setMonth] = useState(todayLocal().slice(0, 7));

  function download() {
    let url = "/api/export";
    if (period === "year") {
      const y = todayLocal().slice(0, 4);
      url += `?start=${y}-01-01&end=${y}-12-31`;
    } else if (period === "month") {
      url += `?start=${month}-01&end=${month}-31`;
    }
    // Content-Disposition: attachment なので画面遷移せずダウンロードされる
    location.href = url;
  }

  return (
    <section id="export" className="rounded-2xl border border-rule bg-card p-4 shadow-sm">
      <h2 className="text-sm font-bold tracking-[0.04em]">データのエクスポート</h2>
      <p className="mt-0.5 text-[11px] leading-relaxed text-ink-faint">
        支出・収入・シフトをまとめたCSVをダウンロードします（Excelでそのまま開けます）。
      </p>
      <div className="mt-2 flex gap-2">
        <select
          value={period}
          onChange={(e) => setPeriod(e.target.value as "all" | "year" | "month")}
          className={`${input} min-w-0 flex-1`}
        >
          <option value="all">全期間</option>
          <option value="year">今年</option>
          <option value="month">月を指定</option>
        </select>
        {period === "month" && (
          <input
            type="month"
            value={month}
            onChange={(e) => setMonth(e.target.value)}
            className={`${input} min-w-0 flex-1`}
          />
        )}
        <button onClick={download} className={addBtn}>
          ダウンロード
        </button>
      </div>
    </section>
  );
}

export function ImportSection() {
  const csvRef = useRef<HTMLInputElement>(null);
  const imgRef = useRef<HTMLInputElement>(null);
  const [categories, setCategories] = useState<Category[]>([]);
  const [busy, setBusy] = useState<"" | "csv" | "scan" | "commit">("");
  const [elapsed, setElapsed] = useState(0);
  const [error, setError] = useState("");
  const [preview, setPreview] = useState<Preview | null>(null);
  const [checked, setChecked] = useState<boolean[]>([]);
  const [doneMsg, setDoneMsg] = useState("");

  useEffect(() => {
    cachedFetch<{ categories?: Category[] }>("/api/categories", (d) =>
      setCategories(d.categories ?? []),
    ).catch(() => {});
  }, []);

  // スクショAI読み取り中の経過秒（固まっていない安心感）
  useEffect(() => {
    if (busy !== "scan") return;
    const t = setInterval(() => setElapsed((s) => s + 1), 1000);
    return () => clearInterval(t);
  }, [busy]);

  const catName = (id: string | null) => categories.find((c) => c.id === id)?.name ?? null;

  async function upload(kind: "csv" | "scan", file: File) {
    setError("");
    setDoneMsg("");
    setElapsed(0);
    setBusy(kind);
    try {
      const form = new FormData();
      form.append(kind === "csv" ? "file" : "image", file);
      const res = await netFetch(kind === "csv" ? "/api/import" : "/api/import/scan", {
        method: "POST",
        body: form,
      });
      const d = await res.json();
      if (!res.ok) throw new Error(d.error ?? "読み取りに失敗しました。");
      setPreview(d as Preview);
      setChecked((d as Preview).rows.map(() => true));
    } catch (e) {
      setError(e instanceof Error ? e.message : "読み取りに失敗しました。");
    } finally {
      setBusy("");
    }
  }

  function onFile(e: React.ChangeEvent<HTMLInputElement>, kind: "csv" | "scan") {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (file) upload(kind, file);
  }

  async function commit() {
    if (!preview) return;
    const rows = preview.rows.filter((_, i) => checked[i]);
    if (rows.length === 0) return;
    setError("");
    setBusy("commit");
    try {
      const res = await netFetch("/api/import/commit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rows }),
      });
      const d = await res.json();
      if (!res.ok) throw new Error(d.error ?? "登録に失敗しました。");
      clearApiCache(); // 取り込んだ分を全画面に反映
      setPreview(null);
      setDoneMsg(
        `${d.expenses + d.incomes}件を取り込みました（支出${d.expenses}件・収入${d.incomes}件）`,
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : "登録に失敗しました。");
    } finally {
      setBusy("");
    }
  }

  const checkedCount = checked.filter(Boolean).length;
  const allChecked = !!preview && checkedCount === preview.rows.length;
  const expTotal =
    preview?.rows.reduce((s, r, i) => (checked[i] && r.kind === "expense" ? s + r.amount : s), 0) ??
    0;
  const incTotal =
    preview?.rows.reduce((s, r, i) => (checked[i] && r.kind === "income" ? s + r.amount : s), 0) ??
    0;

  return (
    <section id="import" className="rounded-2xl border border-rule bg-card p-4 shadow-sm">
      <h2 className="text-sm font-bold tracking-[0.04em]">他のアプリから引っ越し</h2>
      <p className="mt-0.5 text-[11px] leading-relaxed text-ink-faint">
        {isNativePlatform()
          ? "Zaim・マネーフォワードなどのCSVから記録を取り込めます。登録前に内容を確認できます。"
          : "Zaim・マネーフォワードなどのCSV、または他アプリの履歴画面のスクショから記録を取り込めます。登録前に内容を確認できます。"}
      </p>
      <input
        ref={csvRef}
        type="file"
        accept=".csv,text/csv,text/plain"
        onChange={(e) => onFile(e, "csv")}
        className="hidden"
      />
      <input
        ref={imgRef}
        type="file"
        accept="image/*"
        onChange={(e) => onFile(e, "scan")}
        className="hidden"
      />
      <div className="mt-2 grid grid-cols-1 gap-2">
        <button
          onClick={() => csvRef.current?.click()}
          disabled={busy !== ""}
          className={`${addBtn} w-full`}
        >
          {busy === "csv" ? "読み込み中・・・" : "CSVファイルを取り込む"}
        </button>
        {/* スクショのAI読み取りはサーバーのClaudeを使うため、ネイティブ版（API不使用方針）では非表示。CSV取り込みは端末内処理なので残す。 */}
        {!isNativePlatform() && (
          <button
            onClick={() => imgRef.current?.click()}
            disabled={busy !== ""}
            className={`${addBtn} w-full`}
          >
            {busy === "scan" ? `AIが読み取り中・・・（${elapsed}秒）` : "アプリ画面のスクショをAIで読み取る"}
          </button>
        )}
      </div>
      {error && <p className="mt-2 text-xs text-vermilion">{error}</p>}
      {doneMsg && <p className="mt-2 text-xs text-sage">{doneMsg}</p>}

      {/* プレビュー（選択して一括登録） */}
      {preview && (
        <div
          className="fixed inset-0 z-50 flex items-end bg-ink/40"
          onClick={() => busy !== "commit" && setPreview(null)}
        >
          <div
            className="mx-auto flex max-h-[85dvh] w-full max-w-md flex-col rounded-t-2xl bg-card px-5 pb-6 pt-5 shadow-sm"
            onClick={(e) => e.stopPropagation()}
          >
            <p className="text-center text-sm font-bold tracking-[0.04em]">取り込みプレビュー</p>
            <p className="mt-1 text-center text-[11px] text-ink-faint">
              {FORMAT_LABELS[preview.format] ?? preview.format}・{preview.rows.length}件を検出
              {preview.skipped > 0 && `（${preview.skipped}行は読み取れずスキップ）`}
            </p>
            <div className="mt-2 flex items-baseline text-xs">
              <button
                onClick={() => setChecked(preview.rows.map(() => !allChecked))}
                className="text-ink-faint underline underline-offset-2"
              >
                {allChecked ? "全部はずす" : "全部えらぶ"}
              </button>
              <span className="leader" />
              <span className="font-bold tabular-nums">
                支出 −{fmtYen(expTotal)} ・ 収入 +{fmtYen(incTotal)}
              </span>
            </div>
            <ul className="mt-2 min-h-0 flex-1 overflow-y-auto border-t border-rule pt-2">
              {preview.rows.map((r, i) => (
                <li key={i}>
                  <label className="flex items-baseline gap-2 py-1.5 text-sm">
                    <input
                      type="checkbox"
                      checked={checked[i] ?? false}
                      onChange={() =>
                        setChecked((cs) => cs.map((c, j) => (j === i ? !c : c)))
                      }
                      className="h-4 w-4 shrink-0 self-center accent-[var(--vermilion)]"
                    />
                    <span className="shrink-0 text-[11px] text-ink-faint tabular-nums">
                      {r.date.slice(2).replace(/-/g, "/")}
                    </span>
                    <span className="min-w-0 truncate">{r.memo || r.category || "記録"}</span>
                    {r.kind === "expense" && (
                      <span className="shrink-0 text-[10px] text-ink-faint">
                        {catName(r.categoryId) ?? "カテゴリなし"}
                      </span>
                    )}
                    <span className="leader" />
                    <span
                      className={`shrink-0 font-bold tabular-nums ${r.kind === "income" ? "text-sage" : ""}`}
                    >
                      {r.kind === "income" ? "+" : "-"}
                      {fmtYen(r.amount)}
                    </span>
                  </label>
                </li>
              ))}
            </ul>
            <div className="mt-3 flex shrink-0 gap-2">
              <button
                onClick={() => setPreview(null)}
                disabled={busy === "commit"}
                className="flex-1 rounded-md border border-rule py-3 text-sm text-ink-faint"
              >
                やめる
              </button>
              <button
                onClick={commit}
                disabled={busy === "commit" || checkedCount === 0}
                className="flex-[2] rounded-xl bg-vermilion py-3 text-sm font-bold text-card shadow-sm active:translate-y-0.5 active:shadow-none disabled:opacity-50"
              >
                {busy === "commit" ? "登録中・・・" : `${checkedCount}件を取り込む`}
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
