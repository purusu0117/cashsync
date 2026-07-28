// スクショ読み取り→保存後の done 画面（ネイティブ版：ワンタップ削除ボタン付き）を実キャプチャ。
// ・window.Capacitor を注入して native=true（App Store版=iOSネイティブの実UI）
// ・AIスキャンAPIと保存APIだけをモック（本物のAIは呼ばない）。done画面のピクセルは実物そのまま。
// 使い方: node .demo/shot-done.mjs <outDir>
import { chromium } from "playwright";
import fs from "node:fs";

const outDir = process.argv[2];
if (!outDir) throw new Error("outDir required");
fs.mkdirSync(outDir, { recursive: true });

const BASE = "http://localhost:3014";

// 1x1 PNG（プレビュー用のダミー画像。scanFileがcreateObjectURLするだけ）
const PNG1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);
const tmpImg = `${outDir}/_dummy.png`;
fs.writeFileSync(tmpImg, PNG1);

const browser = await chromium.launch();
const ctx = await browser.newContext({
  viewport: { width: 430, height: 932 },
  deviceScaleFactor: 3, // → 1290x2796
  isMobile: true,
  hasTouch: true,
  locale: "ja-JP",
  timezoneId: "Asia/Tokyo",
});

// ネイティブ判定を true にする（App Store版=iOSネイティブの実挙動を表示）
await ctx.addInitScript(() => {
  window.Capacitor = {
    isNativePlatform: () => true,
    getPlatform: () => "ios",
    Plugins: {},
  };
});

const login = await ctx.request.post(`${BASE}/api/auth`, {
  data: { action: "login", email: "demo@cashsync.app", password: "demo1234" },
});
if (!(await login.json()).ok) throw new Error("login failed");

const page = await ctx.newPage();

// スキャン結果（まいばすけっと）をモックで返す＝本物のAIを呼ばない
const scanResult = {
  status: "done",
  scan: {
    kind: "expense",
    store: "まいばすけっと 相模原店",
    date: "2026-07-28",
    total: 1580,
    category: "食費",
    items: [
      { name: "牛乳", price: 238 },
      { name: "たまご 10個", price: 268 },
      { name: "食パン", price: 158 },
    ],
  },
  imageHash: "demo",
  categoryId: null,
  learned: false,
};
await page.route("**/api/scan-jobs**", (route) => {
  const req = route.request();
  if (req.method() === "POST") {
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ jobId: "demo" }) });
  }
  if (req.method() === "DELETE") {
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true }) });
  }
  // GET（ジョブ状況ポーリング or 一覧）
  const url = req.url();
  if (url.includes("id=")) {
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(scanResult) });
  }
  return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ jobs: [] }) });
});
// 保存API（本物のUIから呼ばれるが、DBに書かず ok を返す）
await page.route("**/api/receipts", (route) =>
  route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, id: "demo" }) }),
);

await page.goto(`${BASE}/scan`, { waitUntil: "networkidle" });
// ネイティブのセーフエリア余白と各種オーバーレイを無効化（クリーンな1枚に）
await page.addStyleTag({
  content:
    "body.native-app{padding-top:0!important} body.native-banner{padding-top:0!important} nextjs-portal{display:none!important} [data-toast],[role='status']{display:none!important}",
});
await page.waitForTimeout(600);

// 「スクショ・画像から読み取る」経路＝ライブラリ入力にファイルを流す（fromLibrary=true）
const libInput = page.locator('input[type="file"]:not([capture])');
await libInput.setInputFiles(tmpImg);

// scanning → poll(2s) → confirm。確認シートの「記録」ボタンを待って押す
await page.waitForFunction(() => {
  const btns = Array.from(document.querySelectorAll("button"));
  return btns.some((b) => /を記録/.test(b.textContent || ""));
}, { timeout: 20000 });
await page.waitForTimeout(400);
await page.evaluate(() => {
  const b = Array.from(document.querySelectorAll("button")).find((x) => /を記録/.test(x.textContent || ""));
  b?.click();
});

// done 画面（「元のスクショはもう不要です」＋端末から削除ボタン）が出るまで待つ
await page.waitForFunction(() => /元のスクショはもう不要です/.test(document.body.textContent || ""), {
  timeout: 15000,
});
await page.waitForFunction(() => {
  const btns = Array.from(document.querySelectorAll("button"));
  return btns.some((b) => /端末からこのスクショを削除/.test(b.textContent || ""));
}, { timeout: 5000 });
await page.waitForTimeout(600);
await page.evaluate(() => window.scrollTo(0, 0));
await page.screenshot({ path: `${outDir}/09-scan-done.png` });
console.log("shot: 09-scan-done.png (native done screen)");

fs.rmSync(tmpImg, { force: true });
await browser.close();
console.log("DONE ->", outDir);
