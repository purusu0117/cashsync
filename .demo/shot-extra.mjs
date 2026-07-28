// 追加2枚（1290x2796）: 07-scan（レシートAI読取の確認シート）, 08-tags（横断タグ集計）
import { chromium } from "playwright";
import fs from "node:fs";

const outDir = process.argv[2];
if (!outDir) throw new Error("outDir required");
fs.mkdirSync(outDir, { recursive: true });

const BASE = "http://localhost:3013";

const browser = await chromium.launch();
const ctx = await browser.newContext({
  viewport: { width: 430, height: 932 },
  deviceScaleFactor: 3,
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
    content: "nextjs-portal{display:none!important} [data-toast],[role='status']{display:none!important}",
  });

// 07 レシートAI読取：確認シート（撮影→自動入力が伝わる）
await page.goto(`${BASE}/scan?job=1`, { waitUntil: "networkidle" });
await hideOverlays();
// 確認シートの店名が「まいばすけっと」で埋まるまで待つ（＝AIが読み取った状態）
await page.waitForFunction(() => {
  const el = document.querySelector('input[placeholder="店名"]');
  return el && el.value && el.value.includes("まいばすけっと");
}, { timeout: 15000 });
await page.waitForTimeout(1500);
await page.evaluate(() => window.scrollTo(0, 0));
await page.screenshot({ path: `${outDir}/07-scan.png` });
console.log("shot: 07-scan.png");

// 08 横断タグ集計：statsのタグ別セクションを上部に寄せる
await page.goto(`${BASE}/stats`, { waitUntil: "networkidle" });
await hideOverlays();
await page.waitForTimeout(2500); // グラフ・タグ集計の描画待ち
await page.evaluate(() => {
  const heads = Array.from(document.querySelectorAll("h2"));
  const tagH = heads.find((h) => h.textContent && h.textContent.includes("タグ別の支出"));
  if (tagH) {
    const sec = tagH.closest("section") || tagH;
    const y = sec.getBoundingClientRect().top + window.scrollY - 24;
    window.scrollTo(0, y);
  }
});
await page.waitForTimeout(1200);
await page.screenshot({ path: `${outDir}/08-tags.png` });
console.log("shot: 08-tags.png");

await browser.close();
console.log("EXTRA SHOTS DONE ->", outDir);
