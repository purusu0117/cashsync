// 絵文字全廃の検証E2E：主要画面のページテキストに絵文字コードポイントが残っていないか。
// ✓/✕/◀/▶ 等のモノクロ記号（感熱紙の印字と馴染むタイポグラフィ記号）は許可。
// 実行手順:
//   1) CASHSYNC_DB_PATH=<一時ファイル> npx next dev -p 3111 でサーバ起動
//   2) node scripts/e2e-emoji-sweep.mjs
import { chromium } from "playwright";

const BASE = process.env.SWEEP_BASE || "http://localhost:3111";
let failed = 0;

function check(name, ok, detail = "") {
  console.log(`${ok ? "OK " : "NG "} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failed++;
}

// 色絵文字系のコードポイント（Misc Symbols / Dingbats / 全絵文字ブロック / 異体字セレクタ / 国旗）
const EMOJI_RE =
  /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}\u{1F1E6}-\u{1F1FF}]/gu;
// 許可するモノクロ記号（チェック・バツ）
const ALLOWED = new Set(["✓", "✕"]);

const browser = await chromium.launch();
const page = await browser.newContext().then((c) => c.newPage());

// --- 新規ユーザー登録（毎回ユニークなメール） ---
const email = `sweep-${Date.now()}@test.local`;
const reg = await page.request.post(`${BASE}/api/auth`, {
  data: { action: "register", name: "掃除係", email, password: "pass1234" },
});
check("ユーザー登録", reg.ok(), String(reg.status()));

// --- データを少し入れて表示分岐を増やす ---
const cats = await (await page.request.get(`${BASE}/api/categories`)).json();
const food = cats.categories?.find((c) => c.name === "食費");
check("カテゴリにアイコンキーが入っている", food?.icon === "food", JSON.stringify(food));
await page.request.post(`${BASE}/api/expenses`, {
  data: { amount: 650, categoryId: food?.id ?? null, memo: "セブンイレブン", source: "manual" },
});
await page.request.post(`${BASE}/api/recurring`, {
  data: { kind: "expense", name: "Netflix", amount: 990, categoryId: null, postDay: 1 },
});

// --- 主要画面を巡回してページテキストの絵文字を検査 ---
const routes = ["/", "/add", "/scan", "/history", "/calendar", "/stats", "/weekly", "/shifts", "/settings"];
for (const r of routes) {
  await page.goto(`${BASE}${r}`, { waitUntil: "networkidle" });
  await page.waitForTimeout(600); // キャッシュファースト描画の差し替え待ち
  const text = await page.evaluate(() => document.body.innerText);
  const hits = [...new Set((text.match(EMOJI_RE) ?? []).filter((ch) => !ALLOWED.has(ch)))];
  check(
    `${r} に絵文字なし`,
    hits.length === 0,
    hits.map((h) => `${h}(U+${h.codePointAt(0).toString(16).toUpperCase()})`).join(" "),
  );
}

// ログアウト状態の /login も検査
await page.request.post(`${BASE}/api/auth`, { data: { action: "logout" } });
await page.goto(`${BASE}/login`, { waitUntil: "networkidle" });
const loginText = await page.evaluate(() => document.body.innerText);
const loginHits = [...new Set((loginText.match(EMOJI_RE) ?? []).filter((ch) => !ALLOWED.has(ch)))];
check("/login に絵文字なし", loginHits.length === 0, loginHits.join(" "));

await browser.close();
console.log(failed === 0 ? "\nすべてOK" : `\n${failed}件NG`);
process.exit(failed > 0 ? 1 : 0);
