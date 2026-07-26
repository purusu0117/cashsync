// クラウド版UX検証（使い捨てE2E）：
//  1) ログインボタンが押下→遷移完了まで「ログイン中・・・」のまま（途中で「ログイン」に戻らない）
//  2) API往復に人工遅延(600ms)がある状態で、タブ切替時に
//     「初期設定の画面」（バイト先を登録しましょう／¥0デフォルト）がフラッシュしないこと
// 実行: node scripts/e2e-ux-check.mjs  （先に -p 3111 でdevサーバ起動・ユーザー e2e@test.local 登録済みが前提）
import { chromium } from "playwright";

const BASE = "http://localhost:3111";
const DELAY = 600; // 太平洋往復相当の人工遅延
let failed = 0;

function check(name, ok, detail = "") {
  console.log(`${ok ? "OK " : "NG "} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failed++;
}

const browser = await chromium.launch();
const ctx = await browser.newContext();
// 全APIに人工遅延を注入（クラウドのレイテンシ再現）
await ctx.route("**/api/**", async (route) => {
  await new Promise((r) => setTimeout(r, DELAY));
  await route.continue();
});
const page = await ctx.newPage();

// --- 1) ログインボタン ---
await page.goto(`${BASE}/login`);
await page.fill('input[type="email"]', "e2e@test.local");
await page.fill('input[type="password"]', "pass1234");
const btn = page.locator('button[type="submit"]');
await btn.click();

// クリック直後〜遷移完了までボタンの状態をサンプリング
let sawLoggingIn = false;
let revertedToLogin = false;
const t0 = Date.now();
while (Date.now() - t0 < 8000) {
  if (!page.url().includes("/login")) break; // 遷移完了
  const txt = await btn.textContent().catch(() => null);
  if (txt == null) break; // アンマウント＝遷移中
  if (txt.includes("ログイン中")) sawLoggingIn = true;
  if (sawLoggingIn && txt.trim() === "ログイン") revertedToLogin = true;
  await new Promise((r) => setTimeout(r, 50));
}
await page.waitForURL(`${BASE}/`, { timeout: 15000 });
check("ログイン中・・・表示が出る", sawLoggingIn);
check("遷移前に『ログイン』へ戻らない", !revertedToLogin);
check("ホームへ遷移完了", page.url() === `${BASE}/`);

// ホームの初回読み込み完了を待つ（キャッシュを温める）
await page.waitForSelector("text=今日使えるお金", { timeout: 15000 });

// --- 2) 各タブを一度ずつ開いてキャッシュを温める ---
for (const path of ["/history", "/shifts", "/calendar", "/stats", "/weekly", "/settings"]) {
  await page.goto(`${BASE}${path}`);
  await page.waitForTimeout(DELAY + 900); // データ到着待ち
}

// shifts 初回相当の検証：キャッシュを消して初回アクセスし、
// 読み込み中に「バイト先を登録しましょう」（初期設定画面）が出ないこと
await page.evaluate(() => sessionStorage.clear());
await page.goto(`${BASE}/shifts`);
let sawOnboardingFlash = false;
let sawSkeleton = false;
const t1 = Date.now();
while (Date.now() - t1 < DELAY + 800) {
  const html = await page.content();
  if (html.includes("バイト先を登録しましょう")) sawOnboardingFlash = true;
  if (html.includes("読み込み中")) sawSkeleton = true;
  if (html.includes("のシフト")) break;
  await new Promise((r) => setTimeout(r, 60));
}
check("シフト初回: 初期設定画面のフラッシュ無し", !sawOnboardingFlash);
check("シフト初回: スケルトン表示あり", sawSkeleton);
await page.waitForSelector("text=のシフト", { timeout: 15000 });

// --- 3) キャッシュ有りでのタブ切替：遅延中でも自分のデータが即表示される ---
// 履歴を一度開いてキャッシュを温める
await page.goto(`${BASE}/history`);
await page.waitForSelector("text=seven eleven", { timeout: 15000 });

// 履歴→シフト→履歴 と切り替え、切替直後(遅延経過前)に自分のデータが見えるか
await page.goto(`${BASE}/shifts`);
const shiftShownAt = Date.now();
const shiftVisible = await page
  .waitForSelector("text=のシフト", { timeout: DELAY - 100 })
  .then(() => true)
  .catch(() => false);
check(
  "シフト切替: 遅延経過前にキャッシュ表示",
  shiftVisible,
  `${Date.now() - shiftShownAt}ms`,
);

await page.goto(`${BASE}/history`);
const histShownAt = Date.now();
const histVisible = await page
  .waitForSelector("text=seven eleven", { timeout: DELAY - 100 })
  .then(() => true)
  .catch(() => false);
check(
  "履歴切替: 遅延経過前にキャッシュ表示（¥0フラッシュ無し）",
  histVisible,
  `${Date.now() - histShownAt}ms`,
);

// ホーム切替時に金額のデフォルトフラッシュが無いか（今日使えるお金が即出る）
// ※上の sessionStorage.clear() でホームのキャッシュも消えているので、一度温め直してから測る
await page.goto(`${BASE}/`);
await page.waitForSelector("text=今日使えるお金", { timeout: 15000 });
await page.goto(`${BASE}/history`);
await page.waitForTimeout(DELAY + 500);
await page.goto(`${BASE}/`);
const homeVisible = await page
  .waitForSelector("text=今日使えるお金", { timeout: DELAY - 100 })
  .then(() => true)
  .catch(() => false);
check("ホーム切替: 遅延経過前にキャッシュ表示", homeVisible);

// カレンダー: 一度見た月へ戻ると即表示
await page.goto(`${BASE}/calendar`);
await page.waitForSelector("text=のお金", { timeout: 15000 });
await page.waitForTimeout(DELAY + 500);
await page.click("text=◀"); // 前月へ（初回は読み込み）
await page.waitForTimeout(DELAY + 800);
await page.click("text=▶"); // 今月へ戻る（キャッシュ即表示のはず）
const calBack = Date.now();
// 今月表示のヘッダが遅延前に更新され、データ(内訳セクション)も出ていること
await page.waitForTimeout(200);
const calHtml = await page.content();
check(
  "カレンダー月切替: 戻りが即表示",
  calHtml.includes("今日使えるお金の計算") || calHtml.includes("この月の収支"),
  `${Date.now() - calBack}ms時点で内訳表示`,
);

// --- 4) ログアウトでキャッシュが消えること ---
await page.goto(`${BASE}/settings`);
await page.waitForSelector("text=ログアウト", { timeout: 15000 });
await page.waitForTimeout(DELAY + 500);
await page.click("text=ログアウト");
await page.waitForURL(`${BASE}/login*`, { timeout: 15000 });
const cacheKeys = await page.evaluate(() =>
  Object.keys(sessionStorage).filter((k) => k.startsWith("cashsync-api:")),
);
check(
  "ログアウトでAPIキャッシュ全消し",
  cacheKeys.length === 0,
  cacheKeys.length ? `残り: ${cacheKeys.join(", ")}` : "残り0件",
);

await browser.close();
console.log(failed === 0 ? "\nすべてのUX検証に合格" : `\n${failed}件失敗`);
process.exit(failed === 0 ? 0 : 1);
