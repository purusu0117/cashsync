// 資産・口座残高の手動管理のドメインロジック（サーバー専用・next非依存）。
// 競合（マネフォ/Moneytree）との差＝ストック（資産）管理を、銀行連携なしの手入力で埋める。
// 既存の支出/収入/予算のフロー計算とは完全に独立（accounts / account_snapshots のみを触る）。
// Route Handler から薄く呼び、テストスイート（scripts/test-suite.ts）からも直接テストできるようにここへ集約する。
import { db, uid } from "./db";
import { currentMonth } from "./money";

export const ACCOUNT_KINDS = ["bank", "cash", "emoney", "securities", "debt"] as const;
export type AccountKind = (typeof ACCOUNT_KINDS)[number];

export interface AccountRow {
  id: string;
  name: string;
  kind: AccountKind;
  balance: number;
  sort: number;
}

export interface TrendPoint {
  month: string; // 'YYYY-MM'
  netWorth: number;
}

/** 未知の種別は 'bank' に落とす */
export function normalizeKind(k: unknown): AccountKind {
  return typeof k === "string" && (ACCOUNT_KINDS as readonly string[]).includes(k)
    ? (k as AccountKind)
    : "bank";
}

/**
 * 保存する残高（整数円）。
 * 負債（debt）は「借りている額」を正の大きさで保持する（純資産計算で符号反転して減算するため）。
 * 符号ミス入力（debtにマイナス）でも純資産が壊れないよう abs で正規化する。
 */
export function normalizeBalance(kind: AccountKind, balance: unknown): number {
  const n = Math.round(Number(balance));
  if (!Number.isFinite(n)) return 0;
  return kind === "debt" ? Math.abs(n) : n;
}

/** 資産合計 − 負債合計（kind='debt' は減算） */
export function netWorthOf(accounts: { kind: string; balance: number }[]): number {
  return accounts.reduce(
    (s, a) => s + (a.kind === "debt" ? -Number(a.balance) : Number(a.balance)),
    0,
  );
}

const SIGNED_BALANCE = "CASE WHEN a.kind = 'debt' THEN -s.balance ELSE s.balance END";

/** 口座一覧（sort順） */
export async function listAccounts(userId: string): Promise<AccountRow[]> {
  const d = await db();
  const rows = await d.all<AccountRow>(
    "SELECT id, name, kind, balance, sort FROM accounts WHERE user_id = ? ORDER BY sort, created_at",
    userId,
  );
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    kind: normalizeKind(r.kind),
    balance: Number(r.balance),
    sort: Number(r.sort),
  }));
}

/** ある口座の指定月スナップショットを upsert（sqlite/postgres 共通の ON CONFLICT DO UPDATE） */
export async function upsertSnapshot(accountId: string, month: string, balance: number) {
  const d = await db();
  await d.run(
    `INSERT INTO account_snapshots (account_id, month, balance) VALUES (?, ?, ?)
     ON CONFLICT (account_id, month) DO UPDATE SET balance = excluded.balance`,
    accountId,
    month,
    Math.round(balance),
  );
}

/**
 * 当月スナップショットを全口座ぶん現在残高で upsert（冪等）。
 * 「今月の純資産」が常に最新残高＝推移の直近点と一致するようにする。GET のたびに軽く同期する。
 */
export async function syncCurrentSnapshots(userId: string, month = currentMonth()) {
  const d = await db();
  await d.run(
    `INSERT INTO account_snapshots (account_id, month, balance)
     SELECT id, ?, balance FROM accounts WHERE user_id = ?
     ON CONFLICT (account_id, month) DO UPDATE SET balance = excluded.balance`,
    month,
    userId,
  );
}

/** 指定月のスナップショットから計算した純資産。その月にスナップショットが無ければ null */
export async function snapshotNetWorth(userId: string, month: string): Promise<number | null> {
  const d = await db();
  const row = await d.get<{ nw: number; c: number }>(
    `SELECT COALESCE(SUM(${SIGNED_BALANCE}), 0) AS nw, COUNT(*) AS c
     FROM account_snapshots s JOIN accounts a ON a.id = s.account_id
     WHERE a.user_id = ? AND s.month = ?`,
    userId,
    month,
  );
  if (!row || Number(row.c) === 0) return null;
  return Number(row.nw);
}

/**
 * 直近 months ヶ月の月次純資産（スナップショットを持っている月だけ・古い順）。
 * 無い月は前後補間せず、スナップショットがある月のみを返す。
 */
export async function netWorthTrend(userId: string, months = 12): Promise<TrendPoint[]> {
  const d = await db();
  const limit = Math.min(Math.max(1, Math.round(months)), 60);
  const rows = await d.all<{ month: string; nw: number }>(
    `SELECT s.month AS month, COALESCE(SUM(${SIGNED_BALANCE}), 0) AS nw
     FROM account_snapshots s JOIN accounts a ON a.id = s.account_id
     WHERE a.user_id = ?
     GROUP BY s.month ORDER BY s.month DESC LIMIT ${limit}`,
    userId,
  );
  return rows
    .map((r) => ({ month: r.month, netWorth: Number(r.nw) }))
    .reverse();
}

/** 口座作成（末尾sort）。作成時に当月スナップショットを upsert */
export async function createAccount(
  userId: string,
  input: { name: string; kind?: unknown; balance?: unknown },
): Promise<string> {
  const d = await db();
  const kind = normalizeKind(input.kind);
  const balance = normalizeBalance(kind, input.balance);
  const max = (await d.get<{ m: number }>(
    "SELECT COALESCE(MAX(sort), -1) AS m FROM accounts WHERE user_id = ?",
    userId,
  )) as { m: number };
  const id = uid();
  await d.run(
    "INSERT INTO accounts (id, user_id, name, kind, balance, sort, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    id,
    userId,
    input.name,
    kind,
    balance,
    Number(max.m) + 1,
    Date.now(),
  );
  await upsertSnapshot(id, currentMonth(), balance);
  return id;
}

/**
 * 口座更新（name/kind/balance/sort）。存在しなければ false。
 * balance が変化したら当月スナップショットを upsert（＝「今月の純資産」が最新残高を反映）。
 */
export async function updateAccount(
  userId: string,
  id: string,
  input: { name?: string; kind?: unknown; balance?: unknown; sort?: unknown },
): Promise<boolean> {
  const d = await db();
  const cur = await d.get<{ balance: number; kind: string }>(
    "SELECT balance, kind FROM accounts WHERE id = ? AND user_id = ?",
    id,
    userId,
  );
  if (!cur) return false;
  const kind = input.kind === undefined ? normalizeKind(cur.kind) : normalizeKind(input.kind);
  const name = typeof input.name === "string" && input.name.trim() ? input.name.trim() : undefined;
  const balance = input.balance === undefined ? Number(cur.balance) : normalizeBalance(kind, input.balance);
  const sort =
    input.sort === undefined || !Number.isFinite(Number(input.sort))
      ? undefined
      : Math.round(Number(input.sort));
  await d.run(
    `UPDATE accounts SET name = COALESCE(?, name), kind = ?, balance = ?, sort = COALESCE(?, sort)
     WHERE id = ? AND user_id = ?`,
    name ?? null,
    kind,
    balance,
    sort ?? null,
    id,
    userId,
  );
  if (balance !== Number(cur.balance)) {
    await upsertSnapshot(id, currentMonth(), balance);
  }
  return true;
}

/** 口座削除（そのユーザーのもののみ）。スナップショットも消す */
export async function deleteAccount(userId: string, id: string): Promise<boolean> {
  const d = await db();
  const cur = await d.get<{ id: string }>(
    "SELECT id FROM accounts WHERE id = ? AND user_id = ?",
    id,
    userId,
  );
  if (!cur) return false;
  await d.run("DELETE FROM account_snapshots WHERE account_id = ?", id);
  await d.run("DELETE FROM accounts WHERE id = ? AND user_id = ?", id, userId);
  return true;
}

export interface AccountsOverview {
  accounts: AccountRow[];
  netWorth: number;
  prevNetWorth: number | null;
  trend: TrendPoint[];
}

/** GET 用：一覧＋純資産＋前月比＋推移。当月スナップショットを最新残高に同期してから集計する */
export async function accountsOverview(userId: string): Promise<AccountsOverview> {
  await syncCurrentSnapshots(userId);
  const accounts = await listAccounts(userId);
  const netWorth = netWorthOf(accounts);
  const prevNetWorth = await snapshotNetWorth(userId, prevMonth(currentMonth()));
  const trend = await netWorthTrend(userId, 12);
  return { accounts, netWorth, prevNetWorth, trend };
}

function prevMonth(month: string): string {
  const [y, m] = month.split("-").map(Number);
  const d = new Date(y, m - 2, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

/** 資産(口座残高)は手入力なので、任意で「毎月◯日に残高を更新しましょう」の通知を出す。有効な設定値は -1(OFF) と 1〜28。 */
export function isValidAssetReminderDay(day: number): boolean {
  return day === -1 || (Number.isInteger(day) && day >= 1 && day <= 28);
}

/**
 * 資産更新リマインドを今日送るべきか（純ロジック・DB非依存でテストしやすい形）。
 *  - assetReminderDay が今日の日（JST・1〜28）に一致
 *  - lastAssetReminder が当月でない（月1回制限）
 *  - 口座を1件以上持っている
 * のすべてを満たすときだけ true。-1(OFF) や口座0件では常に false。
 */
export function shouldSendAssetReminder(params: {
  assetReminderDay: number; // 1〜28＝その日に通知、-1＝OFF
  todayDay: number; // JSTの今日（1〜31）
  lastAssetReminder: string | null; // 最終送信月 'YYYY-MM'
  currentMonth: string; // 当月 'YYYY-MM'
  accountCount: number; // 保有口座数
}): boolean {
  const { assetReminderDay, todayDay, lastAssetReminder, currentMonth, accountCount } = params;
  if (assetReminderDay < 1 || assetReminderDay > 28) return false; // OFF・不正値
  if (accountCount <= 0) return false; // 口座がない人には出さない
  if (lastAssetReminder === currentMonth) return false; // 今月はもう送った
  return assetReminderDay === todayDay;
}
