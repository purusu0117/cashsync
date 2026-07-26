// 主要画面を 390x844 でスクショ。使い方: node .demo/shot.mjs <outDir>
import { chromium } from "playwright";
import fs from "node:fs";

const outDir = process.argv[2];
if (!outDir) throw new Error("outDir required");
fs.mkdirSync(outDir, { recursive: true });

const BASE = "http://localhost:3012";
const PAGES = [
  ["home", "/"],
  ["calendar", "/calendar"],
  ["history", "/history"],
  ["shifts", "/shifts"],
  ["stats", "/stats"],
  ["settings", "/settings"],
];

const browser = await chromium.launch();
const ctx = await browser.newContext({
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 2,
  isMobile: true,
  hasTouch: true,
  locale: "ja-JP",
  timezoneId: "Asia/Tokyo",
});

// ログイン（クッキーがコンテキストに入る）
const res = await ctx.request.post(`${BASE}/api/auth`, {
  data: { action: "login", email: "demo@cashsync.app", password: "demo1234" },
});
if (!(await res.json()).ok) throw new Error("login failed");

const page = await ctx.newPage();
for (const [name, path] of PAGES) {
  await page.goto(`${BASE}${path}`, { waitUntil: "networkidle" });
  await page.addStyleTag({ content: "nextjs-portal{display:none!important}" });
  await page.waitForTimeout(1800); // フォント・キャッシュファースト差し替え・グラフ描画待ち
  await page.screenshot({ path: `${outDir}/${name}.png` });
  console.log("shot:", name);
}
await browser.close();
