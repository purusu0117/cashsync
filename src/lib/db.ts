// サーバー専用：Node 24 組み込みの node:sqlite（DatabaseSync）。
// better-sqlite3 はネイティブビルドが必要（このPCにVS C++無し）なので組み込み実装を使う。
// 家計簿は月次集計・カテゴリ別 GROUP BY が本質なので、CookSync の JSON 全読みではなく SQLite を採用。
// 身内数人・単一サーバー前提なので同時書き込みの考慮は不要。
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import { migrateCategoryRow } from "./categoryIcons";

// CASHSYNC_DB_PATH はテスト・マイグレーション検証用の上書き。既定は従来どおり .data/cashsync.db
const FILE = process.env.CASHSYNC_DB_PATH || path.join(process.cwd(), ".data", "cashsync.db");
const DIR = path.dirname(FILE);

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
    CREATE TABLE IF NOT EXISTS merchant_categories (
      user_id TEXT NOT NULL,
      merchant TEXT NOT NULL,           -- 正規化済み店名（trim・小文字化・全角英数→半角）
      category_id TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (user_id, merchant)
    );
    CREATE TABLE IF NOT EXISTS ai_usage (
      user_id TEXT NOT NULL,
      ym TEXT NOT NULL,                 -- 'YYYY-MM'
      scans INTEGER NOT NULL DEFAULT 0, -- レシート/スクショ読み取り回数
      parses INTEGER NOT NULL DEFAULT 0,-- 自然文パース回数
      PRIMARY KEY (user_id, ym)
    );
    CREATE TABLE IF NOT EXISTS password_resets (
      token_hash TEXT PRIMARY KEY,      -- リセットトークンの sha256（平文トークンは保存しない）
      user_id TEXT NOT NULL,
      expires_at INTEGER NOT NULL,      -- 有効期限（発行から1時間）
      used_at INTEGER                   -- 使用済み時刻（NULL=未使用）
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
  addColumn(d, "recurring_items", "interval TEXT NOT NULL DEFAULT 'monthly'"); // 'monthly' | 'yearly'（年払いサブスク対応）
  addColumn(d, "users", "plan TEXT NOT NULL DEFAULT 'free'"); // 'free' | 'premium' | 'founder'（cloud版と表示互換のため）
  addColumn(d, "categories", "icon TEXT NOT NULL DEFAULT ''"); // 旧DB（icon列なし）向け
  addColumn(d, "users", "month_start_day INTEGER NOT NULL DEFAULT 1"); // B9: 家計簿の月の開始日（1〜28。25なら7/25〜8/24が「8月」）
  addColumn(d, "recurring_items", "is_fixed INTEGER NOT NULL DEFAULT 1"); // C12: 1=固定費（先取り対象）, 0=変動費扱い
  addColumn(d, "expenses", "recurring_id TEXT"); // C12: どの定期から計上されたか（固定/変動の判定用。旧レコードはNULL=固定扱い）
  addColumn(d, "category_budgets", "carryover INTEGER NOT NULL DEFAULT 0"); // C13: 1=前月の余りを当月予算に繰り越す
  addColumn(d, "users", "reminder_hour INTEGER NOT NULL DEFAULT -1"); // C3: 記録リマインダーの時刻（0〜23時。-1=OFF）
  addColumn(d, "users", "last_reminder_push TEXT"); // C3: リマインダーの最終送信日（1日1回制限）
  // 同じ「画像そのもの」を二度読みしたときだけ弾くための sha256（同額・同店の別の支払いは弾かない）
  addColumn(d, "receipts", "image_hash TEXT");
  addColumn(d, "incomes", "image_hash TEXT");
  addColumn(d, "users", "record_push INTEGER NOT NULL DEFAULT 1"); // 記録できたら通知する（既定ON）
  migrateCategoryIcons(d);
}

/**
 * 既存カテゴリの絵文字を一掃するマイグレーション（冪等・起動時に毎回流してよい）。
 *  - name: 絵文字を除去（「サブスク🔁」→「サブスク」）
 *  - icon: 旧絵文字/空 → アイコンキー（'subscription' 等。独自カテゴリは 'tag'）
 * AI分類プロンプトへ渡すカテゴリ名（SELECT name FROM categories）もこれで綺麗になる。
 */
export function migrateCategoryIcons(d: DatabaseSync): number {
  const rows = d.prepare("SELECT id, name, icon FROM categories").all() as {
    id: string;
    name: string;
    icon: string;
  }[];
  const upd = d.prepare("UPDATE categories SET name = ?, icon = ? WHERE id = ?");
  let changed = 0;
  for (const r of rows) {
    const m = migrateCategoryRow(r.name, r.icon ?? "");
    if (!m) continue;
    upd.run(m.name, m.icon, r.id);
    changed++;
  }
  return changed;
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

// icon はキー文字列（categoryIcons.ts のアイコンキー）。絵文字はDBに保存しない。
export const DEFAULT_CATEGORIES: { name: string; icon: string }[] = [
  { name: "食費", icon: "food" },
  { name: "交通", icon: "transport" },
  { name: "娯楽", icon: "fun" },
  { name: "日用品", icon: "daily" },
  { name: "交際", icon: "social" },
  { name: "サブスク", icon: "subscription" },
  { name: "洋服", icon: "clothes" },
  { name: "美容", icon: "beauty" },
  { name: "医療", icon: "medical" },
  { name: "旅行", icon: "travel" },
  { name: "学び", icon: "study" },
  { name: "住まい", icon: "home" },
  { name: "通信", icon: "comm" },
  { name: "その他", icon: "other" },
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
