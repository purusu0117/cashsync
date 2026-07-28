// CashSync demo seed — 架空ユーザー「タロー」。APIのみ経由（本名は一切使わない）。
// 使い方: node .demo/seed-taro.mjs
import { request } from "playwright";

const BASE = "http://localhost:3012";
const MONTH = "2026-07";

const ctx = await request.newContext({ baseURL: BASE });

async function post(path, data) {
  const r = await ctx.post(path, { data });
  const j = await r.json().catch(() => ({}));
  if (!r.ok()) throw new Error(`POST ${path} ${r.status()} ${JSON.stringify(j)}`);
  return j;
}
async function get(path) {
  const r = await ctx.get(path);
  const j = await r.json().catch(() => ({}));
  if (!r.ok()) throw new Error(`GET ${path} ${r.status()} ${JSON.stringify(j)}`);
  return j;
}

// --- 1) 登録（既存なら409→ログイン） ---
const reg = await ctx.post("/api/auth", {
  data: { action: "register", name: "タロー", email: "demo@cashsync.app", password: "demo1234" },
});
if (reg.status() === 409) {
  await post("/api/auth", { action: "login", email: "demo@cashsync.app", password: "demo1234" });
  console.log("既存ユーザーにログイン");
} else if (!reg.ok()) {
  throw new Error(`register failed ${reg.status()} ${await reg.text()}`);
} else {
  console.log("タローを新規登録");
}

// 表示名がタローであることを保証
const me = await get("/api/auth");
if (me.user?.name !== "タロー") throw new Error(`name mismatch: ${me.user?.name}`);
console.log("表示名:", me.user.name);

// --- 2) カテゴリID取得 ---
const cats = {};
for (const c of (await get("/api/categories")).categories) cats[c.name] = c.id;

// --- 3) 貯金目標 ---
await post("/api/profile", { savingsGoal: 50000 });

// --- 4) バイト先（副業カフェ）＋当月シフト ---
const job = await post("/api/jobs", {
  name: "カフェ ソレイユ",
  weekdayRate: 1150,
  weekendHolidayRate: 1300,
  transportPerShift: 400,
  closingDay: 15,
  payDay: 25,
});
const jobId = job.id;
const hm = (h, m = 0) => h * 60 + m;
const shifts = [
  ["2026-07-04", hm(10), hm(16), 45],
  ["2026-07-05", hm(10), hm(15), 30],
  ["2026-07-11", hm(11), hm(17), 45],
  ["2026-07-18", hm(10), hm(16), 45],
  ["2026-07-19", hm(12), hm(18), 45],
  ["2026-07-24", hm(17), hm(21), 0],
  ["2026-07-26", hm(10), hm(15), 30],
];
for (const [date, s, e, b] of shifts)
  await post("/api/shifts", { jobId, date, startMin: s, endMin: e, breakMin: b });
console.log("シフト投入:", shifts.length, "件");

// --- 5) 定期収入・定期支出 ---
await post("/api/recurring", { kind: "income", name: "給料", amount: 230000, postDay: 25, startMonth: MONTH });
await post("/api/recurring", {
  kind: "expense", name: "家賃", amount: 72000, postDay: 27, isFixed: true,
  categoryId: cats["住まい"], startMonth: MONTH,
});
const subs = [
  ["Netflix", 790, 5, cats["サブスク"]],
  ["Spotify", 980, 8, cats["サブスク"]],
  ["ジム 月会費", 7480, 1, cats["娯楽"]],
  ["スマホ ahamo", 2970, 20, cats["通信"]],
];
for (const [name, amount, postDay, categoryId] of subs)
  await post("/api/recurring", { kind: "expense", name, amount, postDay, categoryId, isFixed: true, startMonth: MONTH });
console.log("定期: 収入1 / 支出", 1 + subs.length, "件");

// --- 6) 横断タグ ---
const tRyoko = (await post("/api/tags", { name: "旅行" })).id;
const tOshi = (await post("/api/tags", { name: "推し活" })).id;

// --- 7) 当月の支出（カテゴリ横断・自然なメモ・一部にタグ） ---
const E = [
  ["2026-07-01", 3200, "食費", "スーパー まとめ買い"],
  ["2026-07-02", 680, "食費", "ランチ"],
  ["2026-07-03", 1500, "交通", "Suicaチャージ"],
  ["2026-07-04", 1200, "交際", "カフェ"],
  ["2026-07-05", 4300, "娯楽", "ライブ物販", [tOshi]],
  ["2026-07-06", 520, "食費", "コンビニ"],
  ["2026-07-07", 2980, "洋服", "Tシャツ"],
  ["2026-07-08", 760, "食費", "スーパー"],
  ["2026-07-09", 3500, "交際", "友達と飲み"],
  ["2026-07-10", 1180, "日用品", "ドラッグストア"],
  ["2026-07-11", 890, "食費", "ランチ"],
  ["2026-07-12", 6800, "旅行", "新幹線 予約", [tRyoko]],
  ["2026-07-13", 640, "食費", "コンビニ"],
  ["2026-07-14", 2200, "娯楽", "映画"],
  ["2026-07-15", 1450, "食費", "スーパー"],
  ["2026-07-16", 980, "交通", "タクシー"],
  ["2026-07-17", 3980, "美容", "美容院"],
  ["2026-07-18", 720, "食費", "カフェ"],
  ["2026-07-19", 5200, "旅行", "ホテル予約", [tRyoko]],
  ["2026-07-20", 1300, "食費", "ディナー"],
  ["2026-07-21", 460, "食費", "コンビニ"],
  ["2026-07-22", 2500, "娯楽", "推しグッズ", [tOshi]],
  ["2026-07-23", 1100, "日用品", "洗剤・雑貨"],
  ["2026-07-24", 980, "食費", "ランチ"],
  ["2026-07-25", 3400, "交際", "焼肉"],
];
for (const [date, amount, cat, memo, tagIds] of E)
  await post("/api/expenses", { date, amount, categoryId: cats[cat] ?? null, memo, tagIds: tagIds ?? undefined });
console.log("支出投入:", E.length, "件");

// --- 8) 袋分け予算（stats用） ---
for (const [cat, amount] of [["食費", 40000], ["娯楽", 15000], ["交際", 20000]])
  await post("/api/budgets", { categoryId: cats[cat], amount, carryover: false });

// --- 9) 資産・口座 ---
const accts = [
  ["三井住友銀行", "bank", 620000],
  ["現金", "cash", 15000],
  ["楽天証券", "securities", 240000],
  ["クレジットカード", "debt", 48000],
];
for (const [name, kind, balance] of accts) await post("/api/accounts", { name, kind, balance });

// --- 10) 検証（件数確認） ---
const [exp, inc, sh, rec, tg, acc, sum] = await Promise.all([
  get(`/api/expenses?month=${MONTH}`),
  get(`/api/incomes?month=${MONTH}`),
  get(`/api/shifts?month=${MONTH}`),
  get(`/api/recurring`),
  get(`/api/tags`),
  get(`/api/accounts`),
  get(`/api/summary`),
]);
console.log("=== 検証 ===");
console.log("支出:", exp.expenses.length, "件 / 収入:", inc.incomes.length, "件 / シフト:", sh.shifts.length, "件");
console.log("定期:", rec.items.length, "件 / タグ:", tg.tags.length, "件 / 口座:", acc.accounts.length, "件");
console.log("純資産:", acc.netWorth, "円");
console.log("サマリ 収入合計:", sum.summary.incomeTotal, "支出合計:", sum.summary.expenseTotal, "貯金目標:", sum.savingsGoal);
console.log("表示名(再確認):", sum.user.name);

await ctx.dispose();
console.log("SEED DONE");
