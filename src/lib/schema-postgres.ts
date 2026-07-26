// Postgres 側のスキーマDDL（sqlite側 db.ts の migrate() と1対1対応）。
// アプリ起動時（ensureSchema）・移行スクリプト・PGliteテストで共用する単一のソース。
// 方針:
//  - 主キーは全てTEXT（UUID文字列）なので AUTOINCREMENT/SERIAL は不要
//  - created_at はエポックms（Date.now()）なので int4 に収まらない → BIGINT
//  - 金額・分・ソート等は INTEGER
//  - 冪等（IF NOT EXISTS）なのでコールドスタート毎に流しても安全

export const POSTGRES_SCHEMA_STATEMENTS: string[] = [
  `CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    email TEXT UNIQUE NOT NULL,
    name TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    created_at BIGINT NOT NULL,
    savings_goal INTEGER NOT NULL DEFAULT 0,
    api_token TEXT,
    last_overspend_push TEXT,
    plan TEXT NOT NULL DEFAULT 'free'
  )`,
  `CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    created_at BIGINT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS categories (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    name TEXT NOT NULL,
    icon TEXT NOT NULL DEFAULT '',
    sort INTEGER NOT NULL DEFAULT 0
  )`,
  `CREATE TABLE IF NOT EXISTS expenses (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    date TEXT NOT NULL,
    amount INTEGER NOT NULL,
    category_id TEXT,
    memo TEXT NOT NULL DEFAULT '',
    source TEXT NOT NULL DEFAULT 'manual',
    receipt_id TEXT,
    created_at BIGINT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_expenses_user_date ON expenses(user_id, date)`,
  `CREATE TABLE IF NOT EXISTS receipts (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    store TEXT NOT NULL DEFAULT '',
    taken_date TEXT NOT NULL,
    total INTEGER NOT NULL,
    items_json TEXT NOT NULL DEFAULT '[]',
    created_at BIGINT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS incomes (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    date TEXT NOT NULL,
    amount INTEGER NOT NULL,
    type TEXT NOT NULL DEFAULT 'other',
    memo TEXT NOT NULL DEFAULT '',
    created_at BIGINT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_incomes_user_date ON incomes(user_id, date)`,
  `CREATE TABLE IF NOT EXISTS jobs (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    name TEXT NOT NULL,
    weekday_rate INTEGER NOT NULL,
    weekend_holiday_rate INTEGER NOT NULL,
    transport_per_shift INTEGER NOT NULL DEFAULT 0,
    calendar_keywords TEXT NOT NULL DEFAULT '',
    calendar_exclude TEXT NOT NULL DEFAULT '',
    color TEXT NOT NULL DEFAULT '',
    closing_day INTEGER NOT NULL DEFAULT 31,
    pay_month_offset INTEGER NOT NULL DEFAULT 0,
    pay_day INTEGER NOT NULL DEFAULT 25,
    pay_same_day INTEGER NOT NULL DEFAULT 0
  )`,
  `CREATE TABLE IF NOT EXISTS shifts (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    job_id TEXT NOT NULL,
    date TEXT NOT NULL,
    start_min INTEGER NOT NULL,
    end_min INTEGER NOT NULL,
    break_min INTEGER NOT NULL DEFAULT 0,
    source TEXT NOT NULL DEFAULT 'manual'
  )`,
  `CREATE INDEX IF NOT EXISTS idx_shifts_user_date ON shifts(user_id, date)`,
  `CREATE TABLE IF NOT EXISTS recurring_items (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    name TEXT NOT NULL,
    amount INTEGER NOT NULL,
    category_id TEXT,
    start_month TEXT NOT NULL,
    end_month TEXT,
    post_day INTEGER NOT NULL DEFAULT 1
  )`,
  `CREATE TABLE IF NOT EXISTS recurring_posts (
    recurring_id TEXT NOT NULL,
    month TEXT NOT NULL,
    PRIMARY KEY (recurring_id, month)
  )`,
  `CREATE TABLE IF NOT EXISTS quick_presets (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    label TEXT NOT NULL,
    amount INTEGER NOT NULL,
    category_id TEXT,
    sort INTEGER NOT NULL DEFAULT 0
  )`,
  `CREATE TABLE IF NOT EXISTS category_budgets (
    user_id TEXT NOT NULL,
    category_id TEXT NOT NULL,
    amount INTEGER NOT NULL,
    PRIMARY KEY (user_id, category_id)
  )`,
  `CREATE TABLE IF NOT EXISTS push_subscriptions (
    endpoint TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    subscription TEXT NOT NULL,
    created_at BIGINT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS monthly_reviews (
    user_id TEXT NOT NULL,
    month TEXT NOT NULL,
    report TEXT NOT NULL,
    created_at BIGINT NOT NULL,
    PRIMARY KEY (user_id, month)
  )`,
  `CREATE TABLE IF NOT EXISTS ai_usage (
    user_id TEXT NOT NULL,
    ym TEXT NOT NULL,
    scans INTEGER NOT NULL DEFAULT 0,
    parses INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (user_id, ym)
  )`,
];

/** 移行スクリプト用：sqlite→postgresでコピーするテーブル一覧（依存の無い順） */
export const MIGRATION_TABLES: string[] = [
  "users",
  "sessions",
  "categories",
  "expenses",
  "receipts",
  "incomes",
  "jobs",
  "shifts",
  "recurring_items",
  "recurring_posts",
  "quick_presets",
  "category_budgets",
  "push_subscriptions",
  "monthly_reviews",
  "ai_usage",
];
