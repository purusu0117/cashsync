// マーチャント学習：同じ店でAIカテゴリ分類を二度と間違えないための仕組み。
// - ユーザーがAI提案と違うカテゴリで保存 → merchant_categories に upsert（学習）
// - 次回以降、同じ店名の読取結果には AI提案より学習値を優先して適用
// あわせて、スキャン/ショートカット自動保存の重複ガード（同一日付×金額×memo）もここに置く。
import { createHash } from "node:crypto";
import { db } from "./db";

/** 店名の正規化：trim・全角英数記号→半角・全角スペース→半角・連続空白を1つに・小文字化 */
export function normalizeMerchant(raw: string): string {
  return raw
    .trim()
    .replace(/[！-～]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
    .replace(/　/g, " ")
    .replace(/\s+/g, " ")
    .toLowerCase();
}

/** 店名→カテゴリの学習を保存（同じ店は常に最新の判断で上書き） */
export function learnMerchantCategory(userId: string, merchant: string, categoryId: string) {
  const key = normalizeMerchant(merchant);
  if (!key || !categoryId) return;
  db()
    .prepare(
      `INSERT INTO merchant_categories (user_id, merchant, category_id, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(user_id, merchant) DO UPDATE SET category_id = excluded.category_id, updated_at = excluded.updated_at`,
    )
    .run(userId, key, categoryId, Date.now());
}

/** 学習済みカテゴリを引く（カテゴリが削除済みなら無視するため categories と JOIN） */
export function learnedCategoryId(userId: string, merchant: string): string | null {
  const key = normalizeMerchant(merchant);
  if (!key) return null;
  const row = db()
    .prepare(
      `SELECT mc.category_id FROM merchant_categories mc
       JOIN categories c ON c.id = mc.category_id AND c.user_id = mc.user_id
       WHERE mc.user_id = ? AND mc.merchant = ?`,
    )
    .get(userId, key) as { category_id: string } | undefined;
  return row?.category_id ?? null;
}

/** 同一ユーザー×同一日付×同一金額×同一memo の支出が既にあるか（スキャン系の二重登録防止） */
export function duplicateExpenseExists(
  userId: string,
  date: string,
  amount: number,
  memo: string,
): boolean {
  const row = db()
    .prepare("SELECT id FROM expenses WHERE user_id = ? AND date = ? AND amount = ? AND memo = ? LIMIT 1")
    .get(userId, date, amount, memo.trim());
  return !!row;
}

/** 同一ユーザー×同一日付×同一金額×同一memo の収入が既にあるか */
export function duplicateIncomeExists(
  userId: string,
  date: string,
  amount: number,
  memo: string,
): boolean {
  const row = db()
    .prepare("SELECT id FROM incomes WHERE user_id = ? AND date = ? AND amount = ? AND memo = ? LIMIT 1")
    .get(userId, date, amount, memo.trim());
  return !!row;
}

export const DUPLICATE_MESSAGE = "⚠️同じ内容が既に記録されています（同じ日付・金額・メモ）。";

// ショートカット自動保存は対話できないので常にブロック。ただし「本当に2回買った」救済ルートを案内する。
export const DUPLICATE_SHORTCUT_MESSAGE =
  "⚠️同じ内容が既に記録されています。本当に2回支払った場合は、アプリのスキャン画面から読み取ると確認のうえ記録できます。";

// ---------------------------------------------------------------------------
// 画像ハッシュによる二度読み判定。
// 「同じ日・同じ金額・同じ店」は本当に2回支払うことがある（Steamで6,100円を2回など）ので、
// それを理由にブロックすると正当な支出が黙って消える。判定は「まったく同じ画像を送ったか」で行う。
// ---------------------------------------------------------------------------

/** 画像バイト列 → sha256（16進） */
export function imageHashOf(buf: Uint8Array): string {
  return createHash("sha256").update(buf).digest("hex");
}

export interface RecordedImage {
  kind: "expense" | "income";
  date: string;
  amount: number;
  memo: string;
}

/** 同じ画像から作られた記録が既にあるか（あれば内容を返す。無ければ null） */
export function recordedImage(userId: string, hash: string): RecordedImage | null {
  if (!hash) return null;
  const d = db();
  const r = d
    .prepare(
      "SELECT taken_date AS date, total AS amount, store AS memo FROM receipts WHERE user_id = ? AND image_hash = ? LIMIT 1",
    )
    .get(userId, hash) as { date: string; amount: number; memo: string } | undefined;
  if (r) return { kind: "expense", date: r.date, amount: Number(r.amount), memo: r.memo };
  const i = d
    .prepare(
      "SELECT date, amount, memo FROM incomes WHERE user_id = ? AND image_hash = ? LIMIT 1",
    )
    .get(userId, hash) as { date: string; amount: number; memo: string } | undefined;
  if (i) return { kind: "income", date: i.date, amount: Number(i.amount), memo: i.memo };
  return null;
}
