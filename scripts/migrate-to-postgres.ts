// sqlite（.data/cashsync.db）→ Postgres（DATABASE_URL）への一括移行スクリプト。
// ID・scryptパスワードハッシュ・created_at をそのまま持ち込む（ユーザーは再ログイン不要）。
// 既存ユーザーは全員 plan='founder'（無制限）に引き上げる。
//
// 使い方:
//   DATABASE_URL="postgres://..." npx tsx scripts/migrate-to-postgres.ts
//   npx tsx scripts/migrate-to-postgres.ts --sqlite .data/cashsync.db --url "postgres://..." --force
//
// 冪等性: 移行先に既存データがある場合はエラー停止。--force を付けると全テーブルを
// TRUNCATE してから入れ直す（再実行可）。
// 最後に「テーブルごとの件数: sqlite vs postgres」の検証表を出し、不一致があれば exit 1。
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import { createPgPoolDriver, createPostgresDb, ensurePostgresSchema, type Db } from "../src/lib/db";
import { MIGRATION_TABLES } from "../src/lib/schema-postgres";

export class MigrationError extends Error {}

/**
 * 移行の本体（scripts/test-migration.ts からPGliteでテスト可能なよう分離）。
 * 戻り値: 件数不一致だったテーブル数（0なら成功）。
 */
export async function migrateData(
  src: DatabaseSync,
  dst: Db,
  opts: { force: boolean; log?: (line: string) => void },
): Promise<number> {
  const log = opts.log ?? console.log;
  await ensurePostgresSchema(dst);

  const sqliteTables = new Set(
    (
      src.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as {
        name: string;
      }[]
    ).map((r) => r.name),
  );

  // 既存データチェック / --force なら TRUNCATE
  let existing = 0;
  for (const t of MIGRATION_TABLES) {
    const row = (await dst.get<{ c: number }>(`SELECT COUNT(*) AS c FROM ${t}`)) as { c: number };
    existing += row.c;
  }
  if (existing > 0) {
    if (!opts.force) {
      throw new MigrationError(
        `移行先に既存データが ${existing} 行あります。入れ直す場合は --force を付けてください（全テーブルTRUNCATE）。`,
      );
    }
    log(`\n--force 指定: 既存 ${existing} 行を TRUNCATE します`);
    await dst.exec(`TRUNCATE TABLE ${MIGRATION_TABLES.join(", ")}`);
  }

  // テーブルごとにコピー（カラムは移行元sqliteの実カラムに合わせる。
  // 移行元に無い新カラム（plan等）はPostgres側のDEFAULTに任せる）
  log("");
  for (const t of MIGRATION_TABLES) {
    if (!sqliteTables.has(t)) {
      log(`- ${t}: sqlite側にテーブル無し → スキップ（0行）`);
      continue;
    }
    const cols = (src.prepare(`PRAGMA table_info(${t})`).all() as { name: string }[]).map(
      (c) => c.name,
    );
    const rows = src.prepare(`SELECT * FROM ${t}`).all() as Record<string, unknown>[];
    const insertSql = `INSERT INTO ${t} (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`;
    await dst.transaction(async (tx) => {
      for (const row of rows) {
        await tx.run(insertSql, ...cols.map((c) => row[c] ?? null));
      }
    });
    log(`- ${t}: ${rows.length} 行コピー`);
  }

  // 既存ユーザーは全員 founder（無制限プラン）
  const promoted = await dst.run("UPDATE users SET plan = 'founder'");
  log(`- users.plan: ${promoted.changes} 人を 'founder' に設定`);

  // 検証: 件数の突き合わせ
  log("\n=== 検証（件数: sqlite vs postgres） ===");
  let mismatch = 0;
  for (const t of MIGRATION_TABLES) {
    const srcCount = sqliteTables.has(t)
      ? Number((src.prepare(`SELECT COUNT(*) AS c FROM ${t}`).get() as { c: number }).c)
      : 0;
    const dstCount = ((await dst.get<{ c: number }>(`SELECT COUNT(*) AS c FROM ${t}`)) as { c: number })
      .c;
    const ok = srcCount === dstCount;
    if (!ok) mismatch++;
    log(
      `${ok ? "✓" : "✗"} ${t.padEnd(20)} sqlite=${String(srcCount).padStart(6)}  postgres=${String(dstCount).padStart(6)}`,
    );
  }
  return mismatch;
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function fail(msg: string): never {
  console.error(`\n✗ ${msg}`);
  process.exit(1);
}

async function main() {
  const force = process.argv.includes("--force");
  const sqlitePath = arg("sqlite") || path.join(process.cwd(), ".data", "cashsync.db");
  const databaseUrl = arg("url") || process.env.DATABASE_URL;
  if (!databaseUrl) fail("DATABASE_URL が未指定です（env か --url で渡してください）。");
  if (!fs.existsSync(sqlitePath)) fail(`sqliteファイルが見つかりません: ${sqlitePath}`);

  console.log(`sqlite:   ${sqlitePath}`);
  console.log(`postgres: ${databaseUrl.replace(/:\/\/([^:]+):[^@]+@/, "://$1:***@")}`);

  // 移行元は読み取り専用で開く（本番PC版のDBを一切変更しない）
  const src = new DatabaseSync(sqlitePath, { readOnly: true });
  const driver = await createPgPoolDriver(databaseUrl);
  const dst: Db = createPostgresDb(driver);

  try {
    const mismatch = await migrateData(src, dst, { force });
    if (mismatch > 0) fail(`${mismatch} テーブルで件数不一致。移行失敗です。`);
    console.log("\n✓ 移行完了（全テーブル件数一致）");
  } catch (e) {
    if (e instanceof MigrationError) fail(e.message);
    throw e;
  } finally {
    src.close();
    await driver.end();
  }
}

// tsx で直接実行されたときのみ main を走らせる（テストからの import 時は走らせない）
if (process.argv[1] && /migrate-to-postgres/.test(process.argv[1])) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
