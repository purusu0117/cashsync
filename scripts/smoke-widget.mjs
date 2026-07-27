// C4: ウィジェット用API（/api/widget）の実証。
// 実行: BASE=http://localhost:3007 node scripts/smoke-widget.mjs
// 前提: 検証用の空DBで next start しておくこと（AIは使わないので速い）。
const BASE = process.env.BASE ?? "http://localhost:3007";
let cookie = "";
let failed = 0;

function eq(actual, expected, label) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a === b) console.log(`  ok  ${label} = ${a}`);
  else {
    failed++;
    console.error(`  NG  ${label}: got ${a}, want ${b}`);
  }
}

async function req(path, init = {}) {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { ...(init.headers ?? {}), ...(cookie ? { cookie } : {}) },
    redirect: "manual",
  });
  for (const c of res.headers.getSetCookie?.() ?? []) {
    if (c.startsWith("cashsync_session=") && !c.startsWith("cashsync_session=;")) {
      cookie = c.split(";")[0];
    }
  }
  return res;
}
const json = async (p, init) => {
  const res = await req(p, init);
  const text = await res.text();
  try {
    return { status: res.status, body: JSON.parse(text) };
  } catch {
    return { status: res.status, body: text };
  }
};
const postJson = (p, data) =>
  json(p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(data) });
const widget = async (token) => {
  const res = await fetch(`${BASE}/api/widget`, {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
  return { status: res.status, body: await res.json() };
};

console.log("== 認証 ==");
eq((await widget(null)).status, 401, "トークン無しは401");
eq((await widget("dummy-token-xxxxxxxx")).status, 401, "不正なトークンは401");

console.log("== 準備（登録・収入・支出） ==");
const email = `widget-${Date.now()}@example.com`;
eq(
  (await postJson("/api/auth", { action: "register", name: "ウィジェット", email, password: "password123" })).status,
  200,
  "アカウント登録",
);
const token = (await json("/api/profile")).body.apiToken;
eq(typeof token === "string" && token.length > 10, true, "APIトークン取得");
const today = new Date().toISOString().slice(0, 10);
eq((await postJson("/api/incomes", { date: today, amount: 100000, memo: "テスト収入" })).status, 200, "収入10万を記録");

console.log("== 数字が返る ==");
{
  const r = await widget(token);
  eq(r.status, 200, "ステータス");
  eq(typeof r.body.remainingToday, "number", "今日あと使える額（数値）");
  eq(typeof r.body.todayBudget, "number", "今日の予算");
  eq(r.body.spentToday, 0, "今日の支出はまだ0");
  eq(r.body.date, today, "日付は今日");
  eq(typeof r.body.updatedAt, "number", "更新時刻");
  eq(r.body.daysRemaining > 0, true, "残り日数は1以上");
  eq(r.body.nextPayday, null, "バイト先未登録なら給料日はnull");
}

console.log("== 支出を記録すると「今日あと」が満額減る ==");
{
  const before = (await widget(token)).body;
  eq((await postJson("/api/expenses", { date: today, amount: 1000, memo: "ウィジェット確認" })).status, 200, "支出1,000円を記録");
  const after = (await widget(token)).body;
  eq(after.spentToday, 1000, "今日の支出が反映される");
  eq(before.remainingToday - after.remainingToday, 1000, "今日あと使える額が1,000円ちょうど減る");
  eq(after.todayBudget, before.todayBudget, "今日の予算そのものは変わらない（減るのは残額）");
}

console.log(failed === 0 ? "\n✅ ウィジェットAPI: 全項目パス" : `\n❌ ウィジェットAPI: ${failed}件NG`);
process.exit(failed === 0 ? 0 : 1);
