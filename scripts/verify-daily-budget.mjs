// 日次予算＋繰り越し方式（dailyBudget）の数値実証スクリプト。
// 一時sqlite（.data/verify-daily-budget.db）を使い、date を明示して日跨ぎを再現する。
// 固定費（定期計上）の先取り分離・B2予算切れ判定・nextPayday もここで実証する。
// 実行: node scripts/verify-daily-budget.mjs
import fs from "node:fs";
import { registerHooks } from "node:module";
import path from "node:path";

// src/ 内の相対 import は拡張子なし（"./categoryIcons" 等）なので .ts を補って解決する。
// CJS の holiday_jp は named export 検出に失敗するのでシム（holiday-shim.mjs）へ振り替える。
registerHooks({
  resolve(specifier, context, nextResolve) {
    // シム自身からの require はそのまま通す（無限リダイレクト防止）
    if (
      specifier === "@holiday-jp/holiday_jp" &&
      !String(context.parentURL ?? "").includes("holiday-shim")
    ) {
      return nextResolve(new URL("./holiday-shim.mjs", import.meta.url).href, context);
    }
    try {
      return nextResolve(specifier, context);
    } catch (e) {
      if (specifier.startsWith(".") && !specifier.endsWith(".ts")) {
        return nextResolve(`${specifier}.ts`, context);
      }
      throw e;
    }
  },
});

const root = process.cwd();
const DB = path.join(root, ".data", "verify-daily-budget.db");
for (const suffix of ["", "-wal", "-shm"]) fs.rmSync(DB + suffix, { force: true });
process.env.CASHSYNC_DB_PATH = DB;

const { db, uid } = await import(`file://${root}/src/lib/db.ts`);
const { monthSummary, dailyBudget, todaySpent, monthFixedCost, nextPayday } = await import(
  `file://${root}/src/lib/money.ts`
);

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
const spend = (date, amount, source = "manual") =>
  d
    .prepare(
      "INSERT INTO expenses (id, user_id, date, amount, category_id, memo, source, created_at) VALUES (?,?,?,?,NULL,'',?,?)",
    )
    .run(uid(), U, date, amount, source, Date.now());
const rows = [];
const check = (label, today, exp) => {
  const b = dailyBudget(monthSummary(U, M), todaySpent(U, today), 0, today, monthFixedCost(U, M));
  const ok =
    b.todayBudget === exp.budget &&
    b.remainingToday === exp.remain &&
    b.daysRemaining === exp.days &&
    (exp.fixed === undefined || b.fixedTotal === exp.fixed) &&
    (exp.monthRemaining === undefined || b.monthRemaining === exp.monthRemaining);
  rows.push([
    label,
    today,
    b.daysRemaining,
    b.fixedTotal,
    b.spentBeforeToday,
    b.todayBudget,
    b.spentToday,
    b.remainingToday,
    ok ? "OK" : `NG expected ${JSON.stringify(exp)}`,
  ]);
};

// ケースA（固定費なし・従来挙動）: 昨日まで支出0 → 予算10,000。今日3,000 → あと7,000。翌日は(30,000−3,000)÷2=13,500
check("A1 支出なし", "2026-07-29", { budget: 10000, remain: 10000, days: 3, fixed: 0 });
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

// ケースD（B1: 固定費の先取り分離）: 収入を80,000に増額し、家賃50,000の定期計上が「今日」入るケース。
// 旧方式では計上日に spentToday=50,000 となり「今日あと −45,000」に崩壊していた。
// 新方式: 固定費は月初から満額を土台から先取り → 計上日でも日割りが崩れない。
d.prepare("DELETE FROM expenses WHERE user_id = ?").run(U);
d.prepare(
  "INSERT INTO incomes (id, user_id, date, amount, type, memo, created_at) VALUES (?,?,?,?,?,?,?)",
).run(uid(), U, "2026-07-01", 50000, "other", "", Date.now()); // 収入計 80,000
spend("2026-07-10", 15000); // 昨日までの変動支出
spend("2026-07-29", 50000, "recurring"); // 家賃の定期計上（計上日=今日）
// 土台 = 80,000 − 固定50,000 − 変動15,000 = 15,000 → ÷3日 = 5,000。今日の変動支出は0のまま
check("D1 家賃計上日(崩壊しない)", "2026-07-29", {
  budget: 5000,
  remain: 5000,
  days: 3,
  fixed: 50000,
  monthRemaining: 15000,
});
spend("2026-07-29", 2000); // 今日の変動支出
check("D2 今日2,000使用", "2026-07-29", { budget: 5000, remain: 3000, days: 3, fixed: 50000 });
// 翌日: 変動累計17,000 → (80,000−50,000−17,000)÷2 = 6,500。固定費計上日をまたいでも整合
check("D3 翌日(残り2日)", "2026-07-30", {
  budget: 6500,
  remain: 6500,
  days: 2,
  fixed: 50000,
  monthRemaining: 13000,
});

// ケースE（B2: 予算切れ）: 7/30 に 20,000 使い、翌 7/31 時点で土台がマイナスに
// → monthRemaining < 0 でホームは「今月使える残りがありません」カードに切替
spend("2026-07-30", 20000);
// 土台 = 80,000 − 50,000 − 昨日まで変動37,000 = −7,000 → ÷ 残り1日 = −7,000
check("E1 土台マイナス(翌日)", "2026-07-31", {
  budget: -7000,
  remain: -7000,
  days: 1,
  fixed: 50000,
  monthRemaining: -7000,
});

// ケースF（C1: 次の給料日）: 末日締め・翌月15日払いのバイト。7月勤務→8/15支給。
// 7/29 時点の次の給料日は 8/15（あと17日）・金額は入力済みシフトから算出。
d.prepare(
  "INSERT INTO jobs (id, user_id, name, weekday_rate, weekend_holiday_rate, transport_per_shift, closing_day, pay_month_offset, pay_day) VALUES (?,?,?,?,?,?,?,?,?)",
).run("j1", U, "テスト", 1200, 1300, 0, 31, 1, 15);
// 7/6(月) 10:00-15:00 休憩60分 → 4h × 1200 = 4,800
d.prepare(
  "INSERT INTO shifts (id, user_id, job_id, date, start_min, end_min, break_min) VALUES (?,?,?,?,?,?,?)",
).run(uid(), U, "j1", "2026-07-06", 600, 900, 60);
const np = nextPayday(U, "2026-07-29");
const npOk = np && np.date === "2026-08-15" && np.amount === 4800 && np.daysUntil === 17;
rows.push([
  "F1 次の給料日",
  "2026-07-29",
  "-",
  "-",
  "-",
  "-",
  "-",
  np ? `${np.date} +${np.amount} (あと${np.daysUntil}日)` : "null",
  npOk ? "OK" : `NG got ${JSON.stringify(np)}`,
]);

console.log(
  ["case | today | 残り日数 | 固定費 | 昨日まで変動 | 今日の予算 | 今日の変動 | 今日あと | 判定"]
    .concat(rows.map((r) => r.join(" | ")))
    .join("\n"),
);
const ng = rows.filter((r) => r[8] !== "OK").length;
d.close();
try {
  for (const suffix of ["", "-wal", "-shm"]) fs.rmSync(DB + suffix, { force: true });
} catch {
  /* 一時DBの掃除失敗は結果に影響しない（.data/ はgitignore済み） */
}
console.log(ng === 0 ? "ALL OK" : `${ng} FAILED`);
process.exit(ng === 0 ? 0 : 1);
