// sqlite / Postgres(PGlite) 両アダプタで共通実行するテストスイート。
// アプリ本体のドメインロジック（seedCategories / money / aiUsage）を
// setDbForTesting で注入したアダプタ経由で実際に呼ぶ。
import { randomBytes, scryptSync } from "node:crypto";
import { isCategoryIconKey, stripCategoryEmoji } from "../src/lib/categoryIcons";
import { migrateCategoryIcons, setDbForTesting, seedCategories, uid, type Db } from "../src/lib/db";
import { checkAndCountUsage, getUserPlan, FREE_LIMITS, PREMIUM_SCAN_LIMIT } from "../src/lib/aiUsage";
import { applyPurchaseEvent, setPlanFromEntitlement } from "../src/lib/purchases-server";
import {
  duplicateExpenseExists,
  duplicateIncomeExists,
  learnMerchantCategory,
  learnedCategoryId,
  normalizeMerchant,
} from "../src/lib/merchant";
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

  console.log(`\n結果: ${passed} passed / ${failed} failed`);
  return { passed, failed };
}
