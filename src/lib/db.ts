// サーバー専用：Node 24 組み込みの node:sqlite（DatabaseSync）。
// better-sqlite3 はネイティブビルドが必要（このPCにVS C++無し）なので組み込み実装を使う。
// 家計簿は月次集計・カテゴリ別 GROUP BY が本質なので、CookSync の JSON 全読みではなく SQLite を採用。
// 身内数人・単一サーバー前提なので同時書き込みの考慮は不要。
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";

const DIR = path.join(process.cwd(), ".data");
const FILE = path.join(DIR, "cashsync.db");

let _db: DatabaseSync | null = null;

export function db(): DatabaseSync {
  if (_db) return _db;
  fs.mkdirSync(DIR, { recursive: true });
  _db = new DatabaseSync(FILE);
  _db.exec("PRAGMA journal_mode = WAL");
  // Windowsのウイルススキャン等が一瞬ファイルを掴んでもエラーにせず最大5秒待つ
  _db.exec("PRAGMA busy_timeout = 5000");
  migrate(_db);
  backupDaily(_db);
  return _db;
}

// 起動のたびに1日1回、DBをバックアップ（直近7世代保持）。
// 誤削除・破損からの復旧用。WALをチェックポイントしてから本体ファイルをコピーする。
function backupDaily(d: DatabaseSync) {
  try {
    const today = new Date();
    const stamp = `${today.getFullYear()}${String(today.getMonth() + 1).padStart(2, "0")}${String(today.getDate()).padStart(2, "0")}`;
    const dir = path.join(DIR, "backup");
    fs.mkdirSync(dir, { recursive: true });
    const dest = path.join(dir, `cashsync-${stamp}.db`);
    if (fs.existsSync(dest)) return;
    d.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    fs.copyFileSync(FILE, dest);
    const olds = fs
      .readdirSync(dir)
      .filter((f) => /^cashsync-\d{8}\.db$/.test(f))
      .sort()
      .slice(0, -7);
    for (const f of olds) fs.rmSync(path.join(dir, f), { force: true });
  } catch {
    /* バックアップ失敗でアプリは止めない */
  }
}

function migrate(d: DatabaseSync) {
  d.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      email TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS categories (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      name TEXT NOT NULL,
      icon TEXT NOT NULL DEFAULT '',
      sort INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS expenses (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      date TEXT NOT NULL,
      amount INTEGER NOT NULL,
      category_id TEXT,
      memo TEXT NOT NULL DEFAULT '',
      source TEXT NOT NULL DEFAULT 'manual',
      receipt_id TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_expenses_user_date ON expenses(user_id, date);
    CREATE TABLE IF NOT EXISTS receipts (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      store TEXT NOT NULL DEFAULT '',
      taken_date TEXT NOT NULL,
      total INTEGER NOT NULL,
      items_json TEXT NOT NULL DEFAULT '[]',
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS incomes (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      date TEXT NOT NULL,
      amount INTEGER NOT NULL,
      type TEXT NOT NULL DEFAULT 'other',
      memo TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_incomes_user_date ON incomes(user_id, date);
    CREATE TABLE IF NOT EXISTS jobs (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      name TEXT NOT NULL,
      weekday_rate INTEGER NOT NULL,
      weekend_holiday_rate INTEGER NOT NULL,
      transport_per_shift INTEGER NOT NULL DEFAULT 0,
      calendar_keywords TEXT NOT NULL DEFAULT ''
    );
    CREATE TABLE IF NOT EXISTS shifts (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      job_id TEXT NOT NULL,
      date TEXT NOT NULL,
      start_min INTEGER NOT NULL,
      end_min INTEGER NOT NULL,
      break_min INTEGER NOT NULL DEFAULT 0,
      source TEXT NOT NULL DEFAULT 'manual'
    );
    CREATE INDEX IF NOT EXISTS idx_shifts_user_date ON shifts(user_id, date);
    CREATE TABLE IF NOT EXISTS recurring_items (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      kind TEXT NOT NULL,               -- 'expense' | 'income'
      name TEXT NOT NULL,
      amount INTEGER NOT NULL,
      category_id TEXT,
      start_month TEXT NOT NULL,        -- 'YYYY-MM'
      end_month TEXT,                   -- null = 無期限
      post_day INTEGER NOT NULL DEFAULT 1
    );
    CREATE TABLE IF NOT EXISTS recurring_posts (
      recurring_id TEXT NOT NULL,
      month TEXT NOT NULL,              -- 計上済み月 'YYYY-MM'（冪等性のための記録）
      PRIMARY KEY (recurring_id, month)
    );
    CREATE TABLE IF NOT EXISTS quick_presets (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      label TEXT NOT NULL,
      amount INTEGER NOT NULL,
      category_id TEXT,
      sort INTEGER NOT NULL DEFAULT 0
    );
  `);
  d.exec(`
    CREATE TABLE IF NOT EXISTS category_budgets (
      user_id TEXT NOT NULL,
      category_id TEXT NOT NULL,
      amount INTEGER NOT NULL,          -- 月あたりの予算（袋分けポケット）
      PRIMARY KEY (user_id, category_id)
    );
    CREATE TABLE IF NOT EXISTS push_subscriptions (
      endpoint TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      subscription TEXT NOT NULL,       -- PushSubscription のJSON
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS monthly_reviews (
      user_id TEXT NOT NULL,
      month TEXT NOT NULL,              -- 'YYYY-MM'
      report TEXT NOT NULL,             -- AI生成レポートのJSON
      created_at INTEGER NOT NULL,
      PRIMARY KEY (user_id, month)
    );
  `);
  // 追加カラムのマイグレーション（既存DBにも効くよう ALTER を冪等に流す）
  addColumn(d, "users", "savings_goal INTEGER NOT NULL DEFAULT 0"); // 先取り貯金の月目標
  addColumn(d, "users", "api_token TEXT"); // iPhoneショートカット連携用トークン
  addColumn(d, "jobs", "calendar_exclude TEXT NOT NULL DEFAULT ''"); // カレンダー取り込みの除外ワード
  addColumn(d, "jobs", "color TEXT NOT NULL DEFAULT ''"); // 掛け持ちバイトの色分け
  addColumn(d, "jobs", "closing_day INTEGER NOT NULL DEFAULT 31"); // 給与の締め日（31=末日）
  addColumn(d, "jobs", "pay_month_offset INTEGER NOT NULL DEFAULT 0"); // 0=当月払い, 1=翌月払い
  addColumn(d, "jobs", "pay_day INTEGER NOT NULL DEFAULT 25"); // 支払日（カレンダー表示用）
  addColumn(d, "jobs", "pay_same_day INTEGER NOT NULL DEFAULT 0"); // 1=当日払い（働いた日にその場で支給）
  addColumn(d, "users", "last_overspend_push TEXT"); // 使いすぎ通知の最終送信日（1日1回制限）
}

// 掛け持ちバイトの色パレット（紙背景で判別しやすい順）
export const JOB_COLORS = ["#e8442e", "#2f6b9e", "#2f8f5b", "#8a5fbf", "#9a6b00"];

function addColumn(d: DatabaseSync, table: string, colDef: string) {
  try {
    d.exec(`ALTER TABLE ${table} ADD COLUMN ${colDef}`);
  } catch {
    /* 既に存在 */
  }
}

export const DEFAULT_CATEGORIES: { name: string; icon: string }[] = [
  { name: "食費", icon: "🍚" },
  { name: "交通", icon: "🚃" },
  { name: "娯楽", icon: "🎮" },
  { name: "日用品", icon: "🧻" },
  { name: "交際", icon: "🍻" },
  { name: "サブスク", icon: "🔁" },
  { name: "洋服", icon: "👕" },
  { name: "美容", icon: "💄" },
  { name: "医療", icon: "💊" },
  { name: "旅行", icon: "✈️" },
  { name: "学び", icon: "📚" },
  { name: "住まい", icon: "🏠" },
  { name: "通信", icon: "📱" },
  { name: "その他", icon: "🧾" },
];

export function seedCategories(userId: string) {
  const d = db();
  const ins = d.prepare(
    "INSERT INTO categories (id, user_id, name, icon, sort) VALUES (?, ?, ?, ?, ?)",
  );
  DEFAULT_CATEGORIES.forEach((c, i) =>
    ins.run(globalThis.crypto.randomUUID(), userId, c.name, c.icon, i),
  );
}

export function uid(): string {
  return globalThis.crypto.randomUUID();
}
