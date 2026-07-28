// ホームを「月末までの予測」ブロックが主役に見える位置までスクロールして実キャプチャ。
// 使い方: node .demo/shot-forecast.mjs <outDir>
import { chromium } from "playwright";
import fs from "node:fs";

const outDir = process.argv[2];
if (!outDir) throw new Error("outDir required");
fs.mkdirSync(outDir, { recursive: true });
const BASE = "http://localhost:3014";

const browser = await chromium.launch();
const ctx = await browser.newContext({
  viewport: { width: 430, height: 932 },
  deviceScaleFactor: 3,
  isMobile: true,
  hasTouch: true,
  locale: "ja-JP",
  timezoneId: "Asia/Tokyo",
});
const login = await ctx.request.post(`${BASE}/api/auth`, {
  data: { action: "login", email: "demo@cashsync.app", password: "demo1234" },
});
if (!(await login.json()).ok) throw new Error("login failed");

const page = await ctx.newPage();
await page.goto(`${BASE}/`, { waitUntil: "networkidle" });
await page.addStyleTag({
  content: "nextjs-portal{display:none!important} [data-toast],[role='status']{display:none!important}",
});
// 週次/月次の案内カードは閉じる
for (const b of await page.locator('button[aria-label="閉じる"]').all()) {
  await b.click().catch(() => {});
}
await page.waitForTimeout(1200);
// メインレシート（「今日あと使える」を含む section）の上端を少しだけ余白を残して合わせる。
// section 上は空のページ背景なので、上端の金額(¥…)がグリフ途中で切れない。
// 「今日あと使える ¥…」見出し＋金額が上部に収まり、その下に月末予測判子＋達成見込みバーが主役に来る。
await page.evaluate(() => {
  const head = Array.from(document.querySelectorAll("p, span")).find(
    (el) => el.textContent && el.textContent.replace(/\s/g, "").includes("今日あと使える"),
  );
  const target = head?.closest("section") ?? head;
  if (target) {
    const y = target.getBoundingClientRect().top + window.scrollY - 48;
    window.scrollTo(0, Math.max(0, y));
  }
});
await page.waitForTimeout(800);
await page.screenshot({ path: `${outDir}/10-home-forecast.png` });
console.log("shot: 10-home-forecast.png");

await browser.close();
console.log("DONE ->", outDir);
