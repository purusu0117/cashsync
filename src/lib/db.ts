// サーバー専用：DBアクセス層（非同期アダプタ方式）。
//  - DATABASE_URL があれば Postgres（pg / Supabase等のクラウドDB）
//  - 無ければ従来どおり Node 24 組み込みの node:sqlite（PC版・2人が本番利用中の構成を完全維持）
// 呼び出し側は `const d = await db()` で Db インターフェースを受け取り、
// `?` プレースホルダのSQLを書く（Postgres方言差 $1.. への変換はアダプタが吸収）。
// テストでは createPostgresDb() に PGlite のクエリ関数を注入できる（scripts/test-postgres-adapter.ts）。
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import { POSTGRES_SCHEMA_STATEMENTS } from "./schema-postgres";

export interface RunResult {
  changes: number;
}

/** DB共通インターフェース（sqlite / postgres / テスト用PGlite が同じ形で実装） */
export interface Db {
  dialect: "sqlite" | "postgres";
  get<T = Record<string, unknown>>(sql: string, ...params: unknown[]): Promise<T | undefined>;
  all<T = Record<string, unknown>>(sql: string, ...params: unknown[]): Promise<T[]>;
  run(sql: string, ...params: unknown[]): Promise<RunResult>;
  exec(sql: string): Promise<void>;
  /** 複数書き込みの原子性が要る箇所用。fn内は渡された tx を使うこと */
  transaction<T>(fn: (tx: Db) => Promise<T>): Promise<T>;
}

let _dbPromise: Promise<Db> | null = null;

/** アプリ全体のDBハンドル（初回呼び出しで初期化・スキーマ適用） */
export function db(): Promise<Db> {
  if (!_dbPromise) {
    _dbPromise = init().catch((e) => {
      _dbPromise = null; // 失敗時は次回リトライできるように
      throw e;
    });
  }
  return _dbPromise;
}

/** テスト用：任意のアダプタ（PGlite等）を差し込む */
export function setDbForTesting(d: Db) {
  _dbPromise = Promise.resolve(d);
}

async function init(): Promise<Db> {
  const url = process.env.DATABASE_URL;
  if (url) {
    const driver = await createPgPoolDriver(url);
    const d = createPostgresDb(driver);
    await ensurePostgresSchema(d);
    return d;
  }
  return createSqliteDb(sqliteFilePath());
}

function sqliteFilePath(): string {
  // CASHSYNC_DB_PATH はテスト用の上書き。既定はPC版と同じ .data/cashsync.db
  return process.env.CASHSYNC_DB_PATH || path.join(process.cwd(), ".data", "cashsync.db");
}

// ---------------------------------------------------------------------------
// sqlite アダプタ（従来実装のラップ）
// ---------------------------------------------------------------------------

// 同時リクエストのawait跨ぎでトランザクションに他のクエリが紛れ込まないよう、
// sqlite操作は簡易ミューテックスで直列化する（単一コネクションのため）。
class Mutex {
  private tail: Promise<void> = Promise.resolve();
  lock(): Promise<() => void> {
    let release!: () => void;
    const next = new Promise<void>((res) => (release = res));
    const acquired = this.tail.then(() => release);
    this.tail = this.tail.then(() => next);
    return acquired;
  }
}

export function createSqliteDb(file: string): Db {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const raw = new DatabaseSync(file);
  raw.exec("PRAGMA journal_mode = WAL");
  // Windowsのウイルススキャン等が一瞬ファイルを掴んでもエラーにせず最大5秒待つ
  raw.exec("PRAGMA busy_timeout = 5000");
  migrateSqlite(raw);
  backupDaily(raw, file);
  const mutex = new Mutex();

  // ロック無しの生オペレーション（トランザクション内部から使う）
  const bare: Db = {
    dialect: "sqlite",
    async get<T>(sql: string, ...params: unknown[]) {
      return raw.prepare(sql).get(...(params as SQLInputValue[])) as T | undefined;
    },
    async all<T>(sql: string, ...params: unknown[]) {
      return raw.prepare(sql).all(...(params as SQLInputValue[])) as T[];
    },
    async run(sql: string, ...params: unknown[]) {
      const r = raw.prepare(sql).run(...(params as SQLInputValue[]));
      return { changes: Number(r.changes) };
    },
    async exec(sql: string) {
      raw.exec(sql);
    },
    async transaction<T>(fn: (tx: Db) => Promise<T>): Promise<T> {
      return fn(bare); // 既にトランザクション内 → そのまま実行
    },
  };

  return {
    dialect: "sqlite",
    async get<T>(sql: string, ...params: unknown[]) {
      const release = await mutex.lock();
      try {
        return await bare.get<T>(sql, ...params);
      } finally {
        release();
      }
    },
    async all<T>(sql: string, ...params: unknown[]) {
      const release = await mutex.lock();
      try {
        return await bare.all<T>(sql, ...params);
      } finally {
        release();
      }
    },
    async run(sql: string, ...params: unknown[]) {
      const release = await mutex.lock();
      try {
        return await bare.run(sql, ...params);
      } finally {
        release();
      }
    },
    async exec(sql: string) {
      const release = await mutex.lock();
      try {
        raw.exec(sql);
      } finally {
        release();
      }
    },
    async transaction<T>(fn: (tx: Db) => Promise<T>): Promise<T> {
      const release = await mutex.lock();
      try {
        raw.exec("BEGIN");
        try {
          const result = await fn(bare);
          raw.exec("COMMIT");
          return result;
        } catch (e) {
          try {
            raw.exec("ROLLBACK");
          } catch {
            /* already rolled back */
          }
          throw e;
        }
      } finally {
        release();
      }
    },
  };
}

// 起動のたびに1日1回、DBをバックアップ（直近7世代保持）。
// 誤削除・破損からの復旧用。WALをチェックポイントしてから本体ファイルをコピーする。
function backupDaily(d: DatabaseSync, file: string) {
  try {
    const today = new Date();
    const stamp = `${today.getFullYear()}${String(today.getMonth() + 1).padStart(2, "0")}${String(today.getDate()).padStart(2, "0")}`;
    const dir = path.join(path.dirname(file), "backup");
    fs.mkdirSync(dir, { recursive: true });
    const dest = path.join(dir, `cashsync-${stamp}.db`);
    if (fs.existsSync(dest)) return;
    d.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    fs.copyFileSync(file, dest);
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

function migrateSqlite(d: DatabaseSync) {
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
    CREATE TABLE IF NOT EXISTS ai_usage (
      user_id TEXT NOT NULL,
      ym TEXT NOT NULL,                 -- 'YYYY-MM'
      scans INTEGER NOT NULL DEFAULT 0,
      parses INTEGER NOT NULL DEFAULT 0,
      bonus_scans INTEGER NOT NULL DEFAULT 0,   -- リワード動画で獲得した当月ボーナス枠
      bonus_parses INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (user_id, ym)
    );
    CREATE TABLE IF NOT EXISTS ai_reward_days (
      user_id TEXT NOT NULL,
      ymd TEXT NOT NULL,                -- 'YYYY-MM-DD'
      count INTEGER NOT NULL DEFAULT 0, -- その日に視聴したリワード動画本数（日次上限ガード）
      PRIMARY KEY (user_id, ymd)
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
  addColumn(d, "ai_usage", "bonus_scans INTEGER NOT NULL DEFAULT 0"); // リワード動画ボーナス枠
  addColumn(d, "ai_usage", "bonus_parses INTEGER NOT NULL DEFAULT 0");
  // AIプラン階層。カラム新設時のみ、既存ユーザーを founder（無制限）に引き上げる
  // （PC版の2人の既存挙動を変えないため。以後の新規ユーザーは 'free'）
  if (addColumn(d, "users", "plan TEXT NOT NULL DEFAULT 'free'")) {
    d.exec("UPDATE users SET plan = 'founder'");
  }
}

// 掛け持ちバイトの色パレット（紙背景で判別しやすい順）
export const JOB_COLORS = ["#e8442e", "#2f6b9e", "#2f8f5b", "#8a5fbf", "#9a6b00"];

function addColumn(d: DatabaseSync, table: string, colDef: string): boolean {
  try {
    d.exec(`ALTER TABLE ${table} ADD COLUMN ${colDef}`);
    return true;
  } catch {
    return false; // 既に存在
  }
}

// ---------------------------------------------------------------------------
// Postgres アダプタ（pg Pool / テスト時は PGlite を注入）
// ---------------------------------------------------------------------------

export interface PgQueryResult {
  rows: Record<string, unknown>[];
  rowCount?: number | null;
  affectedRows?: number; // PGlite は affectedRows を返す
}
export type PgQueryFn = (sql: string, params: unknown[]) => Promise<PgQueryResult>;

/** クエリ実行関数を注入できるPostgresドライバ（本番=pg Pool、テスト=PGlite） */
export interface PgDriver {
  query: PgQueryFn;
  /** トランザクション：fn には同一コネクション上の query を渡す */
  transaction<T>(fn: (query: PgQueryFn) => Promise<T>): Promise<T>;
}

/** `?` プレースホルダを $1..$n に変換（当プロジェクトのSQLは文字列リテラル内に ? を含まない前提） */
export function toPgPlaceholders(sql: string): string {
  let i = 0;
  return sql.replace(/\?/g, () => `$${++i}`);
}

// pg は BIGINT(SUM/COUNT等) を文字列やBigIntで返すことがある → number に正規化
function normalizeRow(row: Record<string, unknown>): Record<string, unknown> {
  for (const k of Object.keys(row)) {
    const v = row[k];
    if (typeof v === "bigint") row[k] = Number(v);
  }
  return row;
}

export function createPostgresDb(driver: PgDriver): Db {
  const make = (query: PgQueryFn): Db => ({
    dialect: "postgres",
    async get<T>(sql: string, ...params: unknown[]) {
      const res = await query(toPgPlaceholders(sql), params);
      const row = res.rows[0];
      return row ? (normalizeRow(row) as T) : undefined;
    },
    async all<T>(sql: string, ...params: unknown[]) {
      const res = await query(toPgPlaceholders(sql), params);
      return res.rows.map(normalizeRow) as T[];
    },
    async run(sql: string, ...params: unknown[]) {
      const res = await query(toPgPlaceholders(sql), params);
      return { changes: res.rowCount ?? res.affectedRows ?? 0 };
    },
    async exec(sql: string) {
      await query(sql, []);
    },
    async transaction<T>(fn: (tx: Db) => Promise<T>): Promise<T> {
      return driver.transaction((txQuery) => fn(make(txQuery)));
    },
  });
  return make(driver.query);
}

/** pg Pool ベースの本番ドライバ（移行スクリプトからも利用） */
export async function createPgPoolDriver(url: string): Promise<PgDriver & { end(): Promise<void> }> {
  const pg = (await import("pg")).default;
  // SUM/COUNT(BIGINT, oid 20) と NUMERIC(oid 1700) を number として読む
  // （エポックmsも金額もNumber安全域に収まる）
  pg.types.setTypeParser(20, (v: string) => Number(v));
  pg.types.setTypeParser(1700, (v: string) => Number(v));
  const local = /localhost|127\.0\.0\.1/.test(url);
  const pool = new pg.Pool({
    connectionString: url,
    max: Number(process.env.CASHSYNC_PG_POOL_MAX || 5),
    // Supabase等のマネージドPostgresはTLS必須（証明書検証はプロバイダ側のCA差異があるため緩める）
    ssl: local ? undefined : { rejectUnauthorized: false },
  });
  return {
    end: () => pool.end(),
    query: async (sql, params) => {
      const res = await pool.query(sql, params as unknown[]);
      return { rows: res.rows as Record<string, unknown>[], rowCount: res.rowCount };
    },
    async transaction<T>(fn: (query: PgQueryFn) => Promise<T>): Promise<T> {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const result = await fn(async (sql, params) => {
          const res = await client.query(sql, params as unknown[]);
          return { rows: res.rows as Record<string, unknown>[], rowCount: res.rowCount };
        });
        await client.query("COMMIT");
        return result;
      } catch (e) {
        try {
          await client.query("ROLLBACK");
        } catch {
          /* ignore */
        }
        throw e;
      } finally {
        client.release();
      }
    },
  };
}

/** Postgres側スキーマを冪等に適用（コールドスタート時に1回） */
export async function ensurePostgresSchema(d: Db) {
  for (const stmt of POSTGRES_SCHEMA_STATEMENTS) {
    await d.exec(stmt);
  }
}

// ---------------------------------------------------------------------------
// 共通ユーティリティ
// ---------------------------------------------------------------------------

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

export async function seedCategories(userId: string) {
  const d = await db();
  for (let i = 0; i < DEFAULT_CATEGORIES.length; i++) {
    const c = DEFAULT_CATEGORIES[i];
    await d.run(
      "INSERT INTO categories (id, user_id, name, icon, sort) VALUES (?, ?, ?, ?, ?)",
      uid(),
      userId,
      c.name,
      c.icon,
      i,
    );
  }
}

export function uid(): string {
  return globalThis.crypto.randomUUID();
}
