// sqlite / Postgres(PGlite) 両アダプタで共通実行するテストスイート。
// アプリ本体のドメインロジック（seedCategories / money / aiUsage）を
// setDbForTesting で注入したアダプタ経由で実際に呼ぶ。
import { randomBytes, scryptSync } from "node:crypto";
import { isCategoryIconKey, stripCategoryEmoji } from "../src/lib/categoryIcons";
import { migrateCategoryIcons, setDbForTesting, seedCategories, uid, type Db } from "../src/lib/db";
import {
  checkAndCountUsage,
  getAiUsageDisplay,
  getUserPlan,
  FREE_LIMITS,
  PREMIUM_SCAN_LIMIT,
} from "../src/lib/aiUsage";
import { applyPurchaseEvent, setPlanFromEntitlement } from "../src/lib/purchases-server";
import {
  duplicateExpenseExists,
  duplicateIncomeExists,
  imageHashOf,
  learnMerchantCategory,
  learnedCategoryId,
  normalizeMerchant,
  recordedImage,
} from "../src/lib/merchant";
import {
  accountingMonthFor,
  calendarPaydays,
  categoryBreakdown,
  currentMonth,
  dailyBudget,
  daysRemainingInMonth,
  getMonthStartDay,
  isWeekendOrHoliday,
  monthFixedCost,
  monthPlan,
  monthRange,
  monthRangeFor,
  monthShiftIncome,
  monthSummary,
  monthWorkIncome,
  nextPayday,
  noMoneyDays,
  paydays,
  pocketBudgets,
  postRecurringForMonth,
  searchExpenses,
  todaySpent,
  todayStr,
} from "../src/lib/money";
import { collectExportRows, toCsv } from "../src/lib/exportCsv";
import { decodeCsvBuffer, mapCsv, normalizeDate, parseCsv, resolveCategoryId } from "../src/lib/importCsv";
import {
  changePassword,
  consumePasswordReset,
  createPasswordReset,
  deleteAccountWithPassword,
  isResetTokenValid,
} from "../src/lib/account";
import {
  accountsOverview,
  createAccount,
  deleteAccount,
  listAccounts,
  netWorthOf,
  netWorthTrend,
  normalizeBalance,
  normalizeKind,
  snapshotNetWorth,
  updateAccount,
} from "../src/lib/accounts";
import { verifyPassword } from "../src/lib/password";

/** 'YYYY-MM' に delta ヶ月足す（テスト用） */
function addMonths(month: string, delta: number): string {
  const [y, m] = month.split("-").map(Number);
  const d = new Date(y, m - 1 + delta, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

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
  const cats = await d.all<{ id: string; name: string; icon: string }>(
    "SELECT id, name, icon FROM categories WHERE user_id = ? ORDER BY sort",
    userId,
  );
  check("デフォルト14カテゴリが入る", cats.length === 14, cats.length);
  check(
    "seed直後のiconは全てアイコンキー（絵文字なし）",
    cats.every((c) => isCategoryIconKey(c.icon)),
    cats.map((c) => c.icon),
  );
  check(
    "seed直後のカテゴリ名に絵文字がない",
    cats.every((c) => stripCategoryEmoji(c.name) === c.name),
    cats.map((c) => c.name),
  );
  const foodCat = cats.find((c) => c.name === "食費")!;
  check("食費のiconは food", foodCat.icon === "food", foodCat.icon);

  // --- 2b. 絵文字カテゴリのマイグレーション（冪等） ---
  console.log("[2b] 絵文字カテゴリのマイグレーション");
  const legacyUser = uid();
  const legacy: [string, string][] = [
    ["サブスク🔁", "🔁"], // 旧標準（名前にも絵文字が付いた形）
    ["旅行✈️", "✈️"], // FE0F付き絵文字
    ["食費", "🍚"], // 名前は綺麗・iconだけ絵文字
    ["推し活🎤", ""], // ユーザー独自（icon未設定）→ デフォルトのタグ
    ["美容", ""], // 標準名でicon空 → 名前から復元
  ];
  for (let i = 0; i < legacy.length; i++) {
    await d.run(
      "INSERT INTO categories (id, user_id, name, icon, sort) VALUES (?, ?, ?, ?, ?)",
      uid(),
      legacyUser,
      legacy[i][0],
      legacy[i][1],
      i,
    );
  }
  const changed1 = await migrateCategoryIcons(d);
  const migrated = await d.all<{ name: string; icon: string }>(
    "SELECT name, icon FROM categories WHERE user_id = ? ORDER BY sort",
    legacyUser,
  );
  check("旧カテゴリ5件が全て変換される", changed1 >= 5, changed1);
  check(
    "「サブスク🔁」→ name=サブスク / icon=subscription",
    migrated[0]?.name === "サブスク" && migrated[0]?.icon === "subscription",
    migrated[0],
  );
  check(
    "「旅行✈️」→ name=旅行 / icon=travel",
    migrated[1]?.name === "旅行" && migrated[1]?.icon === "travel",
    migrated[1],
  );
  check("icon絵文字🍚 → food", migrated[2]?.icon === "food", migrated[2]);
  check(
    "独自カテゴリは絵文字除去＋デフォルトのタグ",
    migrated[3]?.name === "推し活" && migrated[3]?.icon === "tag",
    migrated[3],
  );
  check("標準名でicon空 → 名前から復元（美容=beauty）", migrated[4]?.icon === "beauty", migrated[4]);
  check(
    "マイグレーション後の全カテゴリ名に絵文字がない（AIプロンプトにも絵文字が乗らない）",
    (await d.all<{ name: string }>("SELECT name FROM categories WHERE user_id = ?", legacyUser)).every(
      (c) => stripCategoryEmoji(c.name) === c.name,
    ),
  );
  const changed2 = await migrateCategoryIcons(d);
  check("2回目の実行では何も変わらない（冪等）", changed2 === 0, changed2);
  await d.run("DELETE FROM categories WHERE user_id = ?", legacyUser);

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

  // 年払い（interval='yearly'）：開始月と同じ月だけ、毎年1回計上される
  // カテゴリ別集計等（当月LIKE）に影響しないよう、過去の固定月でテストする
  const yearlyId = uid();
  await d.run(
    "INSERT INTO recurring_items (id, user_id, kind, name, amount, category_id, start_month, end_month, post_day, interval) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    yearlyId,
    userId,
    "expense",
    "年払いサブスク",
    9800,
    null,
    "2024-03",
    null,
    15,
    "yearly",
  );
  const yearlyRows = async () =>
    d.all<{ date: string }>(
      "SELECT date FROM expenses WHERE user_id = ? AND memo = ? ORDER BY date",
      userId,
      "年払いサブスク",
    );
  await postRecurringForMonth(userId, "2025-02");
  let yr = await yearlyRows();
  check("年払いは対象月(2024-03)に1回だけ計上", yr.length === 1 && yr[0].date === "2024-03-15", yr);
  await postRecurringForMonth(userId, "2025-06");
  yr = await yearlyRows();
  check("翌年の対象月(2025-03)にまた計上される", yr.length === 2 && yr[1].date === "2025-03-15", yr);
  await postRecurringForMonth(userId, "2025-06"); // 再実行しても増えない
  yr = await yearlyRows();
  check("年払いも冪等（再実行で増えない）", yr.length === 2, yr);
  const yearlyMarks = await d.all<{ month: string }>(
    "SELECT month FROM recurring_posts WHERE recurring_id = ? ORDER BY month",
    yearlyId,
  );
  check(
    "recurring_posts のmarkは対象月のみ",
    yearlyMarks.length === 2 && yearlyMarks[0].month === "2024-03" && yearlyMarks[1].month === "2025-03",
    yearlyMarks,
  );

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
  check(
    `premiumのスキャンはフェアユース上限${PREMIUM_SCAN_LIMIT}回つきで通る`,
    prem.allowed && prem.limit === PREMIUM_SCAN_LIMIT,
    prem,
  );
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

  // --- 10b. premiumフェアユース（月200スキャン）とfounder無制限 ---
  console.log("[10b] premiumフェアユース・founder無制限");
  await d.run(
    "UPDATE ai_usage SET scans = ? WHERE user_id = ? AND ym = ?",
    PREMIUM_SCAN_LIMIT - 1,
    userId,
    month,
  );
  const premLast = await checkAndCountUsage(userId, "premium", "scans");
  check(
    `premiumは${PREMIUM_SCAN_LIMIT}回目まで通る`,
    premLast.allowed && premLast.used === PREMIUM_SCAN_LIMIT,
    premLast,
  );
  const premOver = await checkAndCountUsage(userId, "premium", "scans");
  check(
    `premiumは${PREMIUM_SCAN_LIMIT + 1}回目でブロック（フェアユース）`,
    !premOver.allowed && premOver.used === PREMIUM_SCAN_LIMIT && premOver.limit === PREMIUM_SCAN_LIMIT,
    premOver,
  );
  const premParse = await checkAndCountUsage(userId, "premium", "parses");
  check("premiumのパースは無制限のまま", premParse.allowed && premParse.limit === null, premParse);
  const founderScan = await checkAndCountUsage(userId, "founder", "scans");
  check(
    `founderは${PREMIUM_SCAN_LIMIT}回超でも無制限`,
    founderScan.allowed && founderScan.limit === null,
    founderScan,
  );

  // --- 10c. 課金Webhook → plan切替（founder不変） ---
  console.log("[10c] 課金Webhook → plan切替");
  const buyerId = uid();
  await d.run(
    "INSERT INTO users (id, email, name, password_hash, created_at) VALUES (?, ?, ?, ?, ?)",
    buyerId,
    "buyer@example.com",
    "課金太郎",
    hashPassword("password123"),
    Date.now(),
  );
  const now = Date.now();
  let ev = await applyPurchaseEvent(buyerId, "INITIAL_PURCHASE");
  check("INITIAL_PURCHASE で free → premium", ev.plan === "premium" && ev.changed, ev);
  check("DB上も premium になっている", (await getUserPlan(buyerId)) === "premium");
  ev = await applyPurchaseEvent(buyerId, "CANCELLATION", { expirationAtMs: now + 86_400_000, now });
  check("CANCELLATION（期限まだ先）は premium のまま", ev.plan === "premium" && !ev.changed, ev);
  ev = await applyPurchaseEvent(buyerId, "EXPIRATION");
  check("EXPIRATION で premium → free", ev.plan === "free" && ev.changed, ev);
  ev = await applyPurchaseEvent(buyerId, "RENEWAL");
  check("RENEWAL で premium に戻る", ev.plan === "premium" && ev.changed, ev);
  ev = await applyPurchaseEvent(buyerId, "CANCELLATION", { expirationAtMs: now - 1000, now });
  check("CANCELLATION（期限切れ・返金等）で free に落ちる", ev.plan === "free" && ev.changed, ev);
  ev = await applyPurchaseEvent(buyerId, "BILLING_ISSUE");
  check("対象外イベントでは plan は変わらない", ev.plan === "free" && !ev.changed, ev);
  ev = await applyPurchaseEvent(uid(), "INITIAL_PURCHASE");
  check("未知ユーザーは plan=null（スキップ）", ev.plan === null && !ev.changed, ev);
  // founder は購入・失効イベントが来ても常に不変
  const founderId = uid();
  await d.run(
    "INSERT INTO users (id, email, name, password_hash, created_at, plan) VALUES (?, ?, ?, ?, ?, 'founder')",
    founderId,
    "founder@example.com",
    "創業花子",
    hashPassword("password123"),
    Date.now(),
  );
  ev = await applyPurchaseEvent(founderId, "INITIAL_PURCHASE");
  check("founderはINITIAL_PURCHASEでも不変", ev.plan === "founder" && !ev.changed, ev);
  ev = await applyPurchaseEvent(founderId, "EXPIRATION");
  check("founderはEXPIRATIONでも降格しない", ev.plan === "founder" && !ev.changed, ev);
  check("DB上もfounderのまま", (await getUserPlan(founderId)) === "founder");
  // /api/purchases/sync 用の entitlement 直接反映
  check("sync: entitlement有効 → premium", (await setPlanFromEntitlement(buyerId, true)) === "premium");
  check("sync: entitlement無効 → free", (await setPlanFromEntitlement(buyerId, false)) === "free");
  check("sync: founderは不変", (await setPlanFromEntitlement(founderId, false)) === "founder");
  check("sync: 未知ユーザーは null", (await setPlanFromEntitlement(uid(), true)) === null);

  // --- 11. マーチャント学習（店名→ユーザー確定カテゴリ） ---
  console.log("[11] マーチャント学習");
  check(
    "normalizeMerchant（trim・全角英数→半角・小文字化・空白統合）",
    normalizeMerchant("  ＲｏｃｋｅｔＮｏｗ　渋谷店 ") === "rocketnow 渋谷店" &&
      normalizeMerchant("Rocket  Now") === "rocket now",
  );
  const gameCat = cats.find((c) => c.name === "娯楽")!;
  // 誤分類シナリオ：ロケットナウをAIが「娯楽」と提案 → 初回は学習なし
  check("初回は学習なし（AI提案がそのまま）", (await learnedCategoryId(userId, "ロケットナウ")) === null);
  // ユーザーが確認シートで「食費」に修正して保存 → 学習
  await learnMerchantCategory(userId, "ロケットナウ", foodCat.id);
  check(
    "修正保存で学習され、次回は学習値がAI提案より優先",
    (await learnedCategoryId(userId, "ロケットナウ ")) === foodCat.id,
  );
  check(
    "表記ゆれ（全角/大小文字）でも学習が当たる",
    (await (async () => {
      await learnMerchantCategory(userId, "ROCKET NOW", foodCat.id);
      return learnedCategoryId(userId, "ｒｏｃｋｅｔ　ｎｏｗ");
    })()) === foodCat.id,
  );
  // upsert：再修正で上書き・行は増えない
  await learnMerchantCategory(userId, "ロケットナウ", gameCat.id);
  const learnedRows = (await d.get<{ c: number }>(
    "SELECT COUNT(*) AS c FROM merchant_categories WHERE user_id = ? AND merchant = ?",
    userId,
    "ロケットナウ",
  ))!;
  check(
    "再修正でupsert上書き（行は増えない）",
    (await learnedCategoryId(userId, "ロケットナウ")) === gameCat.id && Number(learnedRows.c) === 1,
    learnedRows,
  );
  // 削除済みカテゴリの学習は適用しない
  const tmpCatId = uid();
  await d.run(
    "INSERT INTO categories (id, user_id, name, icon, sort) VALUES (?, ?, ?, ?, ?)",
    tmpCatId,
    userId,
    "一時カテゴリ",
    "tag",
    99,
  );
  await learnMerchantCategory(userId, "閉店した店", tmpCatId);
  await d.run("DELETE FROM categories WHERE id = ?", tmpCatId);
  check("カテゴリ削除後は学習値を適用しない", (await learnedCategoryId(userId, "閉店した店")) === null);

  // --- 12. 重複保存ガード（スキャン/ショートカット自動保存用） ---
  // 仕様：検出したら即拒否ではなく「確認つき許可」。
  // アプリ内スキャンは 409 を受けてユーザー確認 → allowDuplicate: true の再送信で保存できる
  // （＝同一内容の行がDBに複数存在できる）。ショートカット自動保存は対話不可なので常にブロック。
  console.log("[12] 重複保存ガード（確認つき許可）");
  await d.run(
    "INSERT INTO expenses (id, user_id, date, amount, category_id, memo, source, receipt_id, created_at) VALUES (?, ?, ?, ?, ?, ?, 'receipt', ?, ?)",
    uid(),
    userId,
    today,
    2113,
    foodCat.id,
    "ロケットナウ",
    null,
    Date.now(),
  );
  check("同一ユーザー×日付×金額×memoの支出を検出", await duplicateExpenseExists(userId, today, 2113, "ロケットナウ"));
  check(
    "金額/日付/memo/ユーザーが違えば重複扱いしない",
    !(await duplicateExpenseExists(userId, today, 2114, "ロケットナウ")) &&
      !(await duplicateExpenseExists(userId, "2000-01-01", 2113, "ロケットナウ")) &&
      !(await duplicateExpenseExists(userId, today, 2113, "セブンイレブン")) &&
      !(await duplicateExpenseExists(uid(), today, 2113, "ロケットナウ")),
  );
  await d.run(
    "INSERT INTO incomes (id, user_id, date, amount, type, memo, created_at) VALUES (?, ?, ?, ?, 'other', ?, ?)",
    uid(),
    userId,
    today,
    5000,
    "PayPay受け取り",
    Date.now(),
  );
  check("収入の重複も検出", await duplicateIncomeExists(userId, today, 5000, "PayPay受け取り"));
  check("memoが違う収入は重複扱いしない", !(await duplicateIncomeExists(userId, today, 5000, "別の人から")));
  // 「本当に同じものを2回買った」ケース：ユーザーが確認して allowDuplicate: true で再送信すると
  // API は同一内容でも保存する。DBレベルで同一内容の2行目が保存できることを確認する。
  await d.run(
    "INSERT INTO expenses (id, user_id, date, amount, category_id, memo, source, receipt_id, created_at) VALUES (?, ?, ?, ?, ?, ?, 'receipt', ?, ?)",
    uid(),
    userId,
    today,
    2113,
    foodCat.id,
    "ロケットナウ",
    null,
    Date.now(),
  );
  const dupRows = (await d.get<{ c: number | string }>(
    "SELECT COUNT(*) AS c FROM expenses WHERE user_id = ? AND date = ? AND amount = ? AND memo = ?",
    userId,
    today,
    2113,
    "ロケットナウ",
  ))!;
  check("確認つき許可（allowDuplicate相当）で同一内容の2件目を保存できる", Number(dupRows.c) === 2, dupRows);
  check(
    "2件保存後も重複として検出される（3件目もまず409で確認される）",
    await duplicateExpenseExists(userId, today, 2113, "ロケットナウ"),
  );

  // --- 13. かんたん入力ボタン（quick_presets）とワンタップ記録 ---
  // 設定で登録したプリセットを、ホームで1タップ→即記録→Undo削除する流れのDBレベル検証。
  console.log("[13] かんたん入力ボタン（プリセット）");
  const transportCat = cats.find((c) => c.name === "交通")!;
  const presetId = uid();
  await d.run(
    "INSERT INTO quick_presets (id, user_id, label, amount, category_id, sort) VALUES (?, ?, ?, ?, ?, ?)",
    presetId,
    userId,
    "Suicaチャージ",
    1000,
    transportCat.id,
    0,
  );
  await d.run(
    "INSERT INTO quick_presets (id, user_id, label, amount, category_id, sort) VALUES (?, ?, ?, ?, ?, ?)",
    uid(),
    userId,
    "コインランドリー",
    300,
    null,
    1,
  );
  const presetList = await d.all<{
    id: string;
    label: string;
    amount: number;
    category: string | null;
    icon: string | null;
  }>(
    `SELECT p.id, p.label, p.amount, c.name AS category, c.icon
     FROM quick_presets p
     LEFT JOIN categories c ON c.id = p.category_id AND c.user_id = p.user_id
     WHERE p.user_id = ? ORDER BY p.sort`,
    userId,
  );
  check(
    "プリセット一覧がsort順＋カテゴリJOINで取れる",
    presetList.length === 2 &&
      presetList[0].label === "Suicaチャージ" &&
      presetList[0].category === "交通" &&
      presetList[0].icon === "transport" &&
      presetList[1].category === null,
    presetList,
  );
  check(
    "他ユーザーのプリセットは見えない",
    (await d.all("SELECT id FROM quick_presets WHERE user_id = ?", uid())).length === 0,
  );
  // ワンタップ記録：date=今日・memo=プリセット名・source='quick'。
  // 同じボタンを1日2回押すのは正当（Suicaチャージ2回等）なので、同一内容でも2件保存できること。
  const tap = async () => {
    const eid = uid();
    await d.run(
      "INSERT INTO expenses (id, user_id, date, amount, category_id, memo, source, receipt_id, created_at) VALUES (?, ?, ?, ?, ?, ?, 'quick', ?, ?)",
      eid,
      userId,
      today,
      1000,
      transportCat.id,
      "Suicaチャージ",
      null,
      Date.now(),
    );
    return eid;
  };
  await tap();
  const tap2 = await tap();
  const quickRows = (await d.get<{ c: number | string }>(
    "SELECT COUNT(*) AS c FROM expenses WHERE user_id = ? AND source = 'quick' AND date = ? AND memo = ?",
    userId,
    today,
    "Suicaチャージ",
  ))!;
  check("同じボタンを1日2回押しても両方記録される（重複ガード対象外）", Number(quickRows.c) === 2, quickRows);
  // Undo（トーストの「元に戻す」）：直前の1件だけ削除される
  const undo = await d.run("DELETE FROM expenses WHERE id = ? AND user_id = ?", tap2, userId);
  const afterUndo = (await d.get<{ c: number | string }>(
    "SELECT COUNT(*) AS c FROM expenses WHERE user_id = ? AND source = 'quick' AND memo = ?",
    userId,
    "Suicaチャージ",
  ))!;
  check("Undoで直前の1件だけ削除される", undo.changes === 1 && Number(afterUndo.c) === 1, afterUndo);
  // プリセット削除（設定画面の✕）：本人のものだけ消せる
  await d.run("DELETE FROM quick_presets WHERE id = ? AND user_id = ?", presetId, uid());
  check(
    "他ユーザーはプリセットを削除できない",
    (await d.get("SELECT id FROM quick_presets WHERE id = ?", presetId)) !== undefined,
  );
  await d.run("DELETE FROM quick_presets WHERE id = ? AND user_id = ?", presetId, userId);
  check(
    "本人はプリセットを削除できる",
    (await d.get("SELECT id FROM quick_presets WHERE id = ?", presetId)) === undefined,
  );
  // 上限判定（APIの12個制限）と同じCOUNTが方言差なくnumberで判定できること
  const presetCount = (await d.get<{ n: number | string }>(
    "SELECT COUNT(*) AS n FROM quick_presets WHERE user_id = ?",
    userId,
  ))!;
  check("上限判定用COUNTが取れる（残1個）", Number(presetCount.n) === 1, presetCount);

  // --- 14. 未来月の「予定」計算（monthPlan：実体化しない読み取り専用） ---
  console.log("[14] 未来月の予定（monthPlan）");
  const m1 = addMonths(month, 1);
  const m2 = addMonths(month, 2);
  // 分割払い（設定画面と同じ形式：end_month 付き・名前に（分割N回））
  await d.run(
    "INSERT INTO recurring_items (id, user_id, kind, name, amount, category_id, start_month, end_month, post_day) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    uid(),
    userId,
    "expense",
    "ゲーム機（分割3回）",
    2000,
    null,
    m1,
    addMonths(m1, 2),
    27,
  );
  // 年払い：来月と同じ「月」に毎年計上（来月の予定に出るはず）
  await d.run(
    "INSERT INTO recurring_items (id, user_id, kind, name, amount, category_id, start_month, end_month, post_day, interval) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    uid(),
    userId,
    "expense",
    "保険（年払い）",
    12000,
    null,
    `${Number(m1.slice(0, 4)) - 1}-${m1.slice(5)}`,
    null,
    10,
    "yearly",
  );
  // 定期収入（来月開始なのでまだ実体化されない）
  await d.run(
    "INSERT INTO recurring_items (id, user_id, kind, name, amount, category_id, start_month, end_month, post_day) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    uid(),
    userId,
    "income",
    "仕送り",
    3000,
    null,
    m1,
    null,
    20,
  );
  // 来月の確定シフト（キミハンは末日締め当月払い・25日払い → 来月の給料日に金額が乗る）
  const futureShiftDate = `${m1}-05`;
  await d.run(
    "INSERT INTO shifts (id, user_id, job_id, date, start_min, end_min, break_min, source) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    uid(),
    userId,
    jobId,
    futureShiftDate,
    540, // 09:00
    720, // 12:00
    0,
    "manual",
  );
  const futurePay = 3 * (isWeekendOrHoliday(futureShiftDate) ? 1200 : 1000) + 100;

  const plan1 = await monthPlan(userId, m1);
  check(
    "来月予定: 月払いサブスクが post_day に入る",
    plan1.expenses.some((e) => e.name === "サブスク" && e.date === `${m1}-01` && e.amount === 500),
    plan1.expenses,
  );
  check(
    "来月予定: 分割払いが27日に入る",
    plan1.expenses.some((e) => e.name === "ゲーム機（分割3回）" && e.date === `${m1}-27` && e.amount === 2000),
    plan1.expenses,
  );
  check(
    "来月予定: 年払いは該当月なので入る",
    plan1.expenses.some((e) => e.name === "保険（年払い）" && e.date === `${m1}-10` && e.amount === 12000),
    plan1.expenses,
  );
  const oldYearlyIn = (mm: string) => (mm.slice(5) === "03" ? 9800 : 0); // 既存の「年払いサブスク」（3月計上）が重なる月だけ加算
  check(
    "来月予定: 支出合計が一致",
    plan1.expenseTotal === 500 + 2000 + 12000 + oldYearlyIn(m1),
    plan1.expenseTotal,
  );
  check(
    "来月予定: 定期収入が入る",
    plan1.incomes.some((i) => i.name === "仕送り" && i.date === `${m1}-20` && i.amount === 3000),
    plan1.incomes,
  );
  check(
    "来月予定: 確定シフトの給料日（金額つき・confirmed）",
    plan1.paydays.some((p) => p.date === `${m1}-25` && p.amount === futurePay && p.confirmed),
    plan1.paydays,
  );
  check("来月予定: 収入合計 = 定期収入 + 確定給料", plan1.incomeTotal === 3000 + futurePay, plan1.incomeTotal);

  const plan2 = await monthPlan(userId, m2);
  check(
    "再来月予定: 分割は期間内なのでまだ入る",
    plan2.expenses.some((e) => e.name === "ゲーム機（分割3回）"),
    plan2.expenses,
  );
  check(
    "再来月予定: 年払いは月違いなので入らない",
    plan2.expenses.every((e) => e.name !== "保険（年払い）"),
    plan2.expenses,
  );
  check(
    "再来月予定: シフト未入力の給料日はマーカーのみ（金額0・未確定）",
    plan2.paydays.some((p) => p.date === `${m2}-25` && p.amount === 0 && !p.confirmed),
    plan2.paydays,
  );
  const plan4 = await monthPlan(userId, addMonths(m1, 3));
  check(
    "分割終了後の月には分割が入らない",
    plan4.expenses.every((e) => e.name !== "ゲーム機（分割3回）"),
    plan4.expenses,
  );
  check(
    "分割終了後も無期限の定期は入り続ける",
    plan4.expenses.some((e) => e.name === "サブスク"),
    plan4.expenses,
  );

  // 当月・過去月は空（当月は月初一括計上済みのため二重表示しない）
  const planNow = await monthPlan(userId, month);
  check(
    "当月の予定は常に空（実記録との二重表示なし）",
    planNow.expenses.length === 0 && planNow.incomes.length === 0 && planNow.paydays.length === 0,
    planNow,
  );
  const planPast = await monthPlan(userId, addMonths(month, -1));
  check(
    "過去月の予定は常に空",
    planPast.expenses.length === 0 && planPast.incomes.length === 0 && planPast.paydays.length === 0,
    planPast,
  );

  // 読み取り専用・冪等：何度呼んでもレコードは実体化されない
  await monthPlan(userId, m1);
  const m1Rows = (await d.get<{ c: number | string }>(
    "SELECT (SELECT COUNT(*) FROM expenses WHERE user_id = ? AND date LIKE ?) + (SELECT COUNT(*) FROM incomes WHERE user_id = ? AND date LIKE ?) AS c",
    userId,
    `${m1}-%`,
    userId,
    `${m1}-%`,
  ))!;
  check("monthPlan は何度呼んでも実体化しない（読み取り専用）", Number(m1Rows.c) === 0, m1Rows);

  // --- 15. 今日使えるお金（日次予算＋繰り越し方式） ---
  // 予算は「昨日までの変動支出」で割り、今日の変動支出は満額引く。使いすぎは即マイナス表示＆翌日予算が自動減。
  // 固定費（定期計上 source='recurring'）は月初に満額を土台から先取りし、日々の数字には含めない（15b）。
  // 実日付に依存しないよう、固定日（2026-07-29 = 残り3日）を today 引数で渡して日跨ぎを再現する。
  console.log("[15] 日次予算（dailyBudget）");
  const budgetUser = uid();
  await d.run(
    "INSERT INTO users (id, email, name, password_hash, created_at) VALUES (?, ?, ?, ?, ?)",
    budgetUser,
    "budget@example.com",
    "予算花子",
    hashPassword("password123"),
    Date.now(),
  );
  const bMonth = "2026-07"; // 31日ある月。07-29時点で残り3日（29・30・31）
  await d.run(
    "INSERT INTO incomes (id, user_id, date, amount, type, memo, created_at) VALUES (?, ?, ?, ?, 'other', ?, ?)",
    uid(),
    budgetUser,
    `${bMonth}-01`,
    30000,
    "仕送り",
    Date.now(),
  );
  const bSpend = (date: string, amount: number) =>
    d.run(
      "INSERT INTO expenses (id, user_id, date, amount, category_id, memo, source, receipt_id, created_at) VALUES (?, ?, ?, ?, ?, ?, 'manual', ?, ?)",
      uid(),
      budgetUser,
      date,
      amount,
      null,
      "",
      null,
      Date.now(),
    );
  const bCalc = async (day: string) =>
    dailyBudget(await monthSummary(budgetUser, bMonth), await todaySpent(budgetUser, day), 0, day);

  // ケースA: 昨日まで支出0 → 予算10,000。今日3,000 → あと7,000。翌日は(30,000−3,000)÷2=13,500
  let bb = await bCalc(`${bMonth}-29`);
  check(
    "支出0: 予算(30,000−0)÷3=10,000・今日あと10,000",
    bb.todayBudget === 10000 && bb.remainingToday === 10000 && bb.daysRemaining === 3,
    bb,
  );
  await bSpend(`${bMonth}-29`, 3000);
  check("todaySpent は当日分だけを合計する", (await todaySpent(budgetUser, `${bMonth}-29`)) === 3000);
  bb = await bCalc(`${bMonth}-29`);
  check(
    "今日3,000使用: 予算10,000のまま・今日あと7,000",
    bb.todayBudget === 10000 && bb.spentToday === 3000 && bb.remainingToday === 7000,
    bb,
  );
  bb = await bCalc(`${bMonth}-30`);
  check(
    "翌日: 予算(30,000−3,000)÷2=13,500（前日の支出は昨日まで分に繰り越し）",
    bb.todayBudget === 13500 && bb.spentBeforeToday === 3000 && bb.remainingToday === 13500,
    bb,
  );

  // ケースB: 超過。今日15,000使用 → あと−5,000。翌日は(30,000−15,000)÷2=7,500
  await d.run("DELETE FROM expenses WHERE user_id = ?", budgetUser);
  await bSpend(`${bMonth}-29`, 15000);
  bb = await bCalc(`${bMonth}-29`);
  check(
    "超過: 今日15,000使用で今日あと−5,000（マイナスをそのまま返す）",
    bb.todayBudget === 10000 && bb.remainingToday === -5000,
    bb,
  );
  bb = await bCalc(`${bMonth}-30`);
  check("超過の翌日: 予算(30,000−15,000)÷2=7,500に自動減", bb.todayBudget === 7500, bb);

  // ケースC: 昨日までの支出が累積18,000 → 翌日予算(30,000−18,000)÷2=6,000
  await bSpend(`${bMonth}-29`, 3000);
  bb = await bCalc(`${bMonth}-30`);
  check(
    "累積18,000の翌日: 予算(30,000−18,000)÷2=6,000",
    bb.todayBudget === 6000 && bb.spentBeforeToday === 18000 && bb.spentToday === 0,
    bb,
  );

  // 貯金目標は先取り（分子から差し引いてから割る）
  bb = dailyBudget(await monthSummary(budgetUser, bMonth), 0, 6000, `${bMonth}-30`);
  check("貯金目標6,000を先取り: 予算(30,000−6,000−18,000)÷2=3,000", bb.todayBudget === 3000, bb);

  // --- 15b. 固定費（定期計上）の先取り分離 ---
  // 家賃などの定期計上（source='recurring'）は「今日使った」に含めず、今月分を満額土台から先取りする。
  // → 計上日に「今日あと使える額」が家賃分だけ一気にマイナスへ崩壊しない。
  console.log("[15b] 固定費の先取り分離（monthFixedCost＋dailyBudget）");
  const fixedUser = uid();
  await d.run(
    "INSERT INTO users (id, email, name, password_hash, created_at) VALUES (?, ?, ?, ?, ?)",
    fixedUser,
    "fixed@example.com",
    "固定費太郎",
    hashPassword("password123"),
    Date.now(),
  );
  await d.run(
    "INSERT INTO incomes (id, user_id, date, amount, type, memo, created_at) VALUES (?, ?, ?, ?, 'other', ?, ?)",
    uid(),
    fixedUser,
    `${bMonth}-01`,
    80000,
    "仕送り",
    Date.now(),
  );
  const fSpend = (date: string, amount: number, source = "manual") =>
    d.run(
      "INSERT INTO expenses (id, user_id, date, amount, category_id, memo, source, receipt_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      uid(),
      fixedUser,
      date,
      amount,
      null,
      "",
      source,
      null,
      Date.now(),
    );
  await fSpend(`${bMonth}-10`, 15000); // 昨日までの変動支出
  await fSpend(`${bMonth}-29`, 50000, "recurring"); // 家賃の定期計上（計上日=今日）
  check("monthFixedCost は定期計上だけを合計する", (await monthFixedCost(fixedUser, bMonth)) === 50000);
  check(
    "todaySpent は定期計上を含めない（計上日でも0）",
    (await todaySpent(fixedUser, `${bMonth}-29`)) === 0,
  );
  const fCalc = async (day: string) =>
    dailyBudget(
      await monthSummary(fixedUser, bMonth),
      await todaySpent(fixedUser, day),
      0,
      day,
      await monthFixedCost(fixedUser, bMonth),
    );
  let fb = await fCalc(`${bMonth}-29`);
  check(
    "家賃計上日: 土台(80,000−固定50,000−変動15,000)=15,000 → 予算15,000÷3=5,000で崩壊しない",
    fb.todayBudget === 5000 &&
      fb.remainingToday === 5000 &&
      fb.fixedTotal === 50000 &&
      fb.monthRemaining === 15000 &&
      fb.spentBeforeToday === 15000,
    fb,
  );
  await fSpend(`${bMonth}-29`, 2000); // 今日の変動支出
  fb = await fCalc(`${bMonth}-29`);
  check("計上日に変動2,000使用: 今日あと5,000−2,000=3,000", fb.remainingToday === 3000, fb);
  fb = await fCalc(`${bMonth}-30`);
  check(
    "翌日も整合: 予算(80,000−50,000−17,000)÷2=6,500",
    fb.todayBudget === 6500 && fb.spentBeforeToday === 17000,
    fb,
  );
  // B2: 変動支出を積み増して土台をマイナスに → monthRemaining < 0（ホームは「今月使える残りがありません」に切替）
  await fSpend(`${bMonth}-30`, 20000);
  fb = await fCalc(`${bMonth}-31`);
  check(
    "B2 予算切れ: 土台(80,000−50,000−37,000)=−7,000 → monthRemaining<0",
    fb.monthRemaining === -7000 && fb.todayBudget === -7000 && fb.daysRemaining === 1,
    fb,
  );

  // --- 15c. 次の給料日（nextPayday） ---
  // 末日締め・翌月15日払いのバイト。7月勤務→8/15支給。7/29時点の次の給料日は 8/15（あと17日）。
  console.log("[15c] 次の給料日（nextPayday）");
  check("バイト先が無ければ null", (await nextPayday(fixedUser, `${bMonth}-29`)) === null);
  const npJob = uid();
  await d.run(
    "INSERT INTO jobs (id, user_id, name, weekday_rate, weekend_holiday_rate, transport_per_shift, calendar_keywords, calendar_exclude, color, closing_day, pay_month_offset, pay_day, pay_same_day) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    npJob,
    fixedUser,
    "給料日テスト",
    1200,
    1300,
    0,
    "",
    "",
    "#2f8f5b",
    31,
    1,
    15,
    0,
  );
  // シフト未入力：金額未定（amount 0）で日付だけ返る（7/29 以降で最初の給料日は 8/15）
  let np = await nextPayday(fixedUser, `${bMonth}-29`);
  check(
    "シフト未入力: 日付だけ（8/15・あと17日・金額0）",
    np !== null && np.date === "2026-08-15" && np.amount === 0 && np.daysUntil === 17,
    np,
  );
  // 7/6(月) 10:00-15:00 休憩60分 → 4h × 1,200 = 4,800（末日締め翌月払い → 8/15 支給）
  await d.run(
    "INSERT INTO shifts (id, user_id, job_id, date, start_min, end_min, break_min, source) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    uid(),
    fixedUser,
    npJob,
    `${bMonth}-06`,
    600,
    900,
    60,
    "manual",
  );
  np = await nextPayday(fixedUser, `${bMonth}-29`);
  check(
    "入力済みシフトあり: 8/15 +4,800（あと17日）",
    np !== null && np.date === "2026-08-15" && np.amount === 4800 && np.daysUntil === 17,
    np,
  );
  np = await nextPayday(fixedUser, "2026-08-15");
  check("給料日当日は daysUntil=0", np !== null && np.date === "2026-08-15" && np.daysUntil === 0, np);

  // --- 16. Batch2: 収入の編集（C8）と削除Undo（C7） ---
  // /api/incomes PUT 相当のUPDATEと、編集シートから削除→トーストの「元に戻す」で
  // 削除前の内容そのままで復元される流れをDBレベルで検証する。
  console.log("[16] 収入の編集（C8）・削除Undo（C7）");
  const incId = uid();
  await d.run(
    "INSERT INTO incomes (id, user_id, date, amount, type, memo, created_at) VALUES (?, ?, ?, ?, 'other', ?, ?)",
    incId,
    userId,
    today,
    8000,
    "メルカリ売上",
    Date.now(),
  );
  // 編集（金額・日付・メモ）：/api/incomes PUT と同じUPDATE
  const editRes = await d.run(
    "UPDATE incomes SET date = ?, amount = ?, memo = ? WHERE id = ? AND user_id = ?",
    "2026-01-15",
    8500,
    "メルカリ売上（送料引き後）",
    incId,
    userId,
  );
  const editedInc = await d.get<{ date: string; amount: number; memo: string }>(
    "SELECT date, amount, memo FROM incomes WHERE id = ?",
    incId,
  );
  check(
    "収入の編集: 金額・日付・メモが更新される",
    editRes.changes === 1 &&
      editedInc?.date === "2026-01-15" &&
      editedInc?.amount === 8500 &&
      editedInc?.memo === "メルカリ売上（送料引き後）",
    editedInc,
  );
  // 他ユーザーは編集できない（WHERE user_id 条件）
  const foreignEdit = await d.run(
    "UPDATE incomes SET amount = ? WHERE id = ? AND user_id = ?",
    1,
    incId,
    uid(),
  );
  check(
    "他ユーザーは収入を編集できない",
    foreignEdit.changes === 0 &&
      (await d.get<{ amount: number }>("SELECT amount FROM incomes WHERE id = ?", incId))?.amount ===
        8500,
  );
  // 削除 → Undo（同じ内容で復元）
  await d.run("DELETE FROM incomes WHERE id = ? AND user_id = ?", incId, userId);
  check("収入を削除できる", (await d.get("SELECT id FROM incomes WHERE id = ?", incId)) === undefined);
  const restoredIncId = uid();
  await d.run(
    "INSERT INTO incomes (id, user_id, date, amount, type, memo, created_at) VALUES (?, ?, ?, ?, 'other', ?, ?)",
    restoredIncId,
    userId,
    "2026-01-15",
    8500,
    "メルカリ売上（送料引き後）",
    Date.now(),
  );
  const restoredInc = await d.get<{ date: string; amount: number; memo: string }>(
    "SELECT date, amount, memo FROM incomes WHERE id = ?",
    restoredIncId,
  );
  check(
    "Undoで削除前の内容そのままで復元される（収入）",
    restoredInc?.date === "2026-01-15" &&
      restoredInc?.amount === 8500 &&
      restoredInc?.memo === "メルカリ売上（送料引き後）",
    restoredInc,
  );
  // 支出の削除Undo：receipt_id・source も含めて復元される（レシート紐付けが切れない）
  const delExpId = uid();
  await d.run(
    "INSERT INTO expenses (id, user_id, date, amount, category_id, memo, source, receipt_id, created_at) VALUES (?, ?, ?, ?, ?, ?, 'receipt', ?, ?)",
    delExpId,
    userId,
    today,
    980,
    foodCat.id,
    "スーパー",
    receiptId, // [9]で作ったレシート
    Date.now(),
  );
  const undoSnapshot = await d.get<{
    date: string;
    amount: number;
    category_id: string;
    memo: string;
    source: string;
    receipt_id: string;
  }>(
    "SELECT date, amount, category_id, memo, source, receipt_id FROM expenses WHERE id = ? AND user_id = ?",
    delExpId,
    userId,
  );
  await d.run("DELETE FROM expenses WHERE id = ? AND user_id = ?", delExpId, userId);
  check("支出を削除できる（編集シート内の削除）", (await d.get("SELECT id FROM expenses WHERE id = ?", delExpId)) === undefined);
  const restoredExpId = uid();
  await d.run(
    "INSERT INTO expenses (id, user_id, date, amount, category_id, memo, source, receipt_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    restoredExpId,
    userId,
    undoSnapshot!.date,
    undoSnapshot!.amount,
    undoSnapshot!.category_id,
    undoSnapshot!.memo,
    undoSnapshot!.source,
    undoSnapshot!.receipt_id,
    Date.now(),
  );
  const restoredExp = await d.get<{
    amount: number;
    category_id: string;
    receipt_id: string;
    source: string;
  }>("SELECT amount, category_id, receipt_id, source FROM expenses WHERE id = ?", restoredExpId);
  check(
    "Undoで支出が復元される（カテゴリ・レシート紐付け・sourceも維持）",
    restoredExp?.amount === 980 &&
      restoredExp?.category_id === foodCat.id &&
      restoredExp?.receipt_id === receiptId &&
      restoredExp?.source === "receipt",
    restoredExp,
  );
  await d.run("DELETE FROM expenses WHERE id = ?", restoredExpId);
  await d.run("DELETE FROM incomes WHERE id = ?", restoredIncId);

  // --- 16b. Batch2: カテゴリ使用回数（C6 手入力フォームの上位6個用） ---
  console.log("[16b] カテゴリ使用回数（C6）");
  const usedRows = await d.all<{ name: string; used: number }>(
    `SELECT c.name, CAST(COUNT(e.id) AS INTEGER) AS used
     FROM categories c
     LEFT JOIN expenses e ON e.category_id = c.id AND e.user_id = c.user_id
     WHERE c.user_id = ?
     GROUP BY c.id, c.name, c.icon, c.sort
     ORDER BY c.sort`,
    userId,
  );
  check("全カテゴリが返る（使用0件も含む）", usedRows.length === cats.length, usedRows.length);
  const usedFood = usedRows.find((r) => r.name === "食費");
  check(
    "使用回数がnumberで返る（Postgresのbigint文字列化対策）",
    usedRows.every((r) => typeof r.used === "number"),
    usedFood,
  );
  check(
    "使用回数が実支出数と一致する（食費）",
    usedFood?.used ===
      Number(
        (await d.get<{ c: number | string }>(
          "SELECT COUNT(*) AS c FROM expenses WHERE user_id = ? AND category_id = ?",
          userId,
          foodCat.id,
        ))!.c,
      ),
    usedFood,
  );

  // --- 17. Batch3 (B7): バイト先・カテゴリ・プリセットの編集 ---
  console.log("[17] Batch3 編集系（B7）");
  // バイト先の部分更新（/api/jobs POST id付き相当）：指定項目だけ変わり、未指定は保持
  await d.run(
    "UPDATE jobs SET name = ?, weekday_rate = ?, closing_day = ? WHERE id = ? AND user_id = ?",
    "キミハン新館",
    1250,
    15,
    jobId,
    userId,
  );
  const editedJob = await d.get<{
    name: string;
    weekday_rate: number;
    weekend_holiday_rate: number;
    closing_day: number;
    pay_day: number;
  }>(
    "SELECT name, weekday_rate, weekend_holiday_rate, closing_day, pay_day FROM jobs WHERE id = ?",
    jobId,
  );
  check(
    "バイト先の編集: 名前・時給・締め日が更新され、未指定項目（土日祝時給・支払日）は保持",
    editedJob?.name === "キミハン新館" &&
      editedJob?.weekday_rate === 1250 &&
      editedJob?.closing_day === 15 &&
      editedJob?.weekend_holiday_rate === 1200 &&
      editedJob?.pay_day === 25,
    editedJob,
  );
  // shift_count（/api/jobs GET のサブクエリ）：削除確認「シフト◯件も削除されます」用
  const jobRows = await d.all<{ id: string; shift_count: number | string }>(
    `SELECT j.id,
            (SELECT COUNT(*) FROM shifts s WHERE s.job_id = j.id AND s.user_id = j.user_id) AS shift_count
     FROM jobs j WHERE j.user_id = ?`,
    userId,
  );
  const jobWithShifts = jobRows.find((j) => j.id === jobId);
  check(
    "shift_count がバイト先ごとのシフト数を返す（当月＋来月の2件）",
    Number(jobWithShifts?.shift_count) === 2,
    jobRows,
  );
  // 他ユーザーはバイト先を編集できない
  const foreignJobEdit = await d.run(
    "UPDATE jobs SET name = ? WHERE id = ? AND user_id = ?",
    "乗っ取り",
    jobId,
    uid(),
  );
  check("他ユーザーはバイト先を編集できない", foreignJobEdit.changes === 0);
  // カテゴリの編集（/api/categories PUT 相当）：名前・アイコン
  await d.run(
    "UPDATE categories SET name = ?, icon = ? WHERE id = ? AND user_id = ?",
    "ごはん",
    "food",
    foodCat.id,
    userId,
  );
  const editedCat = await d.get<{ name: string; icon: string }>(
    "SELECT name, icon FROM categories WHERE id = ?",
    foodCat.id,
  );
  check("カテゴリの編集: 名前・アイコンが更新される", editedCat?.name === "ごはん" && editedCat?.icon === "food", editedCat);
  check(
    "カテゴリ編集後も既存支出の紐付けは維持される",
    ((await d.get<{ c: number | string }>(
      "SELECT COUNT(*) AS c FROM expenses WHERE user_id = ? AND category_id = ?",
      userId,
      foodCat.id,
    ))!.c as number) > 0,
  );
  // プリセットの編集（/api/presets PUT 相当）：名前・金額・カテゴリ
  const editPresetId = uid();
  await d.run(
    "INSERT INTO quick_presets (id, user_id, label, amount, category_id, sort) VALUES (?, ?, ?, ?, ?, ?)",
    editPresetId,
    userId,
    "Suicaチャージ",
    1000,
    transportCat.id,
    5,
  );
  await d.run(
    "UPDATE quick_presets SET label = ?, amount = ?, category_id = ? WHERE id = ? AND user_id = ?",
    "Suica2000",
    2000,
    null,
    editPresetId,
    userId,
  );
  const editedPreset = await d.get<{ label: string; amount: number; category_id: string | null }>(
    "SELECT label, amount, category_id FROM quick_presets WHERE id = ?",
    editPresetId,
  );
  check(
    "プリセットの編集: 名前・金額・カテゴリ（外す）が更新される",
    editedPreset?.label === "Suica2000" && editedPreset?.amount === 2000 && editedPreset?.category_id === null,
    editedPreset,
  );
  const foreignPresetEdit = await d.run(
    "UPDATE quick_presets SET amount = ? WHERE id = ? AND user_id = ?",
    1,
    editPresetId,
    uid(),
  );
  check("他ユーザーはプリセットを編集できない", foreignPresetEdit.changes === 0);
  await d.run("DELETE FROM quick_presets WHERE id = ?", editPresetId);

  // --- 17b. Batch3 (B12): AI残量表示（getAiUsageDisplay） ---
  console.log("[17b] Batch3 AI残量表示（B12）");
  const displayUser = uid();
  await d.run(
    "INSERT INTO users (id, email, name, password_hash, created_at) VALUES (?, ?, ?, ?, ?)",
    displayUser,
    "display@example.com",
    "残量花子",
    hashPassword("password123"),
    Date.now(),
  );
  let disp = await getAiUsageDisplay(displayUser);
  check(
    "使用0のfree: 0/30回・0/30回",
    disp.plan === "free" &&
      disp.scans.used === 0 &&
      disp.scans.limit === FREE_LIMITS.scans &&
      disp.parses.used === 0 &&
      disp.parses.limit === FREE_LIMITS.parses,
    disp,
  );
  await d.run(
    "INSERT INTO ai_usage (user_id, ym, scans, parses) VALUES (?, ?, ?, ?)",
    displayUser,
    month,
    12,
    3,
  );
  disp = await getAiUsageDisplay(displayUser);
  check(
    "freeの残量表示: 今月のAI読み取り12/30・文章入力3/30",
    disp.scans.used === 12 && disp.scans.limit === 30 && disp.parses.used === 3 && disp.parses.limit === 30,
    disp,
  );
  // リワード動画ボーナスは上限に上乗せされる（12/33 のように表示できる）
  await d.run(
    "UPDATE ai_usage SET bonus_scans = 3 WHERE user_id = ? AND ym = ?",
    displayUser,
    month,
  );
  disp = await getAiUsageDisplay(displayUser);
  check("ボーナス+3で上限が33になる", disp.scans.limit === FREE_LIMITS.scans + 3, disp);
  await d.run("UPDATE users SET plan = 'premium' WHERE id = ?", displayUser);
  disp = await getAiUsageDisplay(displayUser);
  check(
    "premiumはlimit=null（無制限表示）",
    disp.plan === "premium" && disp.scans.limit === null && disp.parses.limit === null,
    disp,
  );
  await d.run("UPDATE users SET plan = 'founder' WHERE id = ?", displayUser);
  disp = await getAiUsageDisplay(displayUser);
  check(
    "founderもlimit=null（無制限表示）",
    disp.plan === "founder" && disp.scans.limit === null && disp.parses.limit === null,
    disp,
  );

  // --- 17c. Batch3 (B3): セットアップカード用counts・週次recordCount ---
  console.log("[17c] Batch3 オンボーディングcounts（B3）");
  const newbie = uid();
  await d.run(
    "INSERT INTO users (id, email, name, password_hash, created_at) VALUES (?, ?, ?, ?, ?)",
    newbie,
    "newbie@example.com",
    "新規太郎",
    hashPassword("password123"),
    Date.now(),
  );
  const countsOf = async (uid2: string) => ({
    jobs: Number(
      (await d.get<{ c: number | string }>("SELECT COUNT(*) AS c FROM jobs WHERE user_id = ?", uid2))!.c,
    ),
    recurringExpense: Number(
      (await d.get<{ c: number | string }>(
        "SELECT COUNT(*) AS c FROM recurring_items WHERE user_id = ? AND kind = 'expense'",
        uid2,
      ))!.c,
    ),
    expensesAll: Number(
      (await d.get<{ c: number | string }>("SELECT COUNT(*) AS c FROM expenses WHERE user_id = ?", uid2))!.c,
    ),
  });
  let cnt = await countsOf(newbie);
  check(
    "新規ユーザーのcountsは全て0（セットアップカード表示・虚偽称賛の抑制対象）",
    cnt.jobs === 0 && cnt.recurringExpense === 0 && cnt.expensesAll === 0,
    cnt,
  );
  cnt = await countsOf(userId);
  check(
    "既存ユーザーはcountsが立つ（カード非表示）",
    cnt.jobs > 0 && cnt.recurringExpense > 0 && cnt.expensesAll > 0,
    cnt,
  );
  // 週次のrecordCount：定期計上（source='recurring'）を除いた行数。0件の週は称賛でなく案内に切り替える
  const wkStart = "2000-01-03";
  const wkEnd = "2000-01-09";
  const recordCountOf = async (uid2: string) =>
    Number(
      (await d.get<{ c: number | string }>(
        "SELECT COUNT(*) AS c FROM expenses WHERE user_id = ? AND date >= ? AND date <= ? AND source != 'recurring'",
        uid2,
        wkStart,
        wkEnd,
      ))!.c,
    );
  check("記録0件の週は recordCount=0（案内表示）", (await recordCountOf(newbie)) === 0);
  await d.run(
    "INSERT INTO expenses (id, user_id, date, amount, category_id, memo, source, receipt_id, created_at) VALUES (?, ?, ?, ?, ?, ?, 'recurring', ?, ?)",
    uid(),
    newbie,
    "2000-01-04",
    50000,
    null,
    "家賃",
    null,
    Date.now(),
  );
  check("定期計上だけの週も recordCount=0（行動の記録ではないため）", (await recordCountOf(newbie)) === 0);
  await d.run(
    "INSERT INTO expenses (id, user_id, date, amount, category_id, memo, source, receipt_id, created_at) VALUES (?, ?, ?, ?, ?, ?, 'manual', ?, ?)",
    uid(),
    newbie,
    "2000-01-05",
    650,
    null,
    "昼飯",
    null,
    Date.now(),
  );
  check("手入力1件で recordCount=1（振り返り表示に切替）", (await recordCountOf(newbie)) === 1);

  // --- 18. Batch4 (B9): 月の開始日（締め日）の期間解決 ---
  console.log("[18] Batch4 月の開始日（B9）純粋関数");
  check(
    "monthRangeFor(2026-08, 25) = 7/25〜8/24",
    JSON.stringify(monthRangeFor("2026-08", 25)) ===
      JSON.stringify({ start: "2026-07-25", end: "2026-08-24" }),
    monthRangeFor("2026-08", 25),
  );
  check(
    "monthRangeFor(2026-07, 1) = 従来のカレンダー月",
    JSON.stringify(monthRangeFor("2026-07", 1)) ===
      JSON.stringify({ start: "2026-07-01", end: "2026-07-31" }),
    monthRangeFor("2026-07", 1),
  );
  check(
    "monthRangeFor(2026-03, 28) = 2/28〜3/27（2月クランプ）",
    JSON.stringify(monthRangeFor("2026-03", 28)) ===
      JSON.stringify({ start: "2026-02-28", end: "2026-03-27" }),
    monthRangeFor("2026-03", 28),
  );
  check("accountingMonthFor(7/24, 25) = 7月", accountingMonthFor("2026-07-24", 25) === "2026-07");
  check("accountingMonthFor(7/25, 25) = 8月", accountingMonthFor("2026-07-25", 25) === "2026-08");
  check("accountingMonthFor(12/25, 25) = 翌年1月", accountingMonthFor("2026-12-25", 25) === "2027-01");
  check("accountingMonthFor(7/26, 1) = 従来", accountingMonthFor("2026-07-26", 1) === "2026-07");
  check("残り日数 7/26 開始日25 = 30（7/26〜8/24）", daysRemainingInMonth("2026-07-26", 25) === 30);
  check("残り日数 7/26 開始日1 = 6（従来と同値）", daysRemainingInMonth("2026-07-26", 1) === 6);
  check("残り日数 引数省略 = 従来挙動", daysRemainingInMonth("2026-07-26") === 6);

  console.log("[18b] Batch4 開始日25の集計（境界・給料日・固定費・冪等）");
  const u25 = uid();
  await d.run(
    "INSERT INTO users (id, email, name, password_hash, created_at, month_start_day) VALUES (?, ?, ?, ?, ?, 25)",
    u25,
    "day25@example.com",
    "締め日25",
    hashPassword("password123"),
    Date.now(),
  );
  check("getMonthStartDay = 25", (await getMonthStartDay(u25)) === 25);
  check(
    "monthRange(u25, 2001-08) = 7/25〜8/24",
    JSON.stringify(await monthRange(u25, "2001-08")) ===
      JSON.stringify({ start: "2001-07-25", end: "2001-08-24" }),
  );
  const insExp = async (uid2: string, date: string, amount: number, source = "manual") =>
    d.run(
      "INSERT INTO expenses (id, user_id, date, amount, category_id, memo, source, created_at) VALUES (?, ?, ?, ?, NULL, '', ?, ?)",
      uid(),
      uid2,
      date,
      amount,
      source,
      Date.now(),
    );
  const insInc = async (uid2: string, date: string, amount: number) =>
    d.run(
      "INSERT INTO incomes (id, user_id, date, amount, type, memo, created_at) VALUES (?, ?, ?, ?, 'other', '', ?)",
      uid(),
      uid2,
      date,
      amount,
      Date.now(),
    );
  await insExp(u25, "2001-07-24", 1000); // 7月分
  await insExp(u25, "2001-07-25", 2000); // 8月分
  await insExp(u25, "2001-07-26", 700); // 8月分
  await insExp(u25, "2001-08-24", 3000); // 8月分
  await insExp(u25, "2001-08-25", 400); // 9月分
  await insInc(u25, "2001-07-24", 500); // 7月分
  await insInc(u25, "2001-07-25", 90000); // 8月分（給料日）
  const s7 = await monthSummary(u25, "2001-07");
  const s9 = await monthSummary(u25, "2001-09");
  check("7月（6/25〜7/24）支出 = 1000", s7.expenseTotal === 1000, s7.expenseTotal);
  check("9月（8/25〜9/24）支出 = 400", s9.expenseTotal === 400, s9.expenseTotal);
  check("7月収入 = 500", s7.incomeTotal === 500, s7.incomeTotal);

  // 給料日: 15日締め・翌月25日払い → 7/25支払い（5/16〜6/15勤務分）は集計上の「8月」に入る
  const j25 = uid();
  await d.run(
    "INSERT INTO jobs (id, user_id, name, weekday_rate, weekend_holiday_rate, transport_per_shift, calendar_keywords, closing_day, pay_month_offset, pay_day) VALUES (?, ?, 'job25', 1000, 1000, 0, '', 15, 1, 25)",
    j25,
    u25,
  );
  // 2001-06-13(水・平日) 5h → 5000円 → 7/25支払い（集計8月）
  await d.run(
    "INSERT INTO shifts (id, user_id, job_id, date, start_min, end_min, break_min) VALUES (?, ?, ?, '2001-06-13', 600, 900, 0)",
    uid(),
    u25,
    j25,
  );
  // 2001-07-11(水・平日) 3h → 3000円 → 8/25支払い（集計9月）
  await d.run(
    "INSERT INTO shifts (id, user_id, job_id, date, start_min, end_min, break_min) VALUES (?, ?, ?, '2001-07-11', 600, 780, 0)",
    uid(),
    u25,
    j25,
  );
  const si8 = await monthShiftIncome(u25, "2001-08");
  const si9 = await monthShiftIncome(u25, "2001-09");
  check("シフト収入: 7/25支払い分（6/13勤務5h）が「8月」= 5000", si8.total === 5000, si8.total);
  check("シフト収入: 8/25支払い分（7/11勤務3h）が「9月」= 3000", si9.total === 3000, si9.total);
  const pd8 = await paydays(u25, "2001-08");
  check(
    "paydays(8月) = 7/25 の給料日1件・5000円",
    pd8.length === 1 && pd8[0].date === "2001-07-25" && pd8[0].amount === 5000,
    pd8,
  );

  // 定期計上: カレンダー月キーのまま（支払日ベース）＝締め日変更でも二重計上しない
  const r25 = uid();
  await d.run(
    "INSERT INTO recurring_items (id, user_id, kind, name, amount, category_id, start_month, end_month, post_day) VALUES (?, ?, 'expense', '家賃', 500, NULL, '2001-06', '2001-07', 27)",
    r25,
    u25,
  );
  await postRecurringForMonth(u25, "2001-07");
  await postRecurringForMonth(u25, "2001-07"); // 2回目（冪等）
  await postRecurringForMonth(u25, "2001-07"); // 3回目（冪等）
  const recRows = await d.all<{ date: string }>(
    "SELECT date FROM expenses WHERE user_id = ? AND source = 'recurring' ORDER BY date",
    u25,
  );
  check(
    "定期計上はカレンダー月キーで2件のみ（6/27・7/27。二重計上なし）",
    recRows.length === 2 && recRows[0].date === "2001-06-27" && recRows[1].date === "2001-07-27",
    recRows,
  );
  check("固定費: 6/27計上分は集計「7月」（6/25〜7/24）", (await monthFixedCost(u25, "2001-07")) === 500);
  check("固定費: 7/27計上分は集計「8月」（7/25〜8/24）", (await monthFixedCost(u25, "2001-08")) === 500);

  // 8月の合計（定期含む）と日次予算（today固定・startDay=25）
  const s8 = await monthSummary(u25, "2001-08");
  check("8月（7/25〜8/24）支出 = 2000+700+3000+定期500 = 6200", s8.expenseTotal === 6200, s8.expenseTotal);
  check("8月収入 = 90000 + シフト5000 = 95000", s8.incomeTotal === 95000, s8.incomeTotal);
  const b25 = dailyBudget(s8, 700, 10000, "2001-07-26", 500, 25);
  check("日次予算: 残り30日（7/26〜8/24）", b25.daysRemaining === 30, b25);
  check(
    "日次予算: 土台 = 95000−10000−500−5000 = 79500",
    b25.monthRemaining === 79500 && b25.spentBeforeToday === 5000,
    b25,
  );
  check("日次予算: 今日の予算 79500/30 = 2650・あと1950", b25.todayBudget === 2650 && b25.remainingToday === 1950, b25);
  const cb8 = await categoryBreakdown(u25, "2001-08");
  check(
    "カテゴリ内訳も期間ベース（未分類 6200円・4件）",
    cb8.length === 1 && Number(cb8[0].amount) === 6200 && Number(cb8[0].count) === 4,
    cb8,
  );
  const nmd8 = await noMoneyDays(u25, "2001-08");
  check(
    "NMD: 過去の集計月は期間全体（31日中、支出3日→28日・末日に支出→連続0）",
    nmd8.count === 28 && nmd8.streak === 0,
    nmd8,
  );

  console.log("[18c] Batch4 回帰: 開始日1（デフォルト）は従来のカレンダー月集計と完全一致");
  const uDef = uid();
  await d.run(
    "INSERT INTO users (id, email, name, password_hash, created_at) VALUES (?, ?, ?, ?, ?)",
    uDef,
    "default-msd@example.com",
    "デフォルト",
    hashPassword("password123"),
    Date.now(),
  );
  check("month_start_day 未指定は 1", (await getMonthStartDay(uDef)) === 1);
  await insExp(uDef, "2001-06-30", 999); // 月外
  await insExp(uDef, "2001-07-01", 1000);
  await insExp(uDef, "2001-07-15", 2000);
  await insExp(uDef, "2001-07-31", 3000);
  await insExp(uDef, "2001-08-01", 888); // 月外
  await insInc(uDef, "2001-07-01", 100000);
  const jDef = uid();
  await d.run(
    "INSERT INTO jobs (id, user_id, name, weekday_rate, weekend_holiday_rate, transport_per_shift, calendar_keywords, closing_day, pay_month_offset, pay_day) VALUES (?, ?, 'jobDef', 1000, 1200, 0, '', 31, 0, 25)",
    jDef,
    uDef,
  );
  // 2001-07-04(水・平日) 4h → 4000円
  await d.run(
    "INSERT INTO shifts (id, user_id, job_id, date, start_min, end_min, break_min) VALUES (?, ?, ?, '2001-07-04', 600, 900, 60)",
    uid(),
    uDef,
    jDef,
  );
  const sDef = await monthSummary(uDef, "2001-07");
  const likeExp = Number(
    (await d.get<{ s: number }>(
      "SELECT COALESCE(SUM(amount),0) AS s FROM expenses WHERE user_id = ? AND date LIKE '2001-07-%'",
      uDef,
    ))!.s,
  );
  const likeInc = Number(
    (await d.get<{ s: number }>(
      "SELECT COALESCE(SUM(amount),0) AS s FROM incomes WHERE user_id = ? AND date LIKE '2001-07-%'",
      uDef,
    ))!.s,
  );
  check("monthSummary.expenseTotal == 従来LIKE集計（6000）", sDef.expenseTotal === likeExp && likeExp === 6000, sDef.expenseTotal);
  check("シフト収入は従来どおり当月払い扱い（4000）", sDef.shift.total === 4000, sDef.shift.total);
  check(
    "monthSummary.incomeTotal == 従来LIKE集計＋シフト",
    sDef.incomeTotal === likeInc + 4000,
    sDef.incomeTotal,
  );
  const pdDef = await paydays(uDef, "2001-07");
  const cpdDef = await calendarPaydays(uDef, "2001-07");
  check(
    "paydays == calendarPaydays（開始日1・給料日7/25）",
    JSON.stringify(pdDef) === JSON.stringify(cpdDef) && pdDef[0]?.date === "2001-07-25",
    pdDef,
  );
  const bDef = dailyBudget(sDef, 0, 0, "2001-07-26", 0);
  const bDef1 = dailyBudget(sDef, 0, 0, "2001-07-26", 0, 1);
  check(
    "dailyBudget: 引数省略と開始日1が同値（回帰）",
    JSON.stringify(bDef) === JSON.stringify(bDef1) && bDef.daysRemaining === 6,
    bDef,
  );

  // --- 19. Batch4 (B5): パスワード再設定・変更・アカウント削除 ---
  console.log("[19] Batch4 パスワード再設定（B5）");
  const uAcc = uid();
  await d.run(
    "INSERT INTO users (id, email, name, password_hash, created_at) VALUES (?, ?, ?, ?, ?)",
    uAcc,
    "b5@example.com",
    "削除太郎",
    (await import("../src/lib/password")).hashPassword("oldpass123"),
    Date.now(),
  );
  check("未登録メールは null（応答は同一文言）", (await createPasswordReset("nobody@example.com")) === null);
  const reset1 = await createPasswordReset("b5@example.com");
  check("トークン発行", !!reset1 && reset1.userId === uAcc);
  check("トークン有効", await isResetTokenValid(reset1!.token));
  check("8文字未満は拒否（トークン未消費）", (await consumePasswordReset(reset1!.token, "short")) === "weak_password");
  check("リセット成功", (await consumePasswordReset(reset1!.token, "newpass456")) === "ok");
  const hashAfterReset = (await d.get<{ password_hash: string }>(
    "SELECT password_hash FROM users WHERE id = ?",
    uAcc,
  ))!.password_hash;
  check("新PWでログイン可能（ハッシュ照合）", verifyPassword("newpass456", hashAfterReset));
  check("旧PWは無効", !verifyPassword("oldpass123", hashAfterReset));
  check("トークン再利用は拒否", (await consumePasswordReset(reset1!.token, "another123")) === "invalid_token");
  const reset2 = await createPasswordReset("b5@example.com");
  await d.run("UPDATE password_resets SET expires_at = ? WHERE user_id = ?", Date.now() - 1000, uAcc);
  check("期限切れは無効", !(await isResetTokenValid(reset2!.token)));
  check("期限切れリセットは拒否", (await consumePasswordReset(reset2!.token, "whatever123")) === "invalid_token");
  check("現PW違いの変更は拒否", (await changePassword(uAcc, "wrongwrong", "nextpass789")) === "wrong_password");
  check("8文字未満の変更は拒否", (await changePassword(uAcc, "newpass456", "short")) === "weak_password");
  check("パスワード変更成功", (await changePassword(uAcc, "newpass456", "nextpass789")) === "ok");

  console.log("[19b] Batch4 アカウント削除（B5・全テーブルからユーザー消滅）");
  await d.run("INSERT INTO sessions (token, user_id, created_at) VALUES (?, ?, ?)", uid(), uAcc, Date.now());
  await d.run("INSERT INTO categories (id, user_id, name, icon, sort) VALUES (?, ?, '食費', 'food', 0)", uid(), uAcc);
  await insExp(uAcc, "2001-07-01", 100);
  await insInc(uAcc, "2001-07-01", 200);
  await d.run(
    "INSERT INTO receipts (id, user_id, store, taken_date, total, items_json, created_at) VALUES (?, ?, 'store', '2001-07-01', 100, '[]', ?)",
    uid(),
    uAcc,
    Date.now(),
  );
  const jAcc = uid();
  await d.run(
    "INSERT INTO jobs (id, user_id, name, weekday_rate, weekend_holiday_rate, transport_per_shift, calendar_keywords) VALUES (?, ?, 'job', 1000, 1000, 0, '')",
    jAcc,
    uAcc,
  );
  await d.run(
    "INSERT INTO shifts (id, user_id, job_id, date, start_min, end_min, break_min) VALUES (?, ?, ?, '2001-07-02', 600, 900, 0)",
    uid(),
    uAcc,
    jAcc,
  );
  const rAcc = uid();
  await d.run(
    "INSERT INTO recurring_items (id, user_id, kind, name, amount, category_id, start_month, end_month, post_day) VALUES (?, ?, 'expense', 'サブスク', 100, NULL, '2001-07', '2001-07', 1)",
    rAcc,
    uAcc,
  );
  await postRecurringForMonth(uAcc, "2001-07"); // recurring_posts も作る
  await d.run("INSERT INTO quick_presets (id, user_id, label, amount, category_id, sort) VALUES (?, ?, 'コーヒー', 300, NULL, 0)", uid(), uAcc);
  await d.run("INSERT INTO category_budgets (user_id, category_id, amount) VALUES (?, ?, 5000)", uAcc, uid());
  await d.run("INSERT INTO push_subscriptions (endpoint, user_id, subscription, created_at) VALUES (?, ?, '{}', ?)", uid(), uAcc, Date.now());
  await d.run("INSERT INTO monthly_reviews (user_id, month, report, created_at) VALUES (?, '2001-06', '{}', ?)", uAcc, Date.now());
  await d.run("INSERT INTO merchant_categories (user_id, merchant, category_id, updated_at) VALUES (?, 'seven', ?, ?)", uAcc, uid(), Date.now());
  await d.run("INSERT INTO ai_usage (user_id, ym, scans, parses) VALUES (?, '2001-07', 1, 1)", uAcc);
  await d.run("INSERT INTO ai_reward_days (user_id, ymd, count) VALUES (?, '2001-07-01', 1)", uAcc);
  await createPasswordReset("b5@example.com"); // password_resets も作る

  check("PW違いでは削除しない", (await deleteAccountWithPassword(uAcc, "wrong-password")) === "wrong_password");
  check(
    "誤PW後もユーザー残存",
    Number((await d.get<{ c: number }>("SELECT COUNT(*) AS c FROM users WHERE id = ?", uAcc))!.c) === 1,
  );
  check("正PWで削除成功", (await deleteAccountWithPassword(uAcc, "nextpass789")) === "ok");
  const tableCols: [string, string][] = [
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
    ["ai_reward_days", "user_id"],
    ["password_resets", "user_id"],
  ];
  for (const [t, col] of tableCols) {
    const c = Number(
      (await d.get<{ c: number }>(`SELECT COUNT(*) AS c FROM ${t} WHERE ${col} = ?`, uAcc))!.c,
    );
    check(`${t} から消滅`, c === 0, c);
  }
  check(
    "recurring_posts から消滅（recurring_id 経由）",
    Number(
      (await d.get<{ c: number }>("SELECT COUNT(*) AS c FROM recurring_posts WHERE recurring_id = ?", rAcc))!.c,
    ) === 0,
  );
  check(
    "他ユーザーのデータは無傷",
    Number((await d.get<{ c: number }>("SELECT COUNT(*) AS c FROM expenses WHERE user_id = ?", u25))!.c) > 0 &&
      Number((await d.get<{ c: number }>("SELECT COUNT(*) AS c FROM users WHERE id = ?", u25))!.c) === 1,
  );

  // --- Batch5: データ系（C12 固定費/変動費・C13 繰り越し・B11 検索・B10 CSV出力・C2 インポート） ---
  console.log("[Batch5] データ系");
  const u5 = uid();
  await d.run(
    "INSERT INTO users (id, email, name, password_hash, created_at) VALUES (?, ?, ?, ?, ?)",
    u5,
    "batch5@example.com",
    "バッチ5",
    hashPassword("password123"),
    Date.now(),
  );
  await seedCategories(u5);
  const cats5 = await d.all<{ id: string; name: string }>(
    "SELECT id, name FROM categories WHERE user_id = ? ORDER BY sort",
    u5,
  );
  const cat5 = (name: string) => cats5.find((c) => c.name === name)!.id;

  // C12: is_fixed=1（既定）＝固定費、is_fixed=0＝変動費として日々の支出側に数える
  const recFixed = uid();
  const recVar = uid();
  await d.run(
    "INSERT INTO recurring_items (id, user_id, kind, name, amount, category_id, start_month, end_month, post_day, interval, is_fixed) VALUES (?, ?, 'expense', '家賃', 60000, ?, '2005-07', '2005-07', 1, 'monthly', 1)",
    recFixed,
    u5,
    cat5("住まい"),
  );
  await d.run(
    "INSERT INTO recurring_items (id, user_id, kind, name, amount, category_id, start_month, end_month, post_day, interval, is_fixed) VALUES (?, ?, 'expense', 'ジム', 8000, ?, '2005-07', '2005-07', 1, 'monthly', 0)",
    recVar,
    u5,
    cat5("娯楽"),
  );
  await postRecurringForMonth(u5, "2005-07");
  await d.run(
    "INSERT INTO expenses (id, user_id, date, amount, category_id, memo, source, created_at) VALUES (?, ?, '2005-07-05', 1200, ?, 'コンビニ', 'manual', ?)",
    uid(),
    u5,
    cat5("食費"),
    Date.now(),
  );
  // 旧レコード（recurring_id が NULL の定期計上）は従来どおり固定費扱い
  await d.run(
    "INSERT INTO expenses (id, user_id, date, amount, category_id, memo, source, created_at) VALUES (?, ?, '2005-07-03', 5000, NULL, '旧定期', 'recurring', ?)",
    uid(),
    u5,
    Date.now(),
  );
  check(
    "C12: monthFixedCost は is_fixed=1 の定期＋旧レコードのみ（60000+5000）",
    (await monthFixedCost(u5, "2005-07")) === 65000,
    await monthFixedCost(u5, "2005-07"),
  );
  check(
    "C12: is_fixed=0 の定期計上は変動費（todaySpent に入る）",
    (await todaySpent(u5, "2005-07-01")) === 8000,
    await todaySpent(u5, "2005-07-01"),
  );
  check(
    "C12: 手入力は従来どおり変動費",
    (await todaySpent(u5, "2005-07-05")) === 1200,
    await todaySpent(u5, "2005-07-05"),
  );
  {
    const sum5 = await monthSummary(u5, "2005-07");
    check(
      "C12: 固定費＋変動費＝支出総額（取りこぼしなし）",
      Number(sum5.expenseTotal) === 65000 + 8000 + 1200,
      sum5.expenseTotal,
    );
    const bd = await categoryBreakdown(u5, "2005-07");
    check(
      "C12: カテゴリ内訳は従来どおり全支出",
      bd.reduce((a, c) => a + Number(c.amount), 0) === 74200,
      bd,
    );
  }

  // C13: 袋分けポケットの繰り越し（前月の余りを当月に加算・マイナス繰り越しなし）
  await d.run(
    "INSERT INTO category_budgets (user_id, category_id, amount, carryover) VALUES (?, ?, 30000, 1)",
    u5,
    cat5("交際"),
  );
  await d.run(
    "INSERT INTO category_budgets (user_id, category_id, amount, carryover) VALUES (?, ?, 10000, 1)",
    u5,
    cat5("洋服"),
  );
  await d.run(
    "INSERT INTO category_budgets (user_id, category_id, amount, carryover) VALUES (?, ?, 5000, 0)",
    u5,
    cat5("美容"),
  );
  const spend5 = async (date: string, amount: number, catId: string | null, memo: string) =>
    d.run(
      "INSERT INTO expenses (id, user_id, date, amount, category_id, memo, source, created_at) VALUES (?, ?, ?, ?, ?, ?, 'manual', ?)",
      uid(),
      u5,
      date,
      amount,
      catId,
      memo,
      Date.now(),
    );
  await spend5("2005-06-10", 22000, cat5("交際"), "先月の交際費"); // 余り8000
  await spend5("2005-06-12", 13000, cat5("洋服"), "先月オーバー"); // -3000
  await spend5("2005-06-15", 1000, cat5("美容"), "先月の美容"); // 繰り越しOFF
  await spend5("2005-07-02", 4000, cat5("交際"), "今月の交際費");
  {
    const pockets = await pocketBudgets(u5, "2005-07");
    const p = (name: string) => pockets.find((x) => x.id === cat5(name))!;
    check("C13: 前月の余り8000が繰り越される", p("交際").carryoverAmount === 8000, p("交際"));
    check("C13: 土台の予算は据え置き", p("交際").budget === 30000, p("交際"));
    check("C13: 今月の支出が入る", p("交際").spent === 4000, p("交際"));
    check("C13: 前月オーバーでもマイナス繰り越ししない", p("洋服").carryoverAmount === 0, p("洋服"));
    check("C13: 繰り越しOFFは常に0", p("美容").carryoverAmount === 0, p("美容"));
    check("C13: 予算未設定カテゴリは budget=0・繰り越し0", p("旅行").budget === 0 && p("旅行").carryoverAmount === 0, p("旅行"));
    check("C13: 全カテゴリ分のポケットが返る", pockets.length === 14, pockets.length);
  }

  // B11: 支出の検索（部分一致・カテゴリ・金額範囲・ページング・LIKEメタ文字）
  await spend5("2005-05-01", 500, cat5("食費"), "セブンイレブン 矢部店");
  await spend5("2005-05-02", 1500, cat5("食費"), "セブンイレブン 淵野辺店");
  await spend5("2005-05-03", 12000, null, "セブン銀行 引き出し");
  await spend5("2005-05-04", 800, cat5("娯楽"), "50%OFFセール");
  {
    const r = await searchExpenses(u5, { q: "セブン" });
    check("B11: 部分一致で3件", r.total === 3, r.total);
    check("B11: 日付降順で返る", r.expenses[0].memo === "セブン銀行 引き出し", r.expenses[0]);
    check("B11: 金額は number", typeof r.expenses[0].amount === "number", r.expenses[0].amount);
    check("B11: LIKEメタ文字%はリテラル扱い", (await searchExpenses(u5, { q: "%" })).total === 1);
    check("B11: LIKEメタ文字_もリテラル扱い", (await searchExpenses(u5, { q: "_" })).total === 0);
    check(
      "B11: カテゴリ絞り込み",
      (await searchExpenses(u5, { q: "セブン", categoryId: cat5("食費") })).total === 2,
    );
    check("B11: 金額範囲", (await searchExpenses(u5, { q: "セブン", min: 1000, max: 5000 })).total === 1);
    const page1 = await searchExpenses(u5, { q: "セブン", limit: 2, offset: 0 });
    const page2 = await searchExpenses(u5, { q: "セブン", limit: 2, offset: 2 });
    check("B11: ページング（1ページ目2件・totalは全件）", page1.expenses.length === 2 && page1.total === 3);
    check("B11: ページング（2ページ目1件・重複なし）", page2.expenses.length === 1 && page2.expenses[0].id !== page1.expenses[0].id);
    check("B11: 他ユーザーの支出は混ざらない", (await searchExpenses(u25, { q: "セブン" })).total === 0);
  }

  // B10: CSVエクスポート（支出・収入・シフト給与・期間・エスケープ）
  await spend5("2005-08-10", 1000, cat5("食費"), "ラーメン,大盛り");
  await spend5("2005-08-12", 2000, cat5("娯楽"), 'クオート"付き');
  await d.run(
    "INSERT INTO incomes (id, user_id, date, amount, type, memo, created_at) VALUES (?, ?, '2005-08-11', 30000, 'other', 'メルカリ売上', ?)",
    uid(),
    u5,
    Date.now(),
  );
  {
    const job5 = uid();
    await d.run(
      "INSERT INTO jobs (id, user_id, name, weekday_rate, weekend_holiday_rate, transport_per_shift, calendar_keywords, closing_day, pay_month_offset, pay_day) VALUES (?, ?, 'キミハン', 1300, 1400, 0, '', 31, 0, 25)",
      job5,
      u5,
    );
    // 2005-08-08(月) 18:00-22:30 休憩0 → 4.5h × 1300 = 5850
    await d.run(
      "INSERT INTO shifts (id, user_id, job_id, date, start_min, end_min, break_min, source) VALUES (?, ?, ?, '2005-08-08', 1080, 1350, 0, 'manual')",
      uid(),
      u5,
      job5,
    );
    const aug = await collectExportRows(u5, "2005-08-01", "2005-08-31");
    check("B10: 期間内の行だけ（支出2＋収入1＋シフト1）", aug.length === 4, aug.length);
    check("B10: 日付昇順", aug.map((r) => r.date).join(",") === "2005-08-08,2005-08-10,2005-08-11,2005-08-12", aug.map((r) => r.date));
    check("B10: シフト給与の金額（4.5h×1300）", aug.find((r) => r.kind === "シフト給与")?.amount === 5850, aug);
    check("B10: 収入行", aug.find((r) => r.kind === "収入")?.amount === 30000, aug);
    const csv = toCsv(aug);
    check("B10: BOM＋ヘッダ", csv.startsWith("﻿日付,種別,金額,カテゴリ,メモ,入力方法\r\n"), csv.slice(0, 40));
    check("B10: カンマ入りメモはクォート", csv.includes('"ラーメン,大盛り"'));
    check("B10: 引用符は二重化", csv.includes('"クオート""付き"'));
    check("B10: 行数＝ヘッダ1＋4件", csv.trimEnd().split("\r\n").length === 5, csv.trimEnd().split("\r\n").length);
    let threw = false;
    try {
      await collectExportRows(u5, "2005-08-01'; DROP TABLE expenses;--");
    } catch {
      threw = true;
    }
    check("B10: 不正な期間文字列は例外（SQL連結の防御）", threw);
  }

  // C2: インポート（純粋関数：形式自動判定・カテゴリ解決）
  {
    const zaim = [
      "日付,方法,カテゴリ,カテゴリの内訳,支払元,入金先,品目,メモ,お店,通貨,収入,支出,振替",
      "2005-07-01,payment,食費,食料品,現金,,,ランチ,セブンイレブン,JPY,0,650,0",
      "2005-07-02,income,給与,,,銀行,,,,JPY,50000,0,0",
      "2005-07-03,振替,-,,現金,銀行,,,,JPY,0,10000,0",
    ].join("\n");
    const rz = mapCsv(zaim);
    check("C2: Zaim形式を自動判定", rz.format === "zaim", rz.format);
    check("C2: 振替をスキップして2件", rz.rows.length === 2 && rz.skipped === 1, rz);
    const mf = [
      "計算対象,日付,内容,金額（円）,保有金融機関,大項目,中項目,メモ,振替,ID",
      "1,2005/07/01,ローソン,-540,現金,食費,食料品,,0,a1",
      "1,2005/07/05,給与,250000,銀行,収入,給与,,0,a2",
      "0,2005/07/06,対象外,-100,現金,食費,,,0,a3",
    ].join("\n");
    const rm = mapCsv(mf);
    check("C2: マネーフォワード形式を自動判定", rm.format === "moneyforward", rm.format);
    check("C2: 計算対象0をスキップ・マイナス=支出", rm.rows.length === 2 && rm.rows[0].kind === "expense" && rm.rows[0].amount === 540, rm.rows);
    check("C2: 日付正規化（3形式）", normalizeDate("2005/7/5") === "2005-07-05" && normalizeDate("2005年7月5日") === "2005-07-05" && normalizeDate("だめ") === null);
    check("C2: クォート内カンマのCSVパース", parseCsv('a,b\n"x,y",2\n')[1][0] === "x,y");
    check("C2: カテゴリ完全一致", resolveCategoryId("食費", cats5) === cat5("食費"));
    check("C2: エイリアス（食料品→食費）", resolveCategoryId("食料品", cats5) === cat5("食費"));
    check("C2: エイリアス（光熱費→住まい）", resolveCategoryId("水道・光熱費", cats5) === cat5("住まい"));
    check("C2: 未知カテゴリは null", resolveCategoryId("宇宙開発", cats5) === null);
    check("C2: UTF-8で壊れる場合はShift_JISで読み直す", decodeCsvBuffer(new Uint8Array([0x93, 0xfa, 0x95, 0x74])) === "日付");
  }

  // --- スクショの二度読み判定（2026-07-27の修正：同額の別の支払いを弾かない） ---
  console.log("[dedupe] 画像ハッシュによる二度読み判定");
  {
    const uH = uid();
    await d.run(
      "INSERT INTO users (id, email, name, password_hash, created_at) VALUES (?, ?, ?, ?, ?)",
      uH,
      "hash@example.com",
      "ハッシュ",
      hashPassword("password123"),
      Date.now(),
    );
    const hashA = imageHashOf(new TextEncoder().encode("screenshot-A"));
    const hashB = imageHashOf(new TextEncoder().encode("screenshot-B"));
    check("同じ内容の画像は同じハッシュ", imageHashOf(new TextEncoder().encode("screenshot-A")) === hashA);
    check("違う画像は違うハッシュ", hashA !== hashB);
    check("記録前は null", (await recordedImage(uH, hashA)) === null);
    // 同じ金額・同じ店の支払いを2件（別画像）記録できる
    await d.run(
      "INSERT INTO receipts (id, user_id, store, taken_date, total, items_json, image_hash, created_at) VALUES (?, ?, 'Steam', '2005-07-27', 6100, '[]', ?, ?)",
      uid(),
      uH,
      hashA,
      Date.now(),
    );
    await d.run(
      "INSERT INTO receipts (id, user_id, store, taken_date, total, items_json, image_hash, created_at) VALUES (?, ?, 'Steam', '2005-07-27', 6100, '[]', ?, ?)",
      uid(),
      uH,
      hashB,
      Date.now(),
    );
    const count = Number(
      (await d.get<{ c: number }>("SELECT COUNT(*) AS c FROM receipts WHERE user_id = ?", uH))!.c,
    );
    check("同額・同店の別画像は2件とも保存できる", count === 2, count);
    const hit = await recordedImage(uH, hashA);
    check("同じ画像は検出される", hit?.kind === "expense" && hit.amount === 6100, hit);
    check("検出結果に日付・店名が入る", hit?.date === "2005-07-27" && hit?.memo === "Steam", hit);
    check("未登録の画像は検出されない", (await recordedImage(uH, imageHashOf(new TextEncoder().encode("C")))) === null);
    check("空ハッシュは常に null", (await recordedImage(uH, "")) === null);
    // 収入（スクショ受け取り）も同じ仕組み
    const hashI = imageHashOf(new TextEncoder().encode("income-shot"));
    await d.run(
      "INSERT INTO incomes (id, user_id, date, amount, type, memo, image_hash, created_at) VALUES (?, ?, '2005-07-27', 3000, 'other', 'PayPay受け取り', ?, ?)",
      uid(),
      uH,
      hashI,
      Date.now(),
    );
    const inc = await recordedImage(uH, hashI);
    check("収入側の画像も検出される", inc?.kind === "income" && inc.amount === 3000, inc);
    check("他ユーザーの画像は検出されない", (await recordedImage(userId, hashA)) === null);
    // 記録できたら通知フラグ（既定ON）
    const rp = await d.get<{ record_push: number }>("SELECT record_push FROM users WHERE id = ?", uH);
    check("record_push の既定は1（通知ON）", Number(rp?.record_push) === 1, rp);
  }

  // ---------------------------------------------------------------------------
  // 資産・口座残高の手動管理＋純資産＋推移（accounts / account_snapshots）
  // ---------------------------------------------------------------------------
  {
    console.log("\n[資産] 口座残高・純資産・推移");
    // 純粋関数
    check("normalizeKind: 既知はそのまま", normalizeKind("securities") === "securities");
    check("normalizeKind: 未知は bank", normalizeKind("crypto") === "bank");
    check("normalizeBalance: 小数は丸め", normalizeBalance("bank", 1234.6) === 1235);
    check("normalizeBalance: debt はマイナス入力でも正で保持", normalizeBalance("debt", -5000) === 5000);
    check(
      "netWorthOf: 資産−負債",
      netWorthOf([
        { kind: "bank", balance: 100000 },
        { kind: "cash", balance: 5000 },
        { kind: "debt", balance: 30000 },
      ]) === 75000,
    );

    const uA = uid();
    await d.run(
      "INSERT INTO users (id, email, name, password_hash, created_at) VALUES (?, ?, ?, ?, ?)",
      uA,
      `assets-${uA}@example.com`,
      "資産太郎",
      "x",
      Date.now(),
    );
    const cm = currentMonth();
    const prev = addMonths(cm, -1);

    const bankId = await createAccount(uA, { name: "三井住友銀行", kind: "bank", balance: 200000 });
    await createAccount(uA, { name: "財布", kind: "cash", balance: 8000 });
    const debtId = await createAccount(uA, { name: "カードローン", kind: "debt", balance: -50000 });

    const list = await listAccounts(uA);
    check("口座は sort順で3件", list.length === 3 && list[0].name === "三井住友銀行", list.map((a) => a.name));
    check("debt はマイナス入力でも残高は正で保存", list[2].balance === 50000, list[2]);

    const ov1 = await accountsOverview(uA);
    check("純資産 = 200000+8000-50000", ov1.netWorth === 158000, ov1.netWorth);
    check("前月スナップショットが無いので prevNetWorth は null", ov1.prevNetWorth === null, ov1.prevNetWorth);
    check("推移は当月1点（作成/同期でupsert済み）", ov1.trend.length === 1 && ov1.trend[0].month === cm, ov1.trend);
    check("当月推移点 = 現在純資産", ov1.trend[0].netWorth === 158000, ov1.trend[0]);

    // 前月末スナップショットを直接入れて前月比を検証（銀行が前月末15万だった等）
    await d.run(
      "INSERT INTO account_snapshots (account_id, month, balance) VALUES (?, ?, ?)",
      bankId,
      prev,
      150000,
    );
    await d.run(
      "INSERT INTO account_snapshots (account_id, month, balance) VALUES (?, ?, ?)",
      debtId,
      prev,
      50000,
    );
    const prevNw = await snapshotNetWorth(uA, prev);
    check("前月純資産 = 150000-50000", prevNw === 100000, prevNw);
    const ov2 = await accountsOverview(uA);
    check("prevNetWorth が前月スナップショットから出る", ov2.prevNetWorth === 100000, ov2.prevNetWorth);
    const trend2 = await netWorthTrend(uA, 12);
    check("推移は前月・当月の2点（古い順）", trend2.length === 2 && trend2[0].month === prev, trend2);

    // 残高更新 → 当月スナップショットが最新化される
    await updateAccount(uA, bankId, { balance: 250000 });
    const ov3 = await accountsOverview(uA);
    check("残高更新後の純資産 = 250000+8000-50000", ov3.netWorth === 208000, ov3.netWorth);
    check("当月推移点も最新残高を反映", ov3.trend.at(-1)?.netWorth === 208000, ov3.trend.at(-1));

    // 種別変更（bank→securities）は純資産の符号に影響しない
    await updateAccount(uA, bankId, { kind: "securities" });
    check("種別変更後も listable", (await listAccounts(uA))[0].kind === "securities");

    // 他ユーザーのは更新・削除できない
    check("他人の口座は更新不可", (await updateAccount(userId, bankId, { balance: 1 })) === false);
    check("他人の口座は削除不可", (await deleteAccount(userId, bankId)) === false);

    // 削除するとスナップショットも消える
    const ok = await deleteAccount(uA, bankId);
    check("自分の口座は削除できる", ok === true);
    const snapLeft = Number(
      (await d.get<{ c: number }>(
        "SELECT COUNT(*) AS c FROM account_snapshots WHERE account_id = ?",
        bankId,
      ))!.c,
    );
    check("削除した口座のスナップショットも消える", snapLeft === 0, snapLeft);
    check("残る口座は2件", (await listAccounts(uA)).length === 2);
  }

  console.log(`\n結果: ${passed} passed / ${failed} failed`);
  return { passed, failed };
}
