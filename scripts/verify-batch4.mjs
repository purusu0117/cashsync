// Batch4（B5アカウント削除・パスワード再設定／B9締め日）の数値実証スクリプト。
// 一時sqlite（.data/verify-batch4.db）を使う。実行: node scripts/verify-batch4.mjs
//  - B9: month_start_day=25 の期間境界・残り日数・サマリー・給料日・定期先取り・冪等性
//  - B9回帰: デフォルト（開始日1）は従来のカレンダー月集計と完全一致
//  - B5: forgot→reset→新PWで検証／トークン再利用・期限切れ拒否／パスワード変更／全テーブル削除
import fs from "node:fs";
import { registerHooks } from "node:module";
import path from "node:path";

registerHooks({
  resolve(specifier, context, nextResolve) {
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
const DB = path.join(root, ".data", "verify-batch4.db");
for (const suffix of ["", "-wal", "-shm"]) fs.rmSync(DB + suffix, { force: true });
process.env.CASHSYNC_DB_PATH = DB;

const { db, uid } = await import(`file://${root}/src/lib/db.ts`);
const {
  accountingMonthFor,
  calendarPaydays,
  categoryBreakdown,
  dailyBudget,
  daysRemainingInMonth,
  getMonthStartDay,
  monthFixedCost,
  monthRange,
  monthRangeFor,
  monthShiftIncome,
  monthSummary,
  noMoneyDays,
  paydays,
  postRecurringForMonth,
  todayStr,
} = await import(`file://${root}/src/lib/money.ts`);
const {
  changePassword,
  consumePasswordReset,
  createPasswordReset,
  deleteAccountWithPassword,
  isResetTokenValid,
} = await import(`file://${root}/src/lib/account.ts`);
const { hashPassword, verifyPassword } = await import(`file://${root}/src/lib/password.ts`);

const d = db();
let failed = 0;
function eq(actual, expected, label) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a === b) {
    console.log(`  ok  ${label} = ${a}`);
  } else {
    failed++;
    console.error(`  NG  ${label}: got ${a}, want ${b}`);
  }
}

function addUser(id, email, monthStartDay = 1, password = "password123") {
  d.prepare(
    "INSERT INTO users (id, email, name, password_hash, created_at, month_start_day) VALUES (?,?,?,?,?,?)",
  ).run(id, email, id, hashPassword(password), Date.now(), monthStartDay);
}
const spend = (u, date, amount, source = "manual") =>
  d
    .prepare(
      "INSERT INTO expenses (id, user_id, date, amount, category_id, memo, source, created_at) VALUES (?,?,?,?,NULL,'',?,?)",
    )
    .run(uid(), u, date, amount, source, Date.now());
const income = (u, date, amount) =>
  d
    .prepare(
      "INSERT INTO incomes (id, user_id, date, amount, type, memo, created_at) VALUES (?,?,?,?,'other','',?)",
    )
    .run(uid(), u, date, amount, Date.now());

// ---------------------------------------------------------------------------
console.log("== B9: 純粋関数（期間境界） ==");
eq(monthRangeFor("2026-08", 25), { start: "2026-07-25", end: "2026-08-24" }, "monthRangeFor(2026-08, 25)");
eq(monthRangeFor("2026-07", 1), { start: "2026-07-01", end: "2026-07-31" }, "monthRangeFor(2026-07, 1)");
eq(monthRangeFor("2026-03", 28), { start: "2026-02-28", end: "2026-03-27" }, "monthRangeFor(2026-03, 28)");
eq(accountingMonthFor("2026-07-24", 25), "2026-07", "accountingMonthFor(7/24, 25)");
eq(accountingMonthFor("2026-07-25", 25), "2026-08", "accountingMonthFor(7/25, 25)");
eq(accountingMonthFor("2026-12-25", 25), "2027-01", "accountingMonthFor(12/25, 25) 年跨ぎ");
eq(accountingMonthFor("2026-07-26", 1), "2026-07", "accountingMonthFor(7/26, 1) 従来");
eq(daysRemainingInMonth("2026-07-26", 25), 30, "残り日数 7/26 開始日25（7/26〜8/24）");
eq(daysRemainingInMonth("2026-07-26", 1), 6, "残り日数 7/26 開始日1（従来と同値）");
eq(daysRemainingInMonth("2026-07-26"), 6, "残り日数 引数省略＝従来挙動");

// ---------------------------------------------------------------------------
console.log("== B9回帰: 開始日1（デフォルト）は従来のカレンダー月集計と完全一致 ==");
const U1 = "u1-default";
addUser(U1, "u1@example.com", 1);
income(U1, "2026-07-01", 100000);
spend(U1, "2026-06-30", 999); // 月外（含まれてはいけない）
spend(U1, "2026-07-01", 1000);
spend(U1, "2026-07-15", 2000);
spend(U1, "2026-07-31", 3000);
spend(U1, "2026-08-01", 888); // 月外
d.prepare(
  "INSERT INTO jobs (id, user_id, name, weekday_rate, weekend_holiday_rate, transport_per_shift, calendar_keywords, closing_day, pay_month_offset, pay_day) VALUES ('j1',?, 'job1', 1000, 1200, 0, '', 31, 0, 25)",
).run(U1);
// 平日 2026-07-06(月) 10:00-15:00 休憩60分 → 4h × 1000 = 4000
d.prepare(
  "INSERT INTO shifts (id, user_id, job_id, date, start_min, end_min, break_min) VALUES (?,?, 'j1', '2026-07-06', 600, 900, 60)",
).run(uid(), U1);
eq(getMonthStartDay(U1), 1, "getMonthStartDay(デフォルト)");
eq(monthRange(U1, "2026-07"), { start: "2026-07-01", end: "2026-07-31" }, "monthRange(u1, 2026-07)");
{
  const s = monthSummary(U1, "2026-07");
  // 従来ロジック（LIKE '2026-07-%'）で独立に計算して一致を確認
  const likeExp = d
    .prepare("SELECT COALESCE(SUM(amount),0) AS s FROM expenses WHERE user_id=? AND date LIKE '2026-07-%'")
    .get(U1).s;
  const likeInc = d
    .prepare("SELECT COALESCE(SUM(amount),0) AS s FROM incomes WHERE user_id=? AND date LIKE '2026-07-%'")
    .get(U1).s;
  eq(s.expenseTotal, likeExp, "monthSummary.expenseTotal == 従来LIKE集計");
  eq(s.expenseTotal, 6000, "monthSummary.expenseTotal 実額");
  eq(s.shift.total, 4000, "monthShiftIncome（末日締め当月払い＝従来）");
  eq(s.incomeTotal, likeInc + 4000, "monthSummary.incomeTotal == 従来LIKE集計＋シフト");
  const budget = dailyBudget(s, 0, 0, "2026-07-26", 0);
  const budgetOld = dailyBudget(s, 0, 0, "2026-07-26", 0, 1); // 明示的に開始日1
  eq(budget, budgetOld, "dailyBudget: 引数省略と開始日1が同値（回帰）");
  eq(budget.daysRemaining, 6, "dailyBudget.daysRemaining 従来");
}
eq(paydays(U1, "2026-07"), calendarPaydays(U1, "2026-07"), "paydays == calendarPaydays（開始日1）");
eq(paydays(U1, "2026-07")[0].date, "2026-07-25", "給料日 7/25（従来）");
eq(noMoneyDays(U1, "2026-06"), { count: 29, streak: 0 }, "NMD 過去月（6/30に支出・30日−1日）");

// ---------------------------------------------------------------------------
console.log("== B9: 開始日25（7/25〜8/24が「8月」） ==");
const U2 = "u2-day25";
addUser(U2, "u2@example.com", 25);
income(U2, "2026-07-24", 500); // 7月分
income(U2, "2026-07-25", 90000); // 8月分（給料日）
spend(U2, "2026-07-24", 1000); // 7月分
spend(U2, "2026-07-25", 2000); // 8月分
spend(U2, "2026-07-26", 700); // 8月分
spend(U2, "2026-08-24", 3000); // 8月分
spend(U2, "2026-08-25", 400); // 9月分
eq(getMonthStartDay(U2), 25, "getMonthStartDay(25)");
eq(monthRange(U2, "2026-08"), { start: "2026-07-25", end: "2026-08-24" }, "monthRange(u2, 2026-08)");
{
  const s7 = monthSummary(U2, "2026-07");
  const s8 = monthSummary(U2, "2026-08");
  const s9 = monthSummary(U2, "2026-09");
  eq(s7.expenseTotal, 1000, "7月（6/25〜7/24）支出");
  eq(s8.expenseTotal, 5700, "8月（7/25〜8/24）支出 = 2000+700+3000");
  eq(s9.expenseTotal, 400, "9月（8/25〜9/24）支出");
  eq(s7.incomeTotal, 500, "7月収入");
  eq(s8.incomeTotal, 90000, "8月収入（7/25の給料）");
  // 日次予算: 8月の集計月・today=7/26 で残り30日（7/26〜8/24）
  const budget = dailyBudget(s8, 700, 10000, "2026-07-26", 0, 25);
  eq(budget.daysRemaining, 30, "残り日数（7/26〜8/24=30日）");
  // 土台 = 90000 − 10000(貯金) − 0(固定) − 5000(今日以外の変動支出 7/25の2000＋8/24の3000) = 75000
  // ※「今日以外」の扱いは従来ロジックと同一（期間内の未来日付も spentBeforeToday に含まれる）
  eq(budget.monthRemaining, 75000, "予算の土台");
  eq(budget.todayBudget, 2500, "今日の予算 = 75000/30");
  eq(budget.remainingToday, 1800, "今日あと使える = 2500−700");
}
eq(categoryBreakdown(U2, "2026-08"), [{ category: "未分類", amount: 5700, count: 3 }], "カテゴリ内訳（期間ベース）");

// 給料日: 15日締め・翌月25日払い → 7/25支払い（5/16〜6/15勤務分）は集計上の「8月」に入る
d.prepare(
  "INSERT INTO jobs (id, user_id, name, weekday_rate, weekend_holiday_rate, transport_per_shift, calendar_keywords, closing_day, pay_month_offset, pay_day) VALUES ('j2',?, 'job2', 1000, 1000, 0, '', 15, 1, 25)",
).run(U2);
// 2026-06-10(水) 5h → 5000円 → 7/25支払い（集計8月）
d.prepare(
  "INSERT INTO shifts (id, user_id, job_id, date, start_min, end_min, break_min) VALUES (?,?, 'j2', '2026-06-10', 600, 900, 0)",
).run(uid(), U2);
// 2026-07-10(金) 3h → 3000円 → 8/25支払い（集計9月）
d.prepare(
  "INSERT INTO shifts (id, user_id, job_id, date, start_min, end_min, break_min) VALUES (?,?, 'j2', '2026-07-10', 600, 780, 0)",
).run(uid(), U2);
eq(monthShiftIncome(U2, "2026-08").total, 5000, "シフト収入: 7/25支払い分（6/10勤務）が「8月」");
eq(monthShiftIncome(U2, "2026-09").total, 3000, "シフト収入: 8/25支払い分（7/10勤務）が「9月」");
eq(
  paydays(U2, "2026-08").map((p) => ({ date: p.date, amount: p.amount })),
  [{ date: "2026-07-25", amount: 5000 }],
  "paydays(8月) = 7/25の給料日",
);
eq(
  paydays(U2, "2026-09").map((p) => ({ date: p.date, amount: p.amount })),
  [{ date: "2026-08-25", amount: 3000 }],
  "paydays(9月) = 8/25の給料日",
);

// 定期計上: カレンダー月キーのまま（支払日ベース）＝締め日変更でも二重計上しない
d.prepare(
  "INSERT INTO recurring_items (id, user_id, kind, name, amount, category_id, start_month, end_month, post_day) VALUES ('r1',?, 'expense', '家賃', 500, NULL, '2026-06', NULL, 27)",
).run(U2);
postRecurringForMonth(U2, "2026-07");
postRecurringForMonth(U2, "2026-07"); // 2回目（冪等）
postRecurringForMonth(U2, "2026-07"); // 3回目（冪等）
{
  const rows = d
    .prepare("SELECT date FROM expenses WHERE user_id=? AND source='recurring' ORDER BY date")
    .all(U2);
  eq(rows.map((r) => r.date), ["2026-06-27", "2026-07-27"], "定期計上はカレンダー月キーで2件のみ（二重計上なし）");
  eq(monthFixedCost(U2, "2026-07"), 500, "固定費: 6/27計上分は集計「7月」（6/25〜7/24）");
  eq(monthFixedCost(U2, "2026-08"), 500, "固定費: 7/27計上分は集計「8月」（7/25〜8/24）");
}

// NMD（実行日に依存するので、期待値をその場で計算して照合）
{
  const today = todayStr();
  const nmd = noMoneyDays(U2, "2026-08");
  // 期間 7/25〜min(today, 8/24)。支出があった日: 7/25, 7/26, 7/27(定期は除外), 8/24
  const range = { start: "2026-07-25", end: "2026-08-24" };
  const last = today < range.end ? today : range.end;
  const spentDays = new Set(
    d
      .prepare(
        "SELECT DISTINCT date AS dt FROM expenses WHERE user_id=? AND date>=? AND date<=? AND source!='recurring'",
      )
      .all(U2, range.start, last)
      .map((r) => r.dt),
  );
  let expectCount = 0;
  const dts = [];
  for (let t = new Date(2026, 6, 25); ; t.setDate(t.getDate() + 1)) {
    const s = `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, "0")}-${String(t.getDate()).padStart(2, "0")}`;
    if (s > last) break;
    dts.push(s);
    if (!spentDays.has(s)) expectCount++;
  }
  let expectStreak = 0;
  for (let i = dts.length - 1; i >= 0; i--) {
    if (spentDays.has(dts[i])) break;
    expectStreak++;
  }
  eq(nmd, { count: expectCount, streak: expectStreak }, `NMD 開始日25（期間7/25〜${last}）`);
}

// ---------------------------------------------------------------------------
console.log("== B5: パスワード再設定（forgot→reset→新PWログイン相当） ==");
const U3 = "u3-account";
addUser(U3, "u3@example.com", 1, "oldpass123");
eq(createPasswordReset("nobody@example.com"), null, "未登録メールは null（応答は同一文言）");
{
  const reset = createPasswordReset("u3@example.com");
  eq(!!reset && reset.userId === U3, true, "トークン発行");
  eq(isResetTokenValid(reset.token), true, "トークン有効");
  eq(consumePasswordReset(reset.token, "short"), "weak_password", "8文字未満は拒否（トークン未消費）");
  eq(consumePasswordReset(reset.token, "newpass456"), "ok", "リセット成功");
  const hash = d.prepare("SELECT password_hash FROM users WHERE id=?").get(U3).password_hash;
  eq(verifyPassword("newpass456", hash), true, "新PWでログイン可能（ハッシュ照合）");
  eq(verifyPassword("oldpass123", hash), false, "旧PWは無効");
  eq(consumePasswordReset(reset.token, "another123"), "invalid_token", "トークン再利用は拒否");
}
{
  // 期限切れトークン
  const reset = createPasswordReset("u3@example.com");
  d.prepare("UPDATE password_resets SET expires_at = ? WHERE user_id = ?").run(Date.now() - 1000, U3);
  eq(isResetTokenValid(reset.token), false, "期限切れは無効");
  eq(consumePasswordReset(reset.token, "whatever123"), "invalid_token", "期限切れリセットは拒否");
}
console.log("== B5: パスワード変更（ログイン中） ==");
eq(changePassword(U3, "wrongwrong", "nextpass789"), "wrong_password", "現PW違いは拒否");
eq(changePassword(U3, "newpass456", "short"), "weak_password", "8文字未満は拒否");
eq(changePassword(U3, "newpass456", "nextpass789"), "ok", "変更成功");
{
  const hash = d.prepare("SELECT password_hash FROM users WHERE id=?").get(U3).password_hash;
  eq(verifyPassword("nextpass789", hash), true, "変更後PWで照合OK");
}

// ---------------------------------------------------------------------------
console.log("== B5: アカウント削除（全テーブルからユーザー消滅） ==");
// U3に全テーブルへデータを撒く
d.prepare("INSERT INTO sessions (token, user_id, created_at) VALUES ('tok-u3', ?, ?)").run(U3, Date.now());
d.prepare("INSERT INTO categories (id, user_id, name, icon, sort) VALUES ('c3', ?, '食費', 'food', 0)").run(U3);
spend(U3, "2026-07-01", 100);
income(U3, "2026-07-01", 200);
d.prepare(
  "INSERT INTO receipts (id, user_id, store, taken_date, total, items_json, created_at) VALUES ('rc3', ?, 'store', '2026-07-01', 100, '[]', ?)",
).run(U3, Date.now());
d.prepare(
  "INSERT INTO jobs (id, user_id, name, weekday_rate, weekend_holiday_rate, transport_per_shift, calendar_keywords) VALUES ('j3', ?, 'job', 1000, 1000, 0, '')",
).run(U3);
d.prepare(
  "INSERT INTO shifts (id, user_id, job_id, date, start_min, end_min, break_min) VALUES ('s3', ?, 'j3', '2026-07-01', 600, 900, 0)",
).run(U3);
d.prepare(
  "INSERT INTO recurring_items (id, user_id, kind, name, amount, category_id, start_month, end_month, post_day) VALUES ('r3', ?, 'expense', 'サブスク', 100, NULL, '2026-07', NULL, 1)",
).run(U3);
postRecurringForMonth(U3, "2026-07"); // recurring_posts も作る
d.prepare("INSERT INTO quick_presets (id, user_id, label, amount, category_id, sort) VALUES ('q3', ?, 'コーヒー', 300, NULL, 0)").run(U3);
d.prepare("INSERT INTO category_budgets (user_id, category_id, amount) VALUES (?, 'c3', 5000)").run(U3);
d.prepare("INSERT INTO push_subscriptions (endpoint, user_id, subscription, created_at) VALUES ('ep3', ?, '{}', ?)").run(U3, Date.now());
d.prepare("INSERT INTO monthly_reviews (user_id, month, report, created_at) VALUES (?, '2026-06', '{}', ?)").run(U3, Date.now());
d.prepare("INSERT INTO merchant_categories (user_id, merchant, category_id, updated_at) VALUES (?, 'seven', 'c3', ?)").run(U3, Date.now());
d.prepare("INSERT INTO ai_usage (user_id, ym, scans, parses) VALUES (?, '2026-07', 1, 1)").run(U3);
createPasswordReset("u3@example.com"); // password_resets も作る

eq(deleteAccountWithPassword(U3, "wrong-password"), "wrong_password", "PW違いでは削除しない");
eq(d.prepare("SELECT COUNT(*) AS c FROM users WHERE id=?").get(U3).c, 1, "誤PW後もユーザー残存");
eq(deleteAccountWithPassword(U3, "nextpass789"), "ok", "正PWで削除成功");
const tables = [
  ["users", "id"],
  ["sessions", "user_id"],
  ["categories", "user_id"],
  ["expenses", "user_id"],
  ["incomes", "user_id"],
  ["receipts", "user_id"],
  ["jobs", "user_id"],
  ["shifts", "user_id"],
  ["recurring_items", "user_id"],
  ["quick_presets", "user_id"],
  ["category_budgets", "user_id"],
  ["push_subscriptions", "user_id"],
  ["monthly_reviews", "user_id"],
  ["merchant_categories", "user_id"],
  ["ai_usage", "user_id"],
  ["password_resets", "user_id"],
];
for (const [t, col] of tables) {
  eq(d.prepare(`SELECT COUNT(*) AS c FROM ${t} WHERE ${col} = ?`).get(U3).c, 0, `${t} から消滅`);
}
eq(
  d.prepare("SELECT COUNT(*) AS c FROM recurring_posts WHERE recurring_id = 'r3'").get().c,
  0,
  "recurring_posts から消滅（recurring_id 経由）",
);
// 他ユーザーのデータは無傷
eq(d.prepare("SELECT COUNT(*) AS c FROM expenses WHERE user_id=?").get(U2).c > 0, true, "他ユーザーの支出は無傷");
eq(d.prepare("SELECT COUNT(*) AS c FROM users").get().c, 2, "他ユーザーは残存（u1,u2）");

// ---------------------------------------------------------------------------
if (failed > 0) {
  console.error(`\n${failed} 件失敗`);
  process.exit(1);
}
console.log("\n全チェック合格");
