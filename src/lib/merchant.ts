// マーチャント学習：同じ店でAIカテゴリ分類を二度と間違えないための仕組み。
// - ユーザーがAI提案と違うカテゴリで保存 → merchant_categories に upsert（学習）
// - 次回以降、同じ店名の読取結果には AI提案より学習値を優先して適用
// あわせて、スキャン/ショートカット自動保存の重複ガード（同一日付×金額×memo）もここに置く。
// sqlite / Postgres 両対応（`?` プレースホルダ・ON CONFLICT 構文は両方言共通）。
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
export async function learnMerchantCategory(userId: string, merchant: string, categoryId: string) {
  const key = normalizeMerchant(merchant);
  if (!key || !categoryId) return;
  const d = await db();
  await d.run(
    `INSERT INTO merchant_categories (user_id, merchant, category_id, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT (user_id, merchant) DO UPDATE SET category_id = excluded.category_id, updated_at = excluded.updated_at`,
    userId,
    key,
    categoryId,
    Date.now(),
  );
}

/** 学習済みカテゴリを引く（カテゴリが削除済みなら無視するため categories と JOIN） */
export async function learnedCategoryId(userId: string, merchant: string): Promise<string | null> {
  const key = normalizeMerchant(merchant);
  if (!key) return null;
  const d = await db();
  const row = await d.get<{ category_id: string }>(
    `SELECT mc.category_id FROM merchant_categories mc
     JOIN categories c ON c.id = mc.category_id AND c.user_id = mc.user_id
     WHERE mc.user_id = ? AND mc.merchant = ?`,
    userId,
    key,
  );
  return row?.category_id ?? null;
}

/** 同一ユーザー×同一日付×同一金額×同一memo の支出が既にあるか（スキャン系の二重登録防止） */
export async function duplicateExpenseExists(
  userId: string,
  date: string,
  amount: number,
  memo: string,
): Promise<boolean> {
  const d = await db();
  const row = await d.get(
    "SELECT id FROM expenses WHERE user_id = ? AND date = ? AND amount = ? AND memo = ? LIMIT 1",
    userId,
    date,
    amount,
    memo.trim(),
  );
  return !!row;
}

/** 同一ユーザー×同一日付×同一金額×同一memo の収入が既にあるか */
export async function duplicateIncomeExists(
  userId: string,
  date: string,
  amount: number,
  memo: string,
): Promise<boolean> {
  const d = await db();
  const row = await d.get(
    "SELECT id FROM incomes WHERE user_id = ? AND date = ? AND amount = ? AND memo = ? LIMIT 1",
    userId,
    date,
    amount,
    memo.trim(),
  );
  return !!row;
}

export const DUPLICATE_MESSAGE = "⚠️同じ内容が既に記録されています（同じ日付・金額・メモ）。";

// ショートカット自動保存は対話できないので常にブロック。ただし「本当に2回買った」救済ルートを案内する。
export const DUPLICATE_SHORTCUT_MESSAGE =
  "⚠️同じ内容が既に記録されています。本当に2回支払った場合は、アプリのスキャン画面から読み取ると確認のうえ記録できます。";
