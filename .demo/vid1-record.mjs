// CashSync 縦型ショート動画 パイロット01：「レシート撮る→3秒で家計簿に記録」実UI画面録画。
// - Playweight recordVideo で 1080x1920 の webm を書き出す（実UIの操作を自動再生）。
// - テロップは page 内に HTMLオーバーレイを差し込んで一緒に録る（ffmpeg不要）。
// - AI読み取りだけスタブ（有料AIを偽画像で呼ばない）。UIピクセルは実物、保存は実DBに書く。
// - 本名は一切使わない（表示名タロー）。
// 使い方: CASHSYNC_BASE=http://localhost:3017 VID_DIR=<scratch> node .demo/vid1-record.mjs
import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";

const BASE = process.env.CASHSYNC_BASE || "http://localhost:3017";
const VID_DIR = process.env.VID_DIR || "./_vid";
const OUT = "C:/Users/daito/projects/cashsync-design/marketing/video";
fs.mkdirSync(OUT, { recursive: true });
fs.mkdirSync(VID_DIR, { recursive: true });

// プレビュー用ダミー画像（1x1 PNG。scanFileがcreateObjectURLするだけで中身は使わない）
const PNG1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);
const tmpImg = path.join(VID_DIR, "_dummy.png");
fs.writeFileSync(tmpImg, PNG1);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await chromium.launch();
const ctx = await browser.newContext({
  viewport: { width: 432, height: 768 }, // 9:16。dsf2.5 で 1080x1920 相当
  deviceScaleFactor: 2.5,
  isMobile: true,
  hasTouch: true,
  locale: "ja-JP",
  timezoneId: "Asia/Tokyo",
  recordVideo: { dir: VID_DIR, size: { width: 1080, height: 1920 } },
});

// ログイン（context.request のCookieはページに共有される）
const login = await ctx.request.post(`${BASE}/api/auth`, {
  data: { action: "login", email: "demo@cashsync.app", password: "demo1234" },
});
if (!(await login.json()).ok) throw new Error("login failed");

// 食費カテゴリID（スキャン結果に載せて「カテゴリも自動」を成立させる）
const catsRes = await ctx.request.get(`${BASE}/api/categories`);
const cats = (await catsRes.json()).categories ?? [];
const foodCatId = cats.find((c) => c.name === "食費")?.id ?? null;

// スキャン結果（まいばすけっと ¥1,580）をモックで返す＝有料AIを偽画像で呼ばない。保存は実DB。
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
      { name: "サラダチキン", price: 198 },
      { name: "トマト", price: 157 },
    ],
  },
  imageHash: "demo-vid1",
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
  // 一覧（ホームのpendingScans）は空＝案内カードを出さない
  return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ jobs: [] }) });
});
// 保存API（/api/receipts）はモックしない＝実DBに書いてホームへ反映させる

const page = await ctx.newPage();

// ---- テロップ／演出オーバーレイ（page内に差し込んで一緒に録る） ----
const OVERLAY_CSS = `
  #vt-root{position:fixed;inset:0;z-index:2147483647;pointer-events:none;
    font-family:"BIZ UDPGothic","Noto Sans JP","Yu Gothic UI","Meiryo",sans-serif;}
  #vt-root *{box-sizing:border-box;margin:0;}
  .vt-fade{transition:opacity .35s ease;}
  /* フック（全画面・冒頭1秒で結論） */
  .vt-hook{position:absolute;inset:0;display:flex;flex-direction:column;
    align-items:center;justify-content:center;text-align:center;padding:0 8%;
    background:linear-gradient(180deg,rgba(12,13,15,.42),rgba(12,13,15,.66));}
  .vt-hook .big{font-weight:900;font-size:44px;line-height:1.32;color:#F4F1E9;
    letter-spacing:.01em;text-shadow:0 4px 22px rgba(0,0,0,.6);}
  .vt-hook .big .em{color:#F05238;}
  .vt-hook .sub{margin-top:16px;font-weight:800;font-size:19px;color:rgba(244,241,233,.9);
    letter-spacing:.04em;text-shadow:0 2px 12px rgba(0,0,0,.6);}
  /* ローワーサード テロップ（下1/3・安全マージン） */
  .vt-lower{position:absolute;left:0;right:0;bottom:13%;padding:0 7%;text-align:center;}
  .vt-lower .card{display:inline-block;padding:14px 22px;border-radius:16px;
    background:rgba(12,13,15,.72);box-shadow:0 8px 30px rgba(0,0,0,.4);
    backdrop-filter:blur(2px);}
  .vt-lower .t1{font-weight:900;font-size:29px;line-height:1.35;color:#F4F1E9;
    letter-spacing:.01em;}
  .vt-lower .t1 .em{color:#57C083;}
  .vt-lower .t1 .verm{color:#FF6A4D;}
  .vt-lower .t2{margin-top:6px;font-weight:800;font-size:17px;color:rgba(244,241,233,.86);}
  /* 締めカード */
  .vt-end{position:absolute;inset:0;display:flex;flex-direction:column;
    align-items:center;justify-content:center;text-align:center;padding:0 8%;
    background:linear-gradient(180deg,rgba(12,13,15,.9),rgba(20,16,14,.95));}
  .vt-end .logo{font-weight:900;font-size:58px;letter-spacing:.06em;color:#F4F1E9;
    text-shadow:0 4px 24px rgba(0,0,0,.6);}
  .vt-end .logo .em{color:#F05238;}
  .vt-end .tag{margin-top:14px;font-weight:800;font-size:24px;color:#57C083;letter-spacing:.03em;}
  .vt-end .beta{margin-top:34px;font-weight:800;font-size:20px;color:#F4F1E9;
    padding:12px 26px;border:2px solid rgba(244,241,233,.5);border-radius:999px;}
  .vt-end .beta .s{color:rgba(244,241,233,.7);font-size:16px;}
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
  await page.evaluate((h) => {
    document.getElementById("vt-root").innerHTML = h;
  }, html);
}
async function clearOverlay() {
  await page.evaluate(() => {
    const r = document.getElementById("vt-root");
    if (r) r.innerHTML = "";
  }).catch(() => {});
}
async function hideChrome() {
  // Next devのエラーポータル・トーストは録らない（トーストは意図した時だけ出す）
  await page.addStyleTag({
    content: "nextjs-portal{display:none!important}",
  }).catch(() => {});
}

const frame = async (name) =>
  page.screenshot({ path: path.join(OUT, name) }).catch(() => {});

// ============ シーン1：フック（0-1.8s）============
await page.goto(`${BASE}/`, { waitUntil: "networkidle" });
await hideChrome();
await sleep(500); // ホーム描画
await setOverlay(`
  <div class="vt-hook">
    <div class="big">家計簿、<span class="em">3秒</span>で<br>終わらせる。</div>
    <div class="sub">レシートを撮るだけ</div>
  </div>`);
await sleep(400);
await frame("frame-1-hook.png"); // 検証＆サムネ用
await sleep(900);
await clearOverlay();

// ============ シーン2：撮る→自動入力（1.8-8s）============
await page.goto(`${BASE}/scan`, { waitUntil: "networkidle" });
await hideChrome();
await sleep(600);
await setOverlay(`
  <div class="vt-lower">
    <div class="card"><div class="t1">レシートやスクショを、<span class="verm">撮るだけ</span></div></div>
  </div>`);
await sleep(600);

// 「レシートを撮影」経路＝capture付きinputにファイルを流す（fromLibrary=false）
const camInput = page.locator('input[type="file"][capture]');
await camInput.setInputFiles(tmpImg);

// 解析中スピナーを見せる（pollは最短2秒）
await page.waitForFunction(() => /解析中/.test(document.body.textContent || ""), { timeout: 8000 }).catch(() => {});
await sleep(300);
await setOverlay(`
  <div class="vt-lower">
    <div class="card"><div class="t1"><span class="em">AI</span>が読み取り中…</div>
      <div class="t2">店名・金額・カテゴリ・品目まで</div></div>
  </div>`);
await sleep(900);

// 確認シート（記録ボタン）が出るまで待つ＝自動入力完了
await page.waitForFunction(() => {
  const btns = Array.from(document.querySelectorAll("button"));
  return btns.some((b) => /を記録$/.test((b.textContent || "").trim()) || /を記録/.test(b.textContent || ""));
}, { timeout: 20000 });
await page.evaluate(() => window.scrollTo({ top: 0 }));
await sleep(300);
await frame("frame-2-confirm.png"); // 検証用（自動入力された確認シート・テロップ無し）
await setOverlay(`
  <div class="vt-lower">
    <div class="card"><div class="t1">店名・金額・カテゴリ・品目まで<br><span class="em">ぜんぶ自動入力</span></div></div>
  </div>`);
await sleep(500);
// 確認シートを少しスクロールして品目まで見せる
await page.evaluate(() => window.scrollBy({ top: 220, behavior: "smooth" }));
await sleep(800);
await page.evaluate(() => window.scrollTo({ top: 0, behavior: "smooth" }));
await sleep(400);
await clearOverlay();

// ============ シーン3：記録完了→ホーム反映（8-12s）============
await page.evaluate(() => {
  const b = Array.from(document.querySelectorAll("button")).find((x) => /を記録/.test(x.textContent || ""));
  b?.click();
});
// camera経路は保存後 /?saved=1580 へ遷移し「記録しました ¥1,580」トースト＋反映
await page.waitForURL(/\/(\?saved=|$)/, { timeout: 15000 }).catch(() => {});
await page.waitForLoadState("networkidle").catch(() => {});
await hideChrome();
await sleep(700); // トースト＆数字反映
await frame("frame-3-reflect.png"); // 検証用（ホーム反映＋トースト・テロップ無し）
await setOverlay(`
  <div class="vt-lower">
    <div class="card"><div class="t1">金額もカテゴリも、自動。<br><span class="verm">入力3秒。</span></div></div>
  </div>`);
await sleep(1200);
await clearOverlay();

// ============ シーン4：締め（月末予測 黒字→ロゴ）（12-16s）============
// ホームの「月末までの予測」＋黒字判子までスクロールして見せる
await page.evaluate(() => {
  const els = Array.from(document.querySelectorAll("span,div"));
  const t = els.find((e) => (e.textContent || "").trim() === "月末までの予測");
  if (t) {
    const y = t.getBoundingClientRect().top + window.scrollY - 220;
    window.scrollTo({ top: Math.max(0, y), behavior: "smooth" });
  }
}).catch(() => {});
await sleep(600);
await setOverlay(`
  <div class="vt-lower">
    <div class="card"><div class="t1">このペースで月末は<span class="em">黒字</span>。</div>
      <div class="t2">使う前に、先読み</div></div>
  </div>`);
await sleep(1200);
await clearOverlay();
// 締めロゴカード
await setOverlay(`
  <div class="vt-end">
    <div class="logo">Cash<span class="em">Sync</span></div>
    <div class="tag">入力3秒の家計簿</div>
    <div class="beta">App Storeで近日公開<br><span class="s">TestFlightベータ中</span></div>
  </div>`);
await sleep(400);
await frame("frame-4-end.png"); // 検証用（締めカード）
await sleep(1500);

// ---- 書き出し ----
const video = page.video();
await page.close();
await ctx.close();
const raw = await video.path();
const dest = path.join(OUT, "pilot-01.webm");
fs.copyFileSync(raw, dest);
console.log("VIDEO(webm):", dest);
console.log("RAW:", raw);
await browser.close();
fs.rmSync(tmpImg, { force: true });
console.log("RECORD DONE");
