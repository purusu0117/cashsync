// sqliteモード（DATABASE_URL未設定・従来構成）の回帰テスト。
// 一時DBファイルで主要CRUD＋ドメインロジックが従来どおり動くことを確認する。
//   実行: npx tsx scripts/test-sqlite-adapter.ts
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createSqliteDb } from "../src/lib/db";
import { runSuite } from "./test-suite";

async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cashsync-test-"));
  const file = path.join(dir, "test.db");
  console.log("=== sqliteアダプタテスト ===");
  console.log(`[0] 一時DB: ${file}`);
  const d = createSqliteDb(file);
  const { failed } = await runSuite(d);
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* Windowsのファイルロック等は無視 */
  }
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
