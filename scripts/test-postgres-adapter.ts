// Postgresアダプタの結合テスト（PGlite＝WASM版Postgresを注入・実DB不要）。
// スキーマ作成 → ユーザー登録 → 支出CRUD → シフト給与計算 → 定期計上 → ai_usage上限 を
// アプリ本体のコード経由で検証する。
//   実行: npx tsx scripts/test-postgres-adapter.ts
import { PGlite } from "@electric-sql/pglite";
import {
  createPostgresDb,
  ensurePostgresSchema,
  type PgDriver,
  type PgQueryFn,
} from "../src/lib/db";
import { runSuite } from "./test-suite";

async function main() {
  // int8(SUM/COUNT) と numeric を number で受ける（本番 pg ドライバ側の setTypeParser と同じ扱い）
  const pglite = await PGlite.create({
    parsers: {
      20: (v: string) => Number(v),
      1700: (v: string) => Number(v),
    },
  });

  const toResult = async (
    q: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[]; affectedRows?: number }>,
    sql: string,
    params: unknown[],
  ) => {
    const res = await q(sql, params);
    return {
      rows: res.rows as Record<string, unknown>[],
      affectedRows: res.affectedRows,
    };
  };

  const driver: PgDriver = {
    query: (sql, params) => toResult((s, p) => pglite.query(s, p), sql, params),
    transaction: async <T>(fn: (query: PgQueryFn) => Promise<T>): Promise<T> => {
      return pglite.transaction(async (tx) => {
        return fn((sql, params) => toResult((s, p) => tx.query(s, p), sql, params));
      }) as Promise<T>;
    },
  };

  const d = createPostgresDb(driver);
  console.log("=== Postgresアダプタ（PGlite）テスト ===");
  console.log("[0] スキーマ作成");
  await ensurePostgresSchema(d);
  const tables = await d.all<{ table_name: string }>(
    "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'",
  );
  console.log(`  ✓ ${tables.length} テーブル作成`);
  if (tables.length < 15) {
    console.error("  ✗ テーブル数が想定より少ない");
    process.exit(1);
  }

  const { failed } = await runSuite(d);
  await pglite.close();
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
