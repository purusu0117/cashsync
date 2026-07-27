// Batch5（データ系）の数値実証スクリプト。
// 一時sqlite（.data/verify-batch5.db）を使う。実行: node scripts/verify-batch5.mjs
//  - C12: 固定費/変動費の区別（is_fixed=0の定期は変動費・旧レコードは固定扱いの回帰）
//  - C13: 袋分けポケットの繰り越し（前月の余りを加算・マイナス繰り越しなし）
//  - B11: 支出検索（部分一致・カテゴリ・金額範囲・ページング・LIKEメタ文字・他人のデータ非混入）
//  - B10: CSVエクスポート（支出/収入/シフト給与・期間・エスケープ・BOM）
//  - C2 : インポート（Zaim/マネーフォワード/汎用の自動判定・振替スキップ・カテゴリ解決・SJIS）
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
const DB = path.join(root, ".data", "verify-batch5.db");
for (const suffix of ["", "-wal", "-shm"]) fs.rmSync(DB + suffix, { force: true });
process.env.CASHSYNC_DB_PATH = DB;

const { db, uid, seedCategories } = await import(`file://${root}/src/lib/db.ts`);
const {
  FIXED_EXPENSE_COND,
  VARIABLE_EXPENSE_COND,
  categoryBreakdown,
  dailyBudget,
  monthFixedCost,
  monthSummary,
  pocketBudgets,
  postRecurringForMonth,
  searchExpenses,
  todaySpent,
} = await import(`file://${root}/src/lib/money.ts`);
const { collectExportRows, toCsv } = await import(`file://${root}/src/lib/exportCsv.ts`);
const { decodeCsvBuffer, mapCsv, normalizeDate, parseCsv, resolveCategoryId } = await import(
  `file://${root}/src/lib/importCsv.ts`
);
const { hashPassword } = await import(`file://${root}/src/lib/password.ts`);

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

function addUser(id, email) {
  d.prepare(
    "INSERT INTO users (id, email, name, password_hash, created_at) VALUES (?,?,?,?,?)",
  ).run(id, email, id, hashPassword("password123"), Date.now());
  seedCategories(id);
}
const catId = (u, name) =>
  d.prepare("SELECT id FROM categories WHERE user_id = ? AND name = ?").get(u, name).id;
const spend = (u, date, amount, memo = "", categoryId = null, source = "manual") =>
  d
    .prepare(
      "INSERT INTO expenses (id, user_id, date, amount, category_id, memo, source, created_at) VALUES (?,?,?,?,?,?,?,?)",
    )
    .run(uid(), u, date, amount, categoryId, memo, source, Date.now());
const income = (u, date, amount, memo = "") =>
  d
    .prepare(
      "INSERT INTO incomes (id, user_id, date, amount, type, memo, created_at) VALUES (?,?,?,?,'other',?,?)",
    )
    .run(uid(), u, date, amount, memo, Date.now());
const addRecurring = (u, name, amount, isFixed, postDay = 1, categoryId = null) => {
  const id = uid();
  d.prepare(
    "INSERT INTO recurring_items (id, user_id, kind, name, amount, category_id, start_month, end_month, post_day, interval, is_fixed) VALUES (?,?,'expense',?,?,?,?,NULL,?, 'monthly', ?)",
  ).run(id, u, name, amount, categoryId, "2026-07", postDay, isFixed ? 1 : 0);
  return id;
};

// ---------------------------------------------------------------------------
console.log("== C12: 固定費/変動費の区別 ==");
const U1 = "u1-fixed";
addUser(U1, "u1@example.com");
const food1 = catId(U1, "食費");
addRecurring(U1, "家賃", 60000, true, 1, catId(U1, "住まい")); // 固定費
addRecurring(U1, "ジム（変動扱い）", 8000, false, 1, food1); // 変動費として扱う
postRecurringForMonth(U1, "2026-07");
spend(U1, "2026-07-05", 1200, "コンビニ", food1); // 手入力＝変動費
// 旧レコード（recurring_id が NULL の定期計上）は従来どおり固定扱い
spend(U1, "2026-07-03", 5000, "旧定期", null, "recurring");

eq(monthFixedCost(U1, "2026-07"), 65000, "monthFixedCost = 家賃60000 + 旧レコード5000（変動扱いの8000は除く）");
eq(todaySpent(U1, "2026-07-01"), 8000, "todaySpent(7/1) = is_fixed=0 の定期計上のみ（家賃は入らない）");
eq(todaySpent(U1, "2026-07-05"), 1200, "todaySpent(7/5) = 手入力1200");
{
  const varTotal = d
    .prepare(
      `SELECT COALESCE(SUM(e.amount),0) AS s FROM expenses e WHERE e.user_id = ? AND ${VARIABLE_EXPENSE_COND}`,
    )
    .get(U1).s;
  const fixTotal = d
    .prepare(
      `SELECT COALESCE(SUM(e.amount),0) AS s FROM expenses e WHERE e.user_id = ? AND ${FIXED_EXPENSE_COND}`,
    )
    .get(U1).s;
  eq(varTotal, 9200, "変動費合計 = 8000 + 1200");
  eq(fixTotal, 65000, "固定費合計 = 60000 + 5000");
  eq(varTotal + fixTotal, monthSummary(U1, "2026-07").expenseTotal, "固定＋変動 = 支出総額（取りこぼしなし）");
}
{
  // C12: 変動扱いの定期は「今日使えるお金」の日々の支出側に効く
  const s = monthSummary(U1, "2026-07");
  const b = dailyBudget(s, todaySpent(U1, "2026-07-05"), 0, "2026-07-05", monthFixedCost(U1, "2026-07"));
  eq(b.fixedTotal, 65000, "dailyBudget.fixedTotal = 固定費のみ");
  eq(b.spentBeforeToday, 8000, "dailyBudget.spentBeforeToday = 変動扱いの定期8000");
  eq(b.spentToday, 1200, "dailyBudget.spentToday = 今日の変動支出");
}

console.log("== C12回帰: 既定（全定期 is_fixed=1）は従来の source 判定と完全一致 ==");
{
  const U0 = "u0-legacy";
  addUser(U0, "u0@example.com");
  addRecurring(U0, "家賃", 50000, true, 1);
  addRecurring(U0, "サブスク", 1000, true, 5);
  postRecurringForMonth(U0, "2026-07");
  spend(U0, "2026-07-10", 700, "パン");
  const legacyFixed = d
    .prepare("SELECT COALESCE(SUM(amount),0) AS s FROM expenses WHERE user_id=? AND source='recurring'")
    .get(U0).s;
  const legacyToday = d
    .prepare("SELECT COALESCE(SUM(amount),0) AS s FROM expenses WHERE user_id=? AND date=? AND source<>'recurring'")
    .get(U0, "2026-07-05").s;
  eq(monthFixedCost(U0, "2026-07"), legacyFixed, "monthFixedCost == 旧 source='recurring' 集計");
  eq(monthFixedCost(U0, "2026-07"), 51000, "monthFixedCost 実額");
  eq(todaySpent(U0, "2026-07-05"), legacyToday, "todaySpent == 旧 source<>'recurring' 集計");
  eq(categoryBreakdown(U0, "2026-07").reduce((a, c) => a + c.amount, 0), 51700, "categoryBreakdown 合計は従来どおり全支出");
}

// ---------------------------------------------------------------------------
console.log("== C13: 袋分けポケットの繰り越し ==");
const U2 = "u2-pocket";
addUser(U2, "u2@example.com");
const p食費 = catId(U2, "食費");
const p娯楽 = catId(U2, "娯楽");
const p交通 = catId(U2, "交通");
const setBudget = (cat, amount, carry) =>
  d
    .prepare(
      "INSERT INTO category_budgets (user_id, category_id, amount, carryover) VALUES (?,?,?,?)",
    )
    .run(U2, cat, amount, carry ? 1 : 0);
setBudget(p食費, 30000, true); // 繰り越しON・前月余りあり
setBudget(p娯楽, 10000, true); // 繰り越しON・前月オーバー
setBudget(p交通, 5000, false); // 繰り越しOFF
spend(U2, "2026-06-10", 22000, "先月の食費", p食費); // 前月支出（余り8000）
spend(U2, "2026-06-12", 13000, "先月の娯楽", p娯楽); // 前月オーバー（-3000）
spend(U2, "2026-06-15", 1000, "先月の交通", p交通); // 余り4000だが繰り越しOFF
spend(U2, "2026-07-02", 4000, "今月の食費", p食費);
{
  const pockets = pocketBudgets(U2, "2026-07");
  const find = (id) => pockets.find((p) => p.id === id);
  eq(find(p食費).carryoverAmount, 8000, "食費: 前月の余り 30000-22000 が繰り越される");
  eq(find(p食費).budget, 30000, "食費: 土台の予算は据え置き");
  eq(find(p食費).spent, 4000, "食費: 今月の支出");
  eq(find(p娯楽).carryoverAmount, 0, "娯楽: 前月オーバーでもマイナス繰り越しはしない（0下限）");
  eq(find(p交通).carryoverAmount, 0, "交通: 繰り越しOFFなら常に0");
  eq(find(p交通).carryover, 0, "交通: carryoverフラグ0");
  eq(find(catId(U2, "美容")).budget, 0, "予算未設定カテゴリは budget=0");
  eq(find(catId(U2, "美容")).carryoverAmount, 0, "予算0のカテゴリは繰り越し0（予算未設定に繰り越さない）");
  eq(pockets.length, 14, "ポケットは全カテゴリ分（14件）");
}

// ---------------------------------------------------------------------------
console.log("== B11: 支出の検索 ==");
const U3 = "u3-search";
addUser(U3, "u3@example.com");
const s食費 = catId(U3, "食費");
const s娯楽 = catId(U3, "娯楽");
spend(U3, "2026-05-01", 500, "セブンイレブン 矢部店", s食費);
spend(U3, "2026-06-01", 1500, "セブンイレブン 淵野辺店", s食費);
spend(U3, "2026-07-01", 3000, "スチーム ゲーム", s娯楽);
spend(U3, "2026-07-02", 12000, "セブン銀行 引き出し", null);
spend(U3, "2026-07-03", 800, "50%OFFセール", s娯楽);
const other = "u3-other";
addUser(other, "u3other@example.com");
spend(other, "2026-07-01", 9999, "セブンイレブン 他人の支出", null);
{
  const r = searchExpenses(U3, { q: "セブン" });
  eq(r.total, 3, "「セブン」の全期間ヒット数（他ユーザー分は混ざらない）");
  eq(r.expenses[0].date, "2026-07-02", "検索結果は日付降順");
  eq(r.expenses.map((e) => e.amount), [12000, 1500, 500], "検索結果の金額（降順）");
  eq(searchExpenses(U3, { q: "セブンイレブン" }).total, 2, "より長い語で絞り込める");
  eq(searchExpenses(U3, { q: "  セブン  " }).total, 3, "前後の空白は無視");
  eq(searchExpenses(U3, { q: "%" }).total, 1, "LIKEメタ文字 % はリテラル扱い（50%OFFのみ）");
  eq(searchExpenses(U3, { q: "_" }).total, 0, "LIKEメタ文字 _ もリテラル扱い");
  eq(searchExpenses(U3, { categoryId: s食費 }).total, 2, "カテゴリで絞り込み");
  eq(searchExpenses(U3, { q: "セブン", categoryId: s食費 }).total, 2, "語＋カテゴリの複合");
  eq(searchExpenses(U3, { min: 1000 }).total, 3, "金額下限");
  eq(searchExpenses(U3, { max: 1000 }).total, 2, "金額上限");
  eq(searchExpenses(U3, { min: 800, max: 3000 }).total, 3, "金額範囲（両端含む）");
  const page1 = searchExpenses(U3, { limit: 2, offset: 0 });
  const page2 = searchExpenses(U3, { limit: 2, offset: 2 });
  eq(page1.expenses.length, 2, "1ページ目の件数");
  eq(page1.total, 5, "total はページングに関係なく全件");
  eq(page2.expenses.length, 2, "2ページ目の件数");
  eq(
    new Set([...page1.expenses, ...page2.expenses].map((e) => e.id)).size,
    4,
    "ページ間で重複しない",
  );
  eq(page1.expenses[0].category, "娯楽", "カテゴリ名がJOINされる");
  eq(searchExpenses(U3, { q: "存在しない店" }).total, 0, "ヒット0件");
}

// ---------------------------------------------------------------------------
console.log("== B10: CSVエクスポート ==");
const U4 = "u4-export";
addUser(U4, "u4@example.com");
spend(U4, "2026-07-10", 1000, "ラーメン,大盛り", catId(U4, "食費")); // カンマ入り
spend(U4, "2026-07-12", 2000, 'クオート"付き', catId(U4, "娯楽")); // 引用符入り
spend(U4, "2026-06-30", 999, "前月の支出", null); // 期間外
income(U4, "2026-07-11", 30000, "メルカリ売上");
d.prepare(
  "INSERT INTO jobs (id, user_id, name, weekday_rate, weekend_holiday_rate, transport_per_shift, calendar_keywords, closing_day, pay_month_offset, pay_day) VALUES ('j4',?, 'キミハン', 1300, 1400, 0, '', 31, 0, 25)",
).run(U4);
// 2026-07-06(月) 18:00-22:30 休憩0 → 4.5h × 1300 = 5850
d.prepare(
  "INSERT INTO shifts (id, user_id, job_id, date, start_min, end_min, break_min, source) VALUES (?,?, 'j4', '2026-07-06', 1080, 1350, 0, 'manual')",
).run(uid(), U4);
{
  const all = collectExportRows(U4);
  eq(all.length, 5, "全期間の行数（支出3＋収入1＋シフト1）");
  eq(all.map((r) => r.date), ["2026-06-30", "2026-07-06", "2026-07-10", "2026-07-11", "2026-07-12"], "日付昇順");
  const july = collectExportRows(U4, "2026-07-01", "2026-07-31");
  eq(july.length, 4, "期間指定で前月分が除外される");
  eq(july.filter((r) => r.kind === "シフト給与")[0].amount, 5850, "シフト給与の金額（4.5h×1300）");
  eq(july.filter((r) => r.kind === "収入")[0].amount, 30000, "収入行");
  eq(july.filter((r) => r.kind === "支出")[0].category, "食費", "支出行のカテゴリ名");
  const csv = toCsv(july);
  eq(csv.startsWith("﻿日付,種別,金額,カテゴリ,メモ,入力方法\r\n"), true, "BOM＋ヘッダ行");
  eq(csv.includes('"ラーメン,大盛り"'), true, "カンマを含むメモはクォートされる");
  eq(csv.includes('"クオート""付き"'), true, "引用符は二重化される");
  eq(csv.trimEnd().split("\r\n").length, 5, "CSVの行数＝ヘッダ1＋データ4");
  eq(csv.endsWith("\r\n"), true, "末尾は改行で終わる");
  let threw = false;
  try {
    collectExportRows(U4, "2026-07-01'; DROP TABLE expenses;--");
  } catch {
    threw = true;
  }
  eq(threw, true, "日付形式が不正な期間は例外（SQL文字列連結の防御）");
}

// ---------------------------------------------------------------------------
console.log("== C2: インポート（CSVパース） ==");
eq(parseCsv('a,b\n1,2\n')[1], ["1", "2"], "基本のCSVパース");
eq(parseCsv('a,b\n"x,y",2\n')[1], ["x,y", "2"], "クォート内のカンマ");
eq(parseCsv('a,b\n"改\n行",2\n')[1], ["改\n行", "2"], "クォート内の改行");
eq(parseCsv('a,b\n"二""重",2\n')[1], ['二"重', "2"], "エスケープされた引用符");
eq(parseCsv('﻿a,b\n1,2')[0], ["a", "b"], "BOM除去");
eq(parseCsv("a,b\r\n1,2\r\n").length, 2, "CRLF");
eq(normalizeDate("2026/7/5"), "2026-07-05", "日付 2026/7/5");
eq(normalizeDate("2026-07-05"), "2026-07-05", "日付 2026-07-05");
eq(normalizeDate("2026年7月5日"), "2026-07-05", "日付 2026年7月5日");
eq(normalizeDate("2026/07/05 12:30"), "2026-07-05", "日付＋時刻");
eq(normalizeDate("なし"), null, "解釈できない日付は null");
eq(normalizeDate("2026/13/05"), null, "13月は null");

console.log("== C2: Zaim形式 ==");
{
  const zaim = [
    "日付,方法,カテゴリ,カテゴリの内訳,支払元,入金先,品目,メモ,お店,通貨,収入,支出,振替",
    "2026-07-01,payment,食費,食料品,現金,,,ランチ,セブンイレブン,JPY,0,650,0",
    "2026-07-02,income,給与,,,銀行,,,,JPY,50000,0,0",
    "2026-07-03,振替,-,,現金,銀行,,,,JPY,0,10000,0",
    "不明な日付,payment,食費,,現金,,,,,JPY,0,300,0",
  ].join("\n");
  const r = mapCsv(zaim);
  eq(r.format, "zaim", "Zaim形式を自動判定");
  eq(r.rows.length, 2, "取り込み行数（振替と日付不正はスキップ）");
  eq(r.skipped, 2, "スキップ数");
  eq(r.rows[0], { date: "2026-07-01", kind: "expense", amount: 650, category: "食費", memo: "セブンイレブン" }, "支出行");
  eq(r.rows[1].kind, "income", "収入行");
  eq(r.rows[1].amount, 50000, "収入額");
}

console.log("== C2: マネーフォワードME形式 ==");
{
  const mf = [
    "計算対象,日付,内容,金額（円）,保有金融機関,大項目,中項目,メモ,振替,ID",
    "1,2026/07/01,ローソン,-540,現金,食費,食料品,,0,a1",
    "1,2026/07/05,給与,250000,銀行,収入,給与,,0,a2",
    "0,2026/07/06,対象外,-100,現金,食費,,,0,a3",
    "1,2026/07/07,口座間移動,-20000,銀行,振替,,,1,a4",
    "1,2026/07/08,カンマ入り,\"-1,234\",現金,日用品,,,0,a5",
  ].join("\n");
  const r = mapCsv(mf);
  eq(r.format, "moneyforward", "マネーフォワード形式を自動判定");
  eq(r.rows.length, 3, "取り込み行数（計算対象0と振替1はスキップ）");
  eq(r.skipped, 2, "スキップ数");
  eq(r.rows[0], { date: "2026-07-01", kind: "expense", amount: 540, category: "食費", memo: "ローソン" }, "マイナス金額＝支出");
  eq(r.rows[1].kind, "income", "プラス金額＝収入");
  eq(r.rows[2].amount, 1234, "3桁区切りのカンマを含む金額");
}

console.log("== C2: 汎用形式 ==");
{
  const generic = ["日付,金額,カテゴリ,メモ,種別", "2026/7/1,1000,食費,パン,支出", "2026/7/2,5000,,バイト代,収入"].join("\n");
  const r = mapCsv(generic);
  eq(r.format, "generic", "汎用形式");
  eq(r.rows.length, 2, "取り込み行数");
  eq(r.rows[0].category, "食費", "カテゴリ列");
  eq(r.rows[1].kind, "income", "種別列で収入判定");
  eq(mapCsv("なんの列もない,データ\n1,2").rows.length, 0, "日付列が無ければ0件");
  eq(mapCsv("").rows.length, 0, "空文字は0件");
  eq(mapCsv("日付,金額\n").rows.length, 0, "ヘッダのみは0件");
}

console.log("== C2: カテゴリ解決・文字コード ==");
{
  const cats = d.prepare("SELECT id, name FROM categories WHERE user_id = ?").all(U3);
  const nameOf = (id) => cats.find((c) => c.id === id)?.name ?? null;
  eq(nameOf(resolveCategoryId("食費", cats)), "食費", "完全一致");
  eq(nameOf(resolveCategoryId("食料品", cats)), "食費", "エイリアス 食料品→食費");
  eq(nameOf(resolveCategoryId("カフェ", cats)), "食費", "エイリアス カフェ→食費");
  eq(nameOf(resolveCategoryId("水道・光熱費", cats)), "住まい", "エイリアス 光熱費→住まい");
  eq(nameOf(resolveCategoryId("スマホ代", cats)), "通信", "エイリアス スマホ→通信");
  eq(resolveCategoryId("", cats), null, "空文字は null");
  eq(resolveCategoryId("宇宙開発", cats), null, "対応するカテゴリが無ければ null");
  eq(decodeCsvBuffer(new TextEncoder().encode("日付,金額")), "日付,金額", "UTF-8はそのまま");
  eq(decodeCsvBuffer(new Uint8Array([0x93, 0xfa, 0x95, 0x74])), "日付", "UTF-8で壊れる場合はShift_JISで読み直す");
}

// ---------------------------------------------------------------------------
console.log(failed === 0 ? "\n✅ Batch5 検証: 全項目パス" : `\n❌ Batch5 検証: ${failed}件NG`);
// 一時DBを掃除（Windowsはハンドルが残ると消せないので、先に閉じてから・失敗は無視）
try {
  d.close();
} catch {}
for (const suffix of ["", "-wal", "-shm"]) {
  try {
    fs.rmSync(DB + suffix, { force: true });
  } catch {}
}
process.exit(failed === 0 ? 0 : 1);
