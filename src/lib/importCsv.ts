// C2: 他アプリからの乗り換えインポート（CSV）。
// Zaim / マネーフォワードME の標準エクスポート列を自動判定してマッピングする。
// どちらでもない場合は「日付・金額（or 収入/支出）・カテゴリ・メモ」のヘッダ名で汎用マッピングを試みる。
// DBに触らない純粋関数のみ（テスト可能）。文字コードの解決（UTF-8/Shift_JIS）は呼び出し側で行う。

export type ImportFormat = "zaim" | "moneyforward" | "generic";

export interface ImportRow {
  date: string; // YYYY-MM-DD
  kind: "expense" | "income";
  amount: number; // 正の整数
  category: string; // 元アプリのカテゴリ名（無ければ ""）
  memo: string; // 店名・内容
}

export interface ImportParseResult {
  format: ImportFormat;
  rows: ImportRow[];
  skipped: number; // 振替・計算対象外・読み取れなかった行数
}

/** RFC4180風のCSVパース（ダブルクォート・クォート内の改行/カンマ対応・BOM除去） */
export function parseCsv(text: string): string[][] {
  const src = text.replace(/^﻿/, "");
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && src[i + 1] === "\n") i++;
      row.push(field);
      field = "";
      if (row.length > 1 || row[0] !== "") rows.push(row);
      row = [];
    } else {
      field += ch;
    }
  }
  row.push(field);
  if (row.length > 1 || row[0] !== "") rows.push(row);
  return rows;
}

/** '2026/7/5'・'2026-07-05'・'2026年7月5日' → '2026-07-05'。解釈できなければ null */
export function normalizeDate(raw: string): string | null {
  const s = raw.trim();
  const m =
    s.match(/^(\d{4})[/\-.](\d{1,2})[/\-.](\d{1,2})/) ??
    s.match(/^(\d{4})年(\d{1,2})月(\d{1,2})日/);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  return `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

/** '1,234'・'-1234'・'¥1,234' → 1234（絶対値・整数）。数値でなければ null */
function parseAmount(raw: string): number | null {
  const s = raw.replace(/[,¥￥\s"]/g, "").trim();
  if (!s) return null;
  const n = Number(s);
  if (!Number.isFinite(n)) return null;
  return Math.round(Math.abs(n));
}

function findCol(header: string[], names: string[]): number {
  for (const name of names) {
    const i = header.findIndex((h) => h.trim() === name);
    if (i >= 0) return i;
  }
  // 完全一致がなければ部分一致（「金額（円）」等の表記ゆれ対応）
  for (const name of names) {
    const i = header.findIndex((h) => h.trim().includes(name));
    if (i >= 0) return i;
  }
  return -1;
}

const MAX_ROWS = 3000;

/**
 * CSV全文 → 取り込み候補行。ヘッダ行から Zaim / マネーフォワード / 汎用 を自動判定する。
 *  - Zaim: 日付, 方法, カテゴリ, …, 品目, メモ, お店, …, 収入, 支出, …（「振替」行はスキップ）
 *  - マネーフォワードME: 計算対象, 日付, 内容, 金額（円）, …, 大項目, 中項目, メモ, 振替, ID
 *  - 汎用: 「日付」と「金額」（または「収入」「支出」）のヘッダがあれば取り込む
 */
export function mapCsv(text: string): ImportParseResult {
  const table = parseCsv(text);
  if (table.length < 2) return { format: "generic", rows: [], skipped: 0 };
  const header = table[0].map((h) => h.trim());
  const body = table.slice(1, 1 + MAX_ROWS);
  const skippedOverflow = Math.max(0, table.length - 1 - MAX_ROWS);

  const dateCol = findCol(header, ["日付", "date", "Date"]);
  if (dateCol < 0) return { format: "generic", rows: [], skipped: body.length + skippedOverflow };

  const isZaim = findCol(header, ["方法"]) >= 0 && findCol(header, ["収入"]) >= 0 && findCol(header, ["支出"]) >= 0;
  const isMf = findCol(header, ["計算対象"]) >= 0 && findCol(header, ["金額（円）", "金額(円)"]) >= 0;
  const format: ImportFormat = isZaim ? "zaim" : isMf ? "moneyforward" : "generic";

  const rows: ImportRow[] = [];
  let skipped = skippedOverflow;
  const push = (date: string | null, kind: "expense" | "income", amount: number | null, category: string, memo: string) => {
    if (!date || amount == null || amount <= 0) {
      skipped++;
      return;
    }
    rows.push({ date, kind, amount, category: category.trim(), memo: memo.trim().slice(0, 100) });
  };

  if (format === "zaim") {
    const method = findCol(header, ["方法"]);
    const cat = findCol(header, ["カテゴリ"]);
    const item = findCol(header, ["品目"]);
    const memo = findCol(header, ["メモ"]);
    const store = findCol(header, ["お店"]);
    const income = findCol(header, ["収入"]);
    const expense = findCol(header, ["支出"]);
    for (const r of body) {
      const m = (r[method] ?? "").trim();
      if (m === "振替" || m === "transfer") {
        skipped++;
        continue;
      }
      const date = normalizeDate(r[dateCol] ?? "");
      const inc = parseAmount(r[income] ?? "");
      const exp = parseAmount(r[expense] ?? "");
      const label = [r[store], r[item], r[memo]].map((v) => (v ?? "").trim()).find((v) => v) ?? "";
      if (exp) push(date, "expense", exp, r[cat] ?? "", label);
      else if (inc) push(date, "income", inc, "", label);
      else skipped++;
    }
    return { format, rows, skipped };
  }

  if (format === "moneyforward") {
    const target = findCol(header, ["計算対象"]);
    const content = findCol(header, ["内容"]);
    const amount = findCol(header, ["金額（円）", "金額(円)"]);
    const catL = findCol(header, ["大項目"]);
    const catM = findCol(header, ["中項目"]);
    const transfer = findCol(header, ["振替"]);
    for (const r of body) {
      if (target >= 0 && (r[target] ?? "").trim() === "0") {
        skipped++;
        continue;
      }
      if (transfer >= 0 && (r[transfer] ?? "").trim() === "1") {
        skipped++;
        continue;
      }
      const date = normalizeDate(r[dateCol] ?? "");
      const rawAmount = (r[amount] ?? "").replace(/[,¥￥\s"]/g, "");
      const n = Number(rawAmount);
      if (!rawAmount || !Number.isFinite(n) || n === 0) {
        skipped++;
        continue;
      }
      const kind = n < 0 ? "expense" : "income";
      const catRaw = ((r[catL] ?? "").trim() || (r[catM] ?? "").trim()).replace(/^未分類$/, "");
      push(date, kind, Math.round(Math.abs(n)), kind === "expense" ? catRaw : "", r[content] ?? "");
    }
    return { format, rows, skipped };
  }

  // 汎用：日付＋（金額 or 収入/支出）＋任意のカテゴリ/メモ/種別
  const amount = findCol(header, ["金額", "amount", "Amount"]);
  const income = findCol(header, ["収入"]);
  const expense = findCol(header, ["支出"]);
  const cat = findCol(header, ["カテゴリ", "category", "Category", "大項目"]);
  const memoCol = findCol(header, ["メモ", "内容", "品目", "店名", "お店", "memo"]);
  const kindCol = findCol(header, ["種別", "タイプ", "type"]);
  if (amount < 0 && income < 0 && expense < 0) {
    return { format, rows: [], skipped: body.length + skippedOverflow };
  }
  for (const r of body) {
    const date = normalizeDate(r[dateCol] ?? "");
    const memo = memoCol >= 0 ? (r[memoCol] ?? "") : "";
    const category = cat >= 0 ? (r[cat] ?? "") : "";
    if (amount >= 0) {
      const rawAmount = (r[amount] ?? "").replace(/[,¥￥\s"]/g, "");
      const n = Number(rawAmount);
      if (!rawAmount || !Number.isFinite(n) || n === 0) {
        skipped++;
        continue;
      }
      // 種別列があればそれに従う。無ければ「マイナス=支出、プラス=支出扱い」（家計簿CSVの大半は支出）
      const kindText = kindCol >= 0 ? (r[kindCol] ?? "").trim() : "";
      const kind: "expense" | "income" = kindText.includes("収入") ? "income" : "expense";
      push(date, kind, Math.round(Math.abs(n)), kind === "expense" ? category : "", memo);
      continue;
    }
    const inc = income >= 0 ? parseAmount(r[income] ?? "") : null;
    const exp = expense >= 0 ? parseAmount(r[expense] ?? "") : null;
    if (exp) push(date, "expense", exp, category, memo);
    else if (inc) push(date, "income", inc, "", memo);
    else skipped++;
  }
  return { format, rows, skipped };
}

/**
 * CSVバイト列 → テキスト。UTF-8で読んで文字化け（U+FFFD）が出たら Shift_JIS で読み直す
 * （Zaim/マネーフォワードのエクスポートは Shift_JIS の場合がある）。
 */
export function decodeCsvBuffer(buf: Uint8Array): string {
  const utf8 = new TextDecoder("utf-8").decode(buf);
  if (!utf8.includes("�")) return utf8;
  try {
    return new TextDecoder("shift_jis").decode(buf);
  } catch {
    return utf8;
  }
}

/**
 * 元アプリのカテゴリ名 → このアプリのカテゴリID。
 * 完全一致 → 別名テーブル → 部分一致 の順でゆるく解決（見つからなければ null=カテゴリなし）。
 */
export function resolveCategoryId(
  raw: string,
  categories: { id: string; name: string }[],
): string | null {
  const name = raw.trim();
  if (!name) return null;
  const exact = categories.find((c) => c.name === name);
  if (exact) return exact.id;
  // 他アプリの代表的なカテゴリ名 → デフォルトカテゴリ名
  const ALIASES: [RegExp, string][] = [
    [/食|グルメ|外食|カフェ|飲料/, "食費"],
    [/交通|電車|バス|タクシー|ガソリン|自動車/, "交通"],
    [/趣味|娯楽|遊び|レジャー|ゲーム|書籍?・?漫画/, "娯楽"],
    [/日用品|消耗品|ドラッグ|生活用品/, "日用品"],
    [/交際|飲み会|プレゼント|冠婚葬祭/, "交際"],
    [/サブスク|定期購入|会費/, "サブスク"],
    [/衣服|洋服|ファッション|服飾/, "洋服"],
    [/美容|理容|コスメ|化粧/, "美容"],
    [/医療|健康|病院|薬/, "医療"],
    [/旅行|宿泊|ホテル/, "旅行"],
    [/教育|教養|学習|本|書籍/, "学び"],
    [/住まい|住宅|家賃|水道|光熱|電気|ガス/, "住まい"],
    [/通信|スマホ|携帯|ネット/, "通信"],
  ];
  for (const [re, target] of ALIASES) {
    if (re.test(name)) {
      const hit = categories.find((c) => c.name === target);
      if (hit) return hit.id;
    }
  }
  const partial = categories.find((c) => name.includes(c.name) || c.name.includes(name));
  return partial?.id ?? null;
}
