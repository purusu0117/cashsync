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
    plan TEXT NOT NULL DEFAULT 'free',
    month_start_day INTEGER NOT NULL DEFAULT 1,
    reminder_hour INTEGER NOT NULL DEFAULT -1,
    last_reminder_push TEXT,
    record_push INTEGER NOT NULL DEFAULT 1
  )`,
  // 記録できたら通知する（既定ON）
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS record_push INTEGER NOT NULL DEFAULT 1`,
  // C5: AI読み取りのジョブ化（アプリを閉じても解析が続くように）
  `CREATE TABLE IF NOT EXISTS scan_jobs (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'running',
    result_json TEXT,
    error TEXT,
    image_hash TEXT,
    created_at BIGINT NOT NULL,
    updated_at BIGINT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_scan_jobs_user ON scan_jobs(user_id, created_at)`,
  // B9: 既存DBへの追加カラム（冪等）：家計簿の月の開始日（1〜28。25なら7/25〜8/24が「8月」）
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS month_start_day INTEGER NOT NULL DEFAULT 1`,
  // C3: 記録リマインダー（0〜23時。-1=OFF）と最終送信日（1日1回制限）
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS reminder_hour INTEGER NOT NULL DEFAULT -1`,
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS last_reminder_push TEXT`,
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
  // 旧DB（icon列なし）への追加カラム（冪等）。値の絵文字→キー変換は migrateCategoryIcons が行う
  `ALTER TABLE categories ADD COLUMN IF NOT EXISTS icon TEXT NOT NULL DEFAULT ''`,
  `CREATE TABLE IF NOT EXISTS expenses (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    date TEXT NOT NULL,
    amount INTEGER NOT NULL,
    category_id TEXT,
    memo TEXT NOT NULL DEFAULT '',
    source TEXT NOT NULL DEFAULT 'manual',
    receipt_id TEXT,
    recurring_id TEXT,
    created_at BIGINT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_expenses_user_date ON expenses(user_id, date)`,
  // C12: どの定期から計上されたか（固定費/変動費の判定用。旧レコードはNULL=固定扱い）
  `ALTER TABLE expenses ADD COLUMN IF NOT EXISTS recurring_id TEXT`,
  `CREATE TABLE IF NOT EXISTS receipts (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    store TEXT NOT NULL DEFAULT '',
    taken_date TEXT NOT NULL,
    total INTEGER NOT NULL,
    items_json TEXT NOT NULL DEFAULT '[]',
    image_hash TEXT,
    created_at BIGINT NOT NULL
  )`,
  // 同じ画像の二度読みだけを弾くための sha256
  `ALTER TABLE receipts ADD COLUMN IF NOT EXISTS image_hash TEXT`,
  `CREATE TABLE IF NOT EXISTS incomes (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    date TEXT NOT NULL,
    amount INTEGER NOT NULL,
    type TEXT NOT NULL DEFAULT 'other',
    memo TEXT NOT NULL DEFAULT '',
    image_hash TEXT,
    created_at BIGINT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_incomes_user_date ON incomes(user_id, date)`,
  // 同じ画像の二度読みだけを弾くための sha256
  `ALTER TABLE incomes ADD COLUMN IF NOT EXISTS image_hash TEXT`,
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
    post_day INTEGER NOT NULL DEFAULT 1,
    interval TEXT NOT NULL DEFAULT 'monthly',
    is_fixed INTEGER NOT NULL DEFAULT 1
  )`,
  // 既存DBへの追加カラム（冪等）：'monthly' | 'yearly'（年払いサブスク対応）
  `ALTER TABLE recurring_items ADD COLUMN IF NOT EXISTS interval TEXT NOT NULL DEFAULT 'monthly'`,
  // C12: 1=固定費（日次予算で先取り）, 0=変動費扱い
  `ALTER TABLE recurring_items ADD COLUMN IF NOT EXISTS is_fixed INTEGER NOT NULL DEFAULT 1`,
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
    carryover INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (user_id, category_id)
  )`,
  // C13: 1=前月の余りを当月予算に繰り越す
  `ALTER TABLE category_budgets ADD COLUMN IF NOT EXISTS carryover INTEGER NOT NULL DEFAULT 0`,
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
    bonus_scans INTEGER NOT NULL DEFAULT 0,
    bonus_parses INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (user_id, ym)
  )`,
  // 既存DBへの追加カラム（冪等）
  `ALTER TABLE ai_usage ADD COLUMN IF NOT EXISTS bonus_scans INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE ai_usage ADD COLUMN IF NOT EXISTS bonus_parses INTEGER NOT NULL DEFAULT 0`,
  `CREATE TABLE IF NOT EXISTS ai_reward_days (
    user_id TEXT NOT NULL,
    ymd TEXT NOT NULL,
    count INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (user_id, ymd)
  )`,
  // マーチャント学習（店名→ユーザーが確定したカテゴリ）。updated_at はエポックms → BIGINT
  `CREATE TABLE IF NOT EXISTS merchant_categories (
    user_id TEXT NOT NULL,
    merchant TEXT NOT NULL,
    category_id TEXT NOT NULL,
    updated_at BIGINT NOT NULL,
    PRIMARY KEY (user_id, merchant)
  )`,
  // B5: パスワード再設定トークン（sha256のみ保存・有効1時間・使い捨て）。expires/used はエポックms → BIGINT
  `CREATE TABLE IF NOT EXISTS password_resets (
    token_hash TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    expires_at BIGINT NOT NULL,
    used_at BIGINT
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
  "ai_reward_days",
  "merchant_categories",
  "password_resets",
];
