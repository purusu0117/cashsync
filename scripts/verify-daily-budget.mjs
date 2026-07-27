// 日次予算＋繰り越し方式（dailyBudget）の数値実証スクリプト。
// 一時sqlite（.data/verify-daily-budget.db）を使い、date を明示して日跨ぎを再現する。
// 実行: node scripts/verify-daily-budget.mjs
import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const DB = path.join(root, ".data", "verify-daily-budget.db");
for (const suffix of ["", "-wal", "-shm"]) fs.rmSync(DB + suffix, { force: true });
process.env.CASHSYNC_DB_PATH = DB;

const { db, uid } = await import(`file://${root}/src/lib/db.ts`);
const { monthSummary, dailyBudget, todaySpent } = await import(`file://${root}/src/lib/money.ts`);

const d = db();
const U = "u1";
d.prepare("INSERT INTO users (id, email, name, password_hash, created_at) VALUES (?,?,?,?,?)").run(
  U,
  "verify@example.com",
  "verify",
  "x",
  Date.now(),
);
// 収入30,000（2026-07-01）。2026-07-29 時点で残り3日（29,30,31）・貯金目標0
d.prepare(
  "INSERT INTO incomes (id, user_id, date, amount, type, memo, created_at) VALUES (?,?,?,?,?,?,?)",
).run(uid(), U, "2026-07-01", 30000, "other", "", Date.now());

const M = "2026-07";
const spend = (date, amount) =>
  d
    .prepare(
      "INSERT INTO expenses (id, user_id, date, amount, category_id, memo, source, created_at) VALUES (?,?,?,?,NULL,'','manual',?)",
    )
    .run(uid(), U, date, amount, Date.now());
const rows = [];
const check = (label, today, exp) => {
  const b = dailyBudget(monthSummary(U, M), todaySpent(U, today), 0, today);
  const ok =
    b.todayBudget === exp.budget && b.remainingToday === exp.remain && b.daysRemaining === exp.days;
  rows.push([
    label,
    today,
    b.daysRemaining,
    b.spentBeforeToday,
    b.todayBudget,
    b.spentToday,
    b.remainingToday,
    ok ? "OK" : `NG expected ${JSON.stringify(exp)}`,
  ]);
};

// ケースA: 昨日まで支出0 → 予算10,000。今日3,000 → あと7,000。翌日は(30,000−3,000)÷2=13,500
check("A1 支出なし", "2026-07-29", { budget: 10000, remain: 10000, days: 3 });
spend("2026-07-29", 3000);
check("A2 今日3,000使用", "2026-07-29", { budget: 10000, remain: 7000, days: 3 });
check("A3 翌日(残り2日)", "2026-07-30", { budget: 13500, remain: 13500, days: 2 });

// ケースB: 超過（支出リセット後、今日15,000）→ あと−5,000。翌日は(30,000−15,000)÷2=7,500
d.prepare("DELETE FROM expenses WHERE user_id = ?").run(U);
spend("2026-07-29", 15000);
check("B1 今日15,000使用", "2026-07-29", { budget: 10000, remain: -5000, days: 3 });
check("B2 翌日(残り2日)", "2026-07-30", { budget: 7500, remain: 7500, days: 2 });

// ケースC: 昨日までの支出が累積18,000（3,000＋15,000）→ 翌日予算(30,000−18,000)÷2=6,000
spend("2026-07-29", 3000);
check("C1 翌日(昨日まで18,000)", "2026-07-30", { budget: 6000, remain: 6000, days: 2 });

console.log(
  ["case | today | 残り日数 | 昨日まで支出 | 今日の予算 | 今日の支出 | 今日あと | 判定"]
    .concat(rows.map((r) => r.join(" | ")))
    .join("\n"),
);
const ng = rows.filter((r) => r[7] !== "OK").length;
d.close();
try {
  for (const suffix of ["", "-wal", "-shm"]) fs.rmSync(DB + suffix, { force: true });
} catch {
  /* 一時DBの掃除失敗は結果に影響しない（.data/ はgitignore済み） */
}
console.log(ng === 0 ? "ALL OK" : `${ng} FAILED`);
process.exit(ng === 0 ? 0 : 1);
