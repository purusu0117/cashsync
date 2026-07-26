// 移行スクリプト本体（migrateData）のテスト：
// 一時sqlite DBに実データを作り → PGlite(Postgres) に移行 → 件数一致・founder昇格・冪等性(--force)を検証。
//   実行: npx tsx scripts/test-migration.ts
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { createPostgresDb, createSqliteDb, uid, type PgDriver, type PgQueryFn } from "../src/lib/db";
import { migrateData, MigrationError } from "./migrate-to-postgres";

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean, detail?: unknown) {
  if (cond) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    console.log(`  ✗ ${name}${detail !== undefined ? ` → ${JSON.stringify(detail)}` : ""}`);
  }
}

async function main() {
  console.log("=== 移行スクリプトテスト（sqlite → PGlite） ===");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cashsync-mig-"));
  const file = path.join(dir, "src.db");

  // 1. 移行元sqliteを本物のマイグレーションで作成し、データ投入
  const seed = createSqliteDb(file);
  const userId = uid();
  await seed.run(
    "INSERT INTO users (id, email, name, password_hash, created_at) VALUES (?, ?, ?, ?, ?)",
    userId,
    "daito@example.com",
    "大翔",
    "salt:hash",
    1721900000000,
  );
  for (let i = 0; i < 3; i++) {
    await seed.run(
      "INSERT INTO expenses (id, user_id, date, amount, category_id, memo, source, receipt_id, created_at) VALUES (?, ?, ?, ?, ?, ?, 'manual', ?, ?)",
      uid(),
      userId,
      "2026-07-01",
      100 + i,
      null,
      `メモ${i}`,
      null,
      Date.now(),
    );
  }
  await seed.run(
    "INSERT INTO shifts (id, user_id, job_id, date, start_min, end_min, break_min, source) VALUES (?, ?, ?, ?, ?, ?, 0, 'manual')",
    uid(),
    userId,
    "job1",
    "2026-07-02",
    1080,
    1350,
  );

  // 2. PGlite を移行先として migrateData を実行
  const pglite = await PGlite.create({
    parsers: { 20: (v: string) => Number(v), 1700: (v: string) => Number(v) },
  });
  const toResult = async (
    q: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[]; affectedRows?: number }>,
    sql: string,
    params: unknown[],
  ) => {
    const res = await q(sql, params);
    return { rows: res.rows as Record<string, unknown>[], affectedRows: res.affectedRows };
  };
  const driver: PgDriver = {
    query: (sql, params) => toResult((s, p) => pglite.query(s, p), sql, params),
    transaction: async <T>(fn: (query: PgQueryFn) => Promise<T>): Promise<T> =>
      pglite.transaction(async (tx) =>
        fn((sql, params) => toResult((s, p) => tx.query(s, p), sql, params)),
      ) as Promise<T>,
  };
  const dst = createPostgresDb(driver);

  const srcRo = new DatabaseSync(file, { readOnly: true });
  const quiet = () => {};

  const mismatch1 = await migrateData(srcRo, dst, { force: false, log: quiet });
  check("初回移行で件数不一致なし", mismatch1 === 0, mismatch1);

  const u = await dst.get<{ email: string; plan: string; created_at: number; password_hash: string }>(
    "SELECT email, plan, created_at, password_hash FROM users WHERE id = ?",
    userId,
  );
  check("ユーザーがID・ハッシュ・作成日時ごと移行される",
    u?.email === "daito@example.com" && u?.password_hash === "salt:hash" && Number(u?.created_at) === 1721900000000,
    u,
  );
  check("既存ユーザーは founder に昇格", u?.plan === "founder", u?.plan);
  const expCount = (await dst.get<{ c: number }>("SELECT COUNT(*) AS c FROM expenses"))!;
  check("支出3件が移行される", expCount.c === 3, expCount);

  // 3. 再実行: --force 無しは拒否、--force ありは入れ直しで成功
  let refused = false;
  try {
    await migrateData(srcRo, dst, { force: false, log: quiet });
  } catch (e) {
    refused = e instanceof MigrationError;
  }
  check("既存データありの再実行は --force 無しだと拒否", refused);

  const mismatch2 = await migrateData(srcRo, dst, { force: true, log: quiet });
  const expCount2 = (await dst.get<{ c: number }>("SELECT COUNT(*) AS c FROM expenses"))!;
  check("--force で入れ直しても二重にならない（冪等）", mismatch2 === 0 && expCount2.c === 3, expCount2);

  srcRo.close();
  await pglite.close();
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
  console.log(`\n結果: ${passed} passed / ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
