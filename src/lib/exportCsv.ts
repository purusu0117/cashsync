// B10: データのエクスポート（支出・収入・シフトをまとめたCSV）。
// Excelで文字化けしないよう UTF-8 BOM 付きで出力する。
// 列: 日付,種別,金額,カテゴリ,メモ,入力方法
import { db } from "./db";
import { type JobRow, type ShiftRow, shiftPay } from "./money";

const EXPENSE_SOURCE_LABELS: Record<string, string> = {
  manual: "手入力",
  receipt: "レシート読取",
  voice: "音声",
  quick: "かんたん入力",
  recurring: "定期",
  text: "文章入力",
  import: "取り込み",
};

const INCOME_TYPE_LABELS: Record<string, string> = {
  other: "手入力",
  recurring: "定期",
  import: "取り込み",
};

const SHIFT_SOURCE_LABELS: Record<string, string> = {
  manual: "手入力",
  calendar: "カレンダー取込",
  sync: "シフト同期",
  text: "文章入力",
};

function csvField(v: string | number): string {
  const s = String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function minToHHMM(min: number): string {
  const m = ((min % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
}

export interface ExportRow {
  date: string;
  kind: "支出" | "収入" | "シフト給与";
  amount: number;
  category: string;
  memo: string;
  source: string;
}

/** 期間内（両端含む・省略時は全期間）の支出・収入・シフトをまとめて日付順で返す */
export function collectExportRows(userId: string, start?: string, end?: string): ExportRow[] {
  const d = db();
  const cond = (col: string) =>
    `${start ? ` AND ${col} >= '${start}'` : ""}${end ? ` AND ${col} <= '${end}'` : ""}`;
  // 期間はバリデーション済みの YYYY-MM-DD のみ許可（呼び出し側で検証）だが、念のため形式を再確認
  for (const v of [start, end]) {
    if (v && !/^\d{4}-\d{2}-\d{2}$/.test(v)) throw new Error("invalid period");
  }
  const rows: ExportRow[] = [];
  const expenses = d
    .prepare(
      `SELECT e.date, e.amount, e.memo, e.source, c.name AS category
       FROM expenses e LEFT JOIN categories c ON c.id = e.category_id AND c.user_id = e.user_id
       WHERE e.user_id = ?${cond("e.date")} ORDER BY e.date`,
    )
    .all(userId) as unknown as {
    date: string;
    amount: number;
    memo: string;
    source: string;
    category: string | null;
  }[];
  for (const e of expenses) {
    rows.push({
      date: e.date,
      kind: "支出",
      amount: e.amount,
      category: e.category ?? "",
      memo: e.memo,
      source: EXPENSE_SOURCE_LABELS[e.source] ?? e.source,
    });
  }
  const incomes = d
    .prepare(
      `SELECT date, amount, type, memo FROM incomes WHERE user_id = ?${cond("date")} ORDER BY date`,
    )
    .all(userId) as unknown as { date: string; amount: number; type: string; memo: string }[];
  for (const i of incomes) {
    rows.push({
      date: i.date,
      kind: "収入",
      amount: i.amount,
      category: "",
      memo: i.memo,
      source: INCOME_TYPE_LABELS[i.type] ?? i.type,
    });
  }
  const jobs = new Map(
    (
      d
        .prepare(
          "SELECT id, name, weekday_rate, weekend_holiday_rate, transport_per_shift, closing_day, pay_month_offset FROM jobs WHERE user_id = ?",
        )
        .all(userId) as unknown as JobRow[]
    ).map((j) => [j.id, j]),
  );
  const shifts = d
    .prepare(
      `SELECT s.id, s.job_id, s.date, s.start_min, s.end_min, s.break_min, s.source FROM shifts s WHERE s.user_id = ?${cond("s.date")} ORDER BY s.date`,
    )
    .all(userId) as unknown as (ShiftRow & { source: string })[];
  for (const s of shifts) {
    const job = jobs.get(s.job_id);
    rows.push({
      date: s.date,
      kind: "シフト給与",
      amount: job ? shiftPay(s, job) : 0,
      category: "",
      memo: `${job?.name ?? "バイト"} ${minToHHMM(s.start_min)}〜${minToHHMM(s.end_min)}`,
      source: SHIFT_SOURCE_LABELS[s.source] ?? s.source,
    });
  }
  rows.sort((a, b) => a.date.localeCompare(b.date));
  return rows;
}

/** ExportRow[] → BOM付きCSV文字列 */
export function toCsv(rows: ExportRow[]): string {
  const lines = ["日付,種別,金額,カテゴリ,メモ,入力方法"];
  for (const r of rows) {
    lines.push(
      [r.date, r.kind, r.amount, r.category, r.memo, r.source].map(csvField).join(","),
    );
  }
  return `﻿${lines.join("\r\n")}\r\n`;
}
