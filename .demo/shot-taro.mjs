// App Store 6.7"（1290x2796）スクショ。使い方: node .demo/shot-taro.mjs <outDir>
import { chromium } from "playwright";
import fs from "node:fs";

const outDir = process.argv[2];
if (!outDir) throw new Error("outDir required");
fs.mkdirSync(outDir, { recursive: true });

const BASE = "http://localhost:3012";

const browser = await chromium.launch();
const ctx = await browser.newContext({
  viewport: { width: 430, height: 932 },
  deviceScaleFactor: 3, // → 1290x2796（App Store 6.7"）
  isMobile: true,
  hasTouch: true,
  locale: "ja-JP",
  timezoneId: "Asia/Tokyo",
});

const res = await ctx.request.post(`${BASE}/api/auth`, {
  data: { action: "login", email: "demo@cashsync.app", password: "demo1234" },
});
if (!(await res.json()).ok) throw new Error("login failed");

const page = await ctx.newPage();
const hideOverlays = () =>
  page.addStyleTag({
    content:
      "nextjs-portal{display:none!important} [data-toast],[role='status']{display:none!important}",
  });

async function shot(file, path, prep) {
  await page.goto(`${BASE}${path}`, { waitUntil: "networkidle" });
  await hideOverlays();
  await page.waitForTimeout(1200);
  if (prep) await prep();
  await page.waitForTimeout(2000); // フォント・グラフ描画・キャッシュ差し替え待ち
  await page.screenshot({ path: `${outDir}/${file}` });
  console.log("shot:", file, path);
}

// 01 ホーム（週次振り返り案内カードは閉じてクリーンに）
await shot("01-home.png", "/", async () => {
  const close = page.locator('button[aria-label="閉じる"]');
  if (await close.count()) await close.first().click().catch(() => {});
});
// 02 カレンダー（色付きシフト＋給料日）
await shot("02-calendar.png", "/calendar");
// 03 履歴（当月の記録一覧）
await shot("03-history.png", "/history");
// 04 グラフ（月の収支＋カテゴリ内訳）
await shot("04-stats.png", "/stats");
// 05 資産（口座残高＋純資産）
await shot("05-assets.png", "/stats", async () => {
  const tab = page.getByRole("button", { name: "資産", exact: true });
  if (await tab.count()) await tab.first().click();
});
// 06 週次振り返り
await shot("06-weekly.png", "/weekly");

await browser.close();
console.log("SHOTS DONE ->", outDir);
