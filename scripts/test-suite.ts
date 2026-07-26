// sqlite / Postgres(PGlite) 両アダプタで共通実行するテストスイート。
// アプリ本体のドメインロジック（seedCategories / money / aiUsage）を
// setDbForTesting で注入したアダプタ経由で実際に呼ぶ。
import { randomBytes, scryptSync } from "node:crypto";
import { setDbForTesting, seedCategories, uid, type Db } from "../src/lib/db";
import { checkAndCountUsage, getUserPlan, FREE_LIMITS } from "../src/lib/aiUsage";
import {
  categoryBreakdown,
  currentMonth,
  isWeekendOrHoliday,
  monthShiftIncome,
  monthSummary,
  monthWorkIncome,
  postRecurringForMonth,
  todayStr,
} from "../src/lib/money";

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

// auth.ts の hashPassword と同じ形式（auth.ts は next/headers に依存するため直接importしない）
function hashPassword(password: string): string {
  const salt = randomBytes(16).toString("hex");
  return `${salt}:${scryptSync(password, salt, 64).toString("hex")}`;
}

export async function runSuite(d: Db): Promise<{ passed: number; failed: number }> {
  passed = 0;
  failed = 0;
  setDbForTesting(d);
  const month = currentMonth();
  const today = todayStr();

  // --- 1. ユーザー登録（scryptハッシュ・plan既定値） ---
  console.log("[1] ユーザー登録");
  const userId = uid();
  await d.run(
    "INSERT INTO users (id, email, name, password_hash, created_at) VALUES (?, ?, ?, ?, ?)",
    userId,
    "test@example.com",
    "テスト太郎",
    hashPassword("password123"),
    Date.now(),
  );
  const u = await d.get<{ email: string; name: string; plan: string }>(
    "SELECT email, name, plan FROM users WHERE id = ?",
    userId,
  );
  check("ユーザーが取得できる", u?.email === "test@example.com" && u?.name === "テスト太郎", u);
  check("新規ユーザーの plan は free", (await getUserPlan(userId)) === "free");

  // --- 2. カテゴリseed ---
  console.log("[2] カテゴリseed");
  await seedCategories(userId);
  const cats = await d.all<{ id: string; name: string }>(
    "SELECT id, name FROM categories WHERE user_id = ? ORDER BY sort",
    userId,
  );
  check("デフォルト14カテゴリが入る", cats.length === 14, cats.length);
  const foodCat = cats.find((c) => c.name === "食費")!;

  // --- 3. 支出CRUD ---
  console.log("[3] 支出CRUD");
  const expId = uid();
  await d.run(
    "INSERT INTO expenses (id, user_id, date, amount, category_id, memo, source, receipt_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    expId,
    userId,
    today,
    650,
    foodCat.id,
    "セブンで昼飯",
    "manual",
    null,
    Date.now(),
  );
  const exp = await d.get<{ amount: number; memo: string }>(
    "SELECT amount, memo FROM expenses WHERE id = ? AND user_id = ?",
    expId,
    userId,
  );
  check("支出を作成・取得できる", exp?.amount === 650 && exp?.memo === "セブンで昼飯", exp);
  await d.run("UPDATE expenses SET amount = ? WHERE id = ? AND user_id = ?", 700, expId, userId);
  const exp2 = await d.get<{ amount: number }>("SELECT amount FROM expenses WHERE id = ?", expId);
  check("支出を更新できる", exp2?.amount === 700, exp2);
  const listed = await d.all(
    `SELECT e.id, c.name AS category FROM expenses e
     LEFT JOIN categories c ON c.id = e.category_id AND c.user_id = e.user_id
     WHERE e.user_id = ? AND e.date LIKE ? ORDER BY e.date DESC, e.created_at DESC`,
    userId,
    `${month}-%`,
  );
  check("JOIN付き一覧が取れる", listed.length === 1 && (listed[0] as { category: string }).category === "食費", listed);
  await d.run("DELETE FROM expenses WHERE id = ? AND user_id = ?", expId, userId);
  const gone = await d.get("SELECT id FROM expenses WHERE id = ?", expId);
  check("支出を削除できる", gone === undefined);

  // --- 4. 収入・月次サマリー ---
  console.log("[4] 収入・月次サマリー");
  await d.run(
    "INSERT INTO incomes (id, user_id, date, amount, type, memo, created_at) VALUES (?, ?, ?, ?, 'other', ?, ?)",
    uid(),
    userId,
    today,
    10000,
    "お小遣い",
    Date.now(),
  );
  let summary = await monthSummary(userId, month);
  check("収入がサマリーに反映される", summary.incomeTotal === 10000, summary);
  check("SUMがnumberで返る", typeof summary.incomeTotal === "number");

  // --- 5. バイト先・シフト・給与計算 ---
  console.log("[5] シフト・給与計算");
  const jobId = uid();
  await d.run(
    "INSERT INTO jobs (id, user_id, name, weekday_rate, weekend_holiday_rate, transport_per_shift, calendar_keywords, calendar_exclude, color, closing_day, pay_month_offset, pay_day, pay_same_day) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    jobId,
    userId,
    "キミハン",
    1000,
    1200,
    100,
    "",
    "",
    "#e8442e",
    31,
    0,
    25,
    0,
  );
  await d.run(
    "INSERT INTO shifts (id, user_id, job_id, date, start_min, end_min, break_min, source) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    uid(),
    userId,
    jobId,
    today,
    1080, // 18:00
    1320, // 22:00
    0,
    "manual",
  );
  const rate = isWeekendOrHoliday(today) ? 1200 : 1000;
  const expectedPay = 4 * rate + 100;
  const work = await monthWorkIncome(userId, month);
  check(`monthWorkIncome が計算どおり（${expectedPay}円）`, work.total === expectedPay, work);
  const shiftInc = await monthShiftIncome(userId, month);
  check("monthShiftIncome（末日締め当月払い）が一致", shiftInc.total === expectedPay, shiftInc);
  summary = await monthSummary(userId, month);
  check("サマリーにシフト収入が乗る", summary.incomeTotal === 10000 + expectedPay, summary);

  // --- 6. 定期計上（冪等性） ---
  console.log("[6] 定期計上");
  await d.run(
    "INSERT INTO recurring_items (id, user_id, kind, name, amount, category_id, start_month, end_month, post_day) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    uid(),
    userId,
    "expense",
    "サブスク",
    500,
    null,
    month,
    null,
    1,
  );
  await postRecurringForMonth(userId, month);
  await postRecurringForMonth(userId, month); // 2回目はスキップされるはず
  const recCount = (await d.get<{ c: number }>(
    "SELECT COUNT(*) AS c FROM expenses WHERE user_id = ? AND source = 'recurring'",
    userId,
  ))!;
  check("定期計上が1回だけ実体化される（冪等）", recCount.c === 1, recCount);

  // --- 7. カテゴリ別集計（GROUP BY の方言互換） ---
  console.log("[7] カテゴリ別集計");
  const breakdown = await categoryBreakdown(userId, month);
  check(
    "categoryBreakdown が未分類500円を返す",
    breakdown.length === 1 && breakdown[0].category === "未分類" && Number(breakdown[0].amount) === 500,
    breakdown,
  );

  // --- 8. 予算のUPSERT ---
  console.log("[8] 予算UPSERT");
  const upsert =
    "INSERT INTO category_budgets (user_id, category_id, amount) VALUES (?, ?, ?) ON CONFLICT (user_id, category_id) DO UPDATE SET amount = excluded.amount";
  await d.run(upsert, userId, foodCat.id, 30000);
  await d.run(upsert, userId, foodCat.id, 25000);
  const budget = await d.get<{ amount: number }>(
    "SELECT amount FROM category_budgets WHERE user_id = ? AND category_id = ?",
    userId,
    foodCat.id,
  );
  check("2回目のUPSERTで上書きされる", budget?.amount === 25000, budget);

  // --- 9. トランザクション（レシート＋支出のセット保存） ---
  console.log("[9] トランザクション");
  const receiptId = uid();
  await d.transaction(async (tx) => {
    await tx.run(
      "INSERT INTO receipts (id, user_id, store, taken_date, total, items_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      receiptId,
      userId,
      "スーパー",
      today,
      1234,
      "[]",
      Date.now(),
    );
    await tx.run(
      "INSERT INTO expenses (id, user_id, date, amount, category_id, memo, source, receipt_id, created_at) VALUES (?, ?, ?, ?, ?, ?, 'receipt', ?, ?)",
      uid(),
      userId,
      today,
      1234,
      foodCat.id,
      "スーパー",
      receiptId,
      Date.now(),
    );
  });
  const savedReceipt = await d.get("SELECT id FROM receipts WHERE id = ?", receiptId);
  check("トランザクションでセット保存できる", savedReceipt !== undefined);

  const before = (await d.get<{ c: number }>(
    "SELECT COUNT(*) AS c FROM receipts WHERE user_id = ?",
    userId,
  ))!.c;
  try {
    await d.transaction(async (tx) => {
      await tx.run(
        "INSERT INTO receipts (id, user_id, store, taken_date, total, items_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
        uid(),
        userId,
        "失敗する店",
        today,
        1,
        "[]",
        Date.now(),
      );
      throw new Error("boom"); // 途中失敗 → ロールバックされるはず
    });
  } catch {
    /* expected */
  }
  const after = (await d.get<{ c: number }>(
    "SELECT COUNT(*) AS c FROM receipts WHERE user_id = ?",
    userId,
  ))!.c;
  check("失敗時にロールバックされる", after === before, { before, after });

  // --- 10. AI使用量とプラン上限 ---
  console.log("[10] ai_usage・プラン上限");
  let blocked = false;
  for (let i = 0; i < FREE_LIMITS.scans; i++) {
    const r = await checkAndCountUsage(userId, "free", "scans");
    if (!r.allowed) blocked = true;
  }
  check(`freeは${FREE_LIMITS.scans}回までスキャン可`, !blocked);
  const over = await checkAndCountUsage(userId, "free", "scans");
  check("上限超過でブロックされる", !over.allowed && over.used === FREE_LIMITS.scans, over);
  const parse1 = await checkAndCountUsage(userId, "free", "parses");
  check("スキャン上限はパース枠に影響しない", parse1.allowed && parse1.used === 1, parse1);
  await d.run("UPDATE users SET plan = 'premium' WHERE id = ?", userId);
  check("プラン変更が読める", (await getUserPlan(userId)) === "premium");
  const prem = await checkAndCountUsage(userId, "premium", "scans");
  check("premiumは上限なし", prem.allowed && prem.limit === null, prem);
  const usageRow = await d.get<{ scans: number; parses: number }>(
    "SELECT scans, parses FROM ai_usage WHERE user_id = ? AND ym = ?",
    userId,
    month,
  );
  check(
    "使用量が正しく記録される",
    usageRow?.scans === FREE_LIMITS.scans + 1 && usageRow?.parses === 1,
    usageRow,
  );

  console.log(`\n結果: ${passed} passed / ${failed} failed`);
  return { passed, failed };
}
