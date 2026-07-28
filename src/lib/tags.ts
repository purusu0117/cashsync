// 横断タグのドメインロジック（サーバー専用・db を触る）。
// カテゴリ（1支出＝1軸）とは独立した多対多のラベル付け。既存の支出フローには一切割り込まない：
// タグ操作は expense_tags テーブルだけを触り、tagIds が渡されない限り何もしない。
import { db, uid } from "./db";
import { monthRange, type MonthRange } from "./money";

export interface TagRow {
  id: string;
  name: string;
  sort: number;
  count: number; // 付与されている支出の件数
}

export interface TagSpend {
  id: string;
  name: string;
  amount: number; // 期間内でこのタグが付いた支出の合計
  count: number; // 期間内の件数
}

/** タグ名の正規化（前後空白除去・連続空白を1つに）。空なら空文字 */
export function normalizeTagName(name: string): string {
  return (name ?? "").replace(/\s+/g, " ").trim();
}

/** タグ一覧（使用回数つき・sort順） */
export async function listTags(userId: string): Promise<TagRow[]> {
  const d = await db();
  const rows = await d.all<TagRow>(
    `SELECT t.id, t.name, t.sort, CAST(COUNT(et.expense_id) AS INTEGER) AS count
     FROM tags t LEFT JOIN expense_tags et ON et.tag_id = t.id
     WHERE t.user_id = ?
     GROUP BY t.id, t.name, t.sort
     ORDER BY t.sort, t.name`,
    userId,
  );
  return rows.map((r) => ({ ...r, sort: Number(r.sort), count: Number(r.count) }));
}

/** タグ作成（同名は作らず既存を返す）。空名は null */
export async function createTag(userId: string, name: string): Promise<{ id: string } | null> {
  const n = normalizeTagName(name);
  if (!n) return null;
  const d = await db();
  const existing = await d.get<{ id: string }>(
    "SELECT id FROM tags WHERE user_id = ? AND name = ?",
    userId,
    n,
  );
  if (existing) return { id: existing.id };
  const max = (await d.get<{ m: number }>(
    "SELECT COALESCE(MAX(sort), -1) AS m FROM tags WHERE user_id = ?",
    userId,
  )) as { m: number };
  const id = uid();
  await d.run(
    "INSERT INTO tags (id, user_id, name, sort, created_at) VALUES (?, ?, ?, ?, ?)",
    id,
    userId,
    n,
    Number(max.m) + 1,
    Date.now(),
  );
  return { id };
}

/** タグ改名（本人のみ）。成功で true */
export async function renameTag(userId: string, id: string, name: string): Promise<boolean> {
  const n = normalizeTagName(name);
  if (!n) return false;
  const d = await db();
  const r = await d.run("UPDATE tags SET name = ? WHERE id = ? AND user_id = ?", n, id, userId);
  return r.changes > 0;
}

/** タグの並べ替え（渡された順に sort を振り直す。本人のもののみ） */
export async function reorderTags(userId: string, orderedIds: string[]): Promise<void> {
  const ids = (orderedIds ?? []).filter((x) => typeof x === "string" && x);
  if (ids.length === 0) return;
  const d = await db();
  await d.transaction(async (tx) => {
    for (let i = 0; i < ids.length; i++) {
      await tx.run("UPDATE tags SET sort = ? WHERE id = ? AND user_id = ?", i, ids[i], userId);
    }
  });
}

/** タグ削除（本人のみ）。expense_tags の紐付けも掃除する。成功で true */
export async function deleteTag(userId: string, id: string): Promise<boolean> {
  const d = await db();
  const own = await d.get("SELECT id FROM tags WHERE id = ? AND user_id = ?", id, userId);
  if (!own) return false;
  await d.transaction(async (tx) => {
    await tx.run("DELETE FROM expense_tags WHERE tag_id = ?", id);
    await tx.run("DELETE FROM tags WHERE id = ? AND user_id = ?", id, userId);
  });
  return true;
}

/** tagIds のうち本人所有だけを重複除去して返す（順序は tags.sort）。他人IDの混入を防ぐ */
export async function ownTagIds(userId: string, tagIds: string[]): Promise<string[]> {
  const ids = [...new Set((tagIds ?? []).filter((x) => typeof x === "string" && x))];
  if (ids.length === 0) return [];
  const d = await db();
  const ph = ids.map(() => "?").join(",");
  const rows = await d.all<{ id: string }>(
    `SELECT id FROM tags WHERE user_id = ? AND id IN (${ph}) ORDER BY sort, name`,
    userId,
    ...ids,
  );
  return rows.map((r) => r.id);
}

/**
 * 支出に付いたタグID一覧（本人の支出・本人のタグに限定）。編集シートの初期選択用。
 */
export async function getExpenseTagIds(userId: string, expenseId: string): Promise<string[]> {
  const d = await db();
  const rows = await d.all<{ tag_id: string }>(
    `SELECT et.tag_id FROM expense_tags et
     JOIN tags t ON t.id = et.tag_id AND t.user_id = ?
     JOIN expenses e ON e.id = et.expense_id AND e.user_id = ?
     WHERE et.expense_id = ?
     ORDER BY t.sort, t.name`,
    userId,
    userId,
    expenseId,
  );
  return rows.map((r) => r.tag_id);
}

/**
 * 支出のタグを「完全に張り替える」。呼ばれた時点で expense_tags を tagIds の内容に一致させる。
 * ※ この関数は tagIds が明示された時だけ呼ぶこと。呼ばなければ既存の紐付けは一切変わらない。
 * 支出が本人のものでない場合は何もせず false。
 */
export async function setExpenseTags(
  userId: string,
  expenseId: string,
  tagIds: string[],
): Promise<boolean> {
  const d = await db();
  const own = await d.get("SELECT id FROM expenses WHERE id = ? AND user_id = ?", expenseId, userId);
  if (!own) return false;
  const valid = await ownTagIds(userId, tagIds);
  await d.transaction(async (tx) => {
    await tx.run("DELETE FROM expense_tags WHERE expense_id = ?", expenseId);
    for (const t of valid) {
      await tx.run(
        "INSERT INTO expense_tags (expense_id, tag_id) VALUES (?, ?) ON CONFLICT (expense_id, tag_id) DO NOTHING",
        expenseId,
        t,
      );
    }
  });
  return true;
}

/** 指定した集計月（締め日基準）における、タグ別の支出合計。全タグを返す（未使用は amount=0） */
export async function tagSpend(
  userId: string,
  month: string,
): Promise<{ month: string; range: MonthRange; stats: TagSpend[] }> {
  const d = await db();
  const range = await monthRange(userId, month);
  const rows = await d.all<TagSpend>(
    `SELECT t.id, t.name,
            COALESCE(SUM(e.amount), 0) AS amount,
            CAST(COUNT(e.id) AS INTEGER) AS count
     FROM tags t
     LEFT JOIN expense_tags et ON et.tag_id = t.id
     LEFT JOIN expenses e ON e.id = et.expense_id AND e.user_id = t.user_id
       AND e.date >= ? AND e.date <= ?
     WHERE t.user_id = ?
     GROUP BY t.id, t.name, t.sort
     ORDER BY amount DESC, t.sort`,
    range.start,
    range.end,
    userId,
  );
  return {
    month,
    range,
    stats: rows.map((r) => ({ ...r, amount: Number(r.amount), count: Number(r.count) })),
  };
}
