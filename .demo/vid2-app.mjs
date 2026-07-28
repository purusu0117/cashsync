// CashSync pilot-02 シーン3：実アプリUI録画（スクショ→AI読取→3秒で記録→元スクショ不要）
// - ライブラリ経路（fromLibrary=true）で「スクショから読み取る」→確認シート→記録→doneカード。
// - スキャンはスタブ（有料AI不使用・偽画像）。保存は実DB（ローカルSQLite）。実UIピクセル。
// - 実在ブランドなし：店名は generic「サンプルストア（QR決済）」。本名なし（表示名タロー）。
// 使い方: CASHSYNC_BASE=http://localhost:3018 VID_DIR=<scratch> node .demo/vid2-app.mjs
import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";

const BASE = process.env.CASHSYNC_BASE || "http://localhost:3018";
const SCRATCH =
  "C:/Users/daito/AppData/Local/Temp/claude/C--Users-daito/9b09d89d-2861-49f9-9e0b-1bb3dec7fc90/scratchpad";
const CLIPS = `${SCRATCH}/vid2/clips`;
const FRAMES = `${SCRATCH}/vid2/frames`;
const VID_DIR = `${CLIPS}/_rec_s3`;
fs.rmSync(VID_DIR, { recursive: true, force: true });
fs.mkdirSync(VID_DIR, { recursive: true });
fs.mkdirSync(FRAMES, { recursive: true });

const PNG1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);
const tmpImg = path.join(VID_DIR, "_dummy.png");
fs.writeFileSync(tmpImg, PNG1);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await chromium.launch();
const ctx = await browser.newContext({
  viewport: { width: 432, height: 768 },
  deviceScaleFactor: 2.5,
  isMobile: true,
  hasTouch: true,
  locale: "ja-JP",
  timezoneId: "Asia/Tokyo",
  recordVideo: { dir: VID_DIR, size: { width: 1080, height: 1920 } },
});

const login = await ctx.request.post(`${BASE}/api/auth`, {
  data: { action: "login", email: "demo@cashsync.app", password: "demo1234" },
});
if (!(await login.json()).ok) throw new Error("login failed");

const catsRes = await ctx.request.get(`${BASE}/api/categories`);
const cats = (await catsRes.json()).categories ?? [];
const foodCatId = cats.find((c) => c.name === "食費")?.id ?? null;

// スキャン結果（generic・QR決済スクショ）。実在ブランドなし。
const scanResult = {
  status: "done",
  scan: {
    kind: "expense",
    store: "サンプルストア（QR決済）",
    date: "2026-07-28",
    total: 1580,
    category: "食費",
    items: [],
  },
  imageHash: "demo-vid2",
  categoryId: foodCatId,
  learned: false,
};
await ctx.route("**/api/scan-jobs**", (route) => {
  const req = route.request();
  const method = req.method();
  if (method === "POST")
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ jobId: "demo" }) });
  if (method === "DELETE")
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true }) });
  const url = req.url();
  if (url.includes("id="))
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(scanResult) });
  return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ jobs: [] }) });
});

const page = await ctx.newPage();

const OVERLAY_CSS = `
  #vt-root{position:fixed;inset:0;z-index:2147483647;pointer-events:none;
    font-family:"BIZ UDPGothic","Noto Sans JP","Yu Gothic UI","Meiryo",sans-serif;}
  #vt-root *{box-sizing:border-box;margin:0;}
  .vt-lower{position:absolute;left:0;right:0;bottom:12%;padding:0 7%;text-align:center;}
  .vt-lower .card{display:inline-block;padding:16px 26px;border-radius:18px;
    background:rgba(14,15,17,.8);box-shadow:0 10px 34px rgba(0,0,0,.42);}
  .vt-lower .t1{font-weight:900;font-size:30px;line-height:1.36;color:#F4F1E9;letter-spacing:.01em;}
  .vt-lower .t1 .em{color:#6BD69B;} .vt-lower .t1 .verm{color:#FF6A4D;}
  .vt-lower .t2{margin-top:5px;font-weight:800;font-size:17px;color:rgba(244,241,233,.85);}
`;
async function ensureRoot() {
  await page.addStyleTag({ content: OVERLAY_CSS }).catch(() => {});
  await page.evaluate(() => {
    if (!document.getElementById("vt-root")) {
      const r = document.createElement("div");
      r.id = "vt-root";
      document.documentElement.appendChild(r);
    }
  });
}
async function setOverlay(html) {
  await ensureRoot();
  await page.evaluate((h) => { document.getElementById("vt-root").innerHTML = h; }, html);
}
async function clearOverlay() {
  await page.evaluate(() => { const r = document.getElementById("vt-root"); if (r) r.innerHTML = ""; }).catch(() => {});
}
async function hideChrome() {
  await page.addStyleTag({ content: "nextjs-portal{display:none!important}" }).catch(() => {});
}
const frame = (name) => page.screenshot({ path: path.join(FRAMES, name) }).catch(() => {});

// ---- /scan を開いてライブラリ経路で読み取り ----
await page.goto(`${BASE}/scan`, { waitUntil: "networkidle" });
await hideChrome();
await sleep(500);
await setOverlay(`<div class="vt-lower"><div class="card"><div class="t1">支払いのスクショを、<span class="verm">アプリで読む</span></div></div></div>`);
await sleep(500);

// 「スクショ・画像から読み取る」= capture無しの file input（fromLibrary=true）
const libInput = page.locator('input[type="file"]:not([capture])');
await libInput.setInputFiles(tmpImg);

// 解析中（スクショをAIが読む）
await page.waitForFunction(() => /解析中/.test(document.body.textContent || ""), { timeout: 8000 }).catch(() => {});
await sleep(250);
await setOverlay(`<div class="vt-lower"><div class="card"><div class="t1"><span class="em">AI</span>がスクショを読み取り中…</div></div></div>`);
await sleep(900);

// 確認シート（自動入力完了）
await page.waitForFunction(() => {
  const btns = Array.from(document.querySelectorAll("button"));
  return btns.some((b) => /を記録/.test(b.textContent || ""));
}, { timeout: 20000 });
await page.evaluate(() => window.scrollTo({ top: 0 }));
await sleep(250);
await frame("s3-confirm.png");
await setOverlay(`<div class="vt-lower"><div class="card"><div class="t1">店名・金額・カテゴリを、<br><span class="em">自動入力</span></div></div></div>`);
await sleep(1100);
await clearOverlay();

// 記録（実DB保存）→ fromLibrary は done カードへ
await page.evaluate(() => {
  const b = Array.from(document.querySelectorAll("button")).find((x) => /を記録/.test(x.textContent || ""));
  b?.click();
});
await page.waitForFunction(() => /記録しました/.test(document.body.textContent || ""), { timeout: 15000 }).catch(() => {});
await hideChrome();
// ブラウザ制限の注意文（ネイティブ以外で出る）は動画では隠す＝ポジティブ面だけ見せる
await page.evaluate(() => {
  document.querySelectorAll("p").forEach((p) => {
    const t = p.textContent || "";
    if (/ブラウザの制限|削除できない|写真アプリから削除/.test(t)) p.style.display = "none";
  });
});
await sleep(400);
await frame("s3-done.png");
await setOverlay(`<div class="vt-lower"><div class="card"><div class="t1">たった<span class="verm">3秒</span>で記録完了</div>
  <div class="t2">読み取った内容はアプリに保存ずみ</div></div></div>`);
await sleep(1500);

const video = page.video();
await page.close();
await ctx.close();
const raw = await video.path();
const dest = path.join(CLIPS, "s3.webm");
fs.copyFileSync(raw, dest);
await browser.close();
fs.rmSync(VID_DIR, { recursive: true, force: true });
console.log("REC s3 ->", dest);
