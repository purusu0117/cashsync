// CashSync pilot-02 モックUIシーン録画（S1 フック / S2 スクショ / S4 削除 / S5 締め）
// - 実在ブランドは一切出さない（すべて generic 自作モック）。本名なし。
// - 各シーンを 1080x1920 webm で individually 録画（テロップ焼き込み）。
// 使い方: node .demo/vid2-mock.mjs
import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const SCRATCH =
  "C:/Users/daito/AppData/Local/Temp/claude/C--Users-daito/9b09d89d-2861-49f9-9e0b-1bb3dec7fc90/scratchpad";
const CLIPS = `${SCRATCH}/vid2/clips`;
const FRAMES = `${SCRATCH}/vid2/frames`;
const SYNC = pathToFileURL(`${SCRATCH}/vid2/sync-mark-alpha.png`).href;
fs.mkdirSync(CLIPS, { recursive: true });
fs.mkdirSync(FRAMES, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- 共通スタイル（写真アプリ風 / テロップ） ----------
const BASE_CSS = `
  *{margin:0;padding:0;box-sizing:border-box;}
  :root{--paper:#F4F1E9;--ink:#16130F;--verm:#F05238;--vermD:#c23a24;--sage:#3FA46A;--navy:#0c1c29;}
  html,body{width:1080px;height:1920px;overflow:hidden;
    font-family:"BIZ UDPGothic","Noto Sans JP","Yu Gothic UI","Meiryo",sans-serif;}
  .screen{position:absolute;inset:0;}
  /* iOS風ステータスバー */
  .statusbar{position:absolute;top:0;left:0;right:0;height:78px;display:flex;
    align-items:center;justify-content:space-between;padding:0 54px;z-index:20;
    font-weight:800;font-size:34px;letter-spacing:.02em;}
  .statusbar .r{display:flex;align-items:center;gap:14px;}
  .bat{width:56px;height:28px;border:3px solid currentColor;border-radius:7px;position:relative;opacity:.9;}
  .bat::after{content:"";position:absolute;left:3px;top:3px;bottom:3px;width:34px;background:currentColor;border-radius:2px;}
  .bat::before{content:"";position:absolute;right:-8px;top:8px;width:5px;height:12px;background:currentColor;border-radius:2px;}
  .wifi,.sig{font-size:30px;}
  /* テロップ（ローワーサード） */
  .lower{position:absolute;left:0;right:0;bottom:12%;padding:0 8%;text-align:center;z-index:40;
    opacity:0;transform:translateY(24px);transition:opacity .4s ease,transform .4s ease;}
  .lower.show{opacity:1;transform:translateY(0);}
  .lower .card{display:inline-block;padding:26px 40px;border-radius:26px;
    background:rgba(14,15,17,.82);box-shadow:0 16px 50px rgba(0,0,0,.45);}
  .lower .t1{font-weight:900;font-size:56px;line-height:1.34;color:var(--paper);letter-spacing:.01em;}
  .lower .t1 .verm{color:#FF6A4D;} .lower .t1 .sage{color:#6BD69B;}
  .lower .t2{margin-top:10px;font-weight:800;font-size:32px;color:rgba(244,241,233,.85);}
  /* 大フック */
  .hook{position:absolute;left:0;right:0;top:9%;padding:0 7%;text-align:center;z-index:40;
    opacity:0;transform:translateY(26px);transition:opacity .5s ease,transform .5s ease;}
  .hook.show{opacity:1;transform:translateY(0);}
  .hook .big{font-weight:900;font-size:76px;line-height:1.28;color:var(--ink);
    text-shadow:0 2px 0 rgba(255,255,255,.5);letter-spacing:.005em;}
  .hook .big .verm{color:var(--verm);}
  .hook .sub{margin-top:18px;font-weight:800;font-size:38px;color:#5b524a;}
`;

// ---------- モック・サムネイル（generic。ブランド無し） ----------
function tile(type, i, amt) {
  const g = Math.floor(i / 4); // 同種タイルの金額を散らす（mod4衝突回避）
  if (type === "recp")
    return `<div class="thumb recp"><div class="rc-h"></div>
      ${Array.from({ length: 5 }).map(() => `<div class="rc-row"><span></span><b></b></div>`).join("")}
      <div class="rc-tot"><span>合計</span><b>¥${amt ?? [980, 1240, 2180, 640][g % 4]}</b></div></div>`;
  if (type === "qr")
    return `<div class="thumb qr"><div class="qr-top">QRコード決済</div>
      <div class="qr-code">${Array.from({ length: 36 }).map((_, k) => `<i class="${(i * 7 + k * 3) % 5 < 2 ? "on" : ""}"></i>`).join("")}</div>
      <div class="qr-amt">¥${amt ?? [1580, 720, 3400, 480][g % 4]}</div><div class="qr-ok">お支払い完了</div></div>`;
  if (type === "order")
    return `<div class="thumb order"><div class="od-h">ご注文ありがとうございました</div>
      <div class="od-row"><i></i><span></span></div><div class="od-row"><i></i><span></span></div>
      <div class="od-tot">お支払い ¥${amt ?? [2980, 1650, 5400][g % 3]}</div></div>`;
  // 通常写真（散らかりの中の「本物の写真」＝削除で残る側）
  const grads = [
    "linear-gradient(135deg,#7fb2d9,#cfe3ef)",
    "linear-gradient(135deg,#e5b98a,#f3ddc2)",
    "linear-gradient(135deg,#8fbf9f,#d5ead9)",
    "linear-gradient(135deg,#c99fb3,#eddbe4)",
  ];
  return `<div class="thumb photo" style="background:${grads[i % 4]}"><div class="ph-sun"></div></div>`;
}

const THUMB_CSS = `
  .grid{position:absolute;left:36px;right:36px;top:250px;display:grid;grid-template-columns:repeat(3,1fr);gap:20px;}
  .cell{position:relative;transition:transform .5s cubic-bezier(.2,.7,.3,1),opacity .5s ease;}
  .cell.gone{transform:scale(.2);opacity:0;}
  .thumb{position:relative;width:100%;aspect-ratio:1/1.15;border-radius:20px;overflow:hidden;
    box-shadow:0 6px 18px rgba(20,19,15,.14);background:#fff;padding:20px;}
  .recp{background:#fdfdfb;} .recp .rc-h{height:16px;width:60%;background:#d9d4c7;border-radius:4px;margin-bottom:16px;}
  .recp .rc-row{display:flex;justify-content:space-between;margin:11px 0;}
  .recp .rc-row span{width:52%;height:11px;background:#e6e1d5;border-radius:3px;}
  .recp .rc-row b{width:22%;height:11px;background:#e6e1d5;border-radius:3px;}
  .recp .rc-tot{display:flex;justify-content:space-between;align-items:baseline;margin-top:18px;border-top:2px dashed #cfc9bb;padding-top:12px;}
  .recp .rc-tot span{font-size:20px;color:#8a8377;font-weight:700;} .recp .rc-tot b{font-size:30px;color:#2a2620;}
  .qr{background:linear-gradient(160deg,#2b6f83,#1b4b5e);color:#eafcff;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:12px;}
  .qr-top{font-size:20px;font-weight:800;opacity:.9;}
  .qr-code{display:grid;grid-template-columns:repeat(6,1fr);gap:3px;width:120px;height:120px;background:#eafcff;padding:8px;border-radius:8px;}
  .qr-code i{background:transparent;border-radius:1px;} .qr-code i.on{background:#0d2b34;}
  .qr-amt{font-size:40px;font-weight:900;} .qr-ok{font-size:19px;font-weight:700;opacity:.85;}
  .order{background:#fffdf8;display:flex;flex-direction:column;}
  .order .od-h{font-size:19px;font-weight:800;color:#3a352c;line-height:1.3;margin-bottom:16px;}
  .order .od-row{display:flex;align-items:center;gap:12px;margin:9px 0;}
  .order .od-row i{width:44px;height:44px;border-radius:8px;background:#eee7d6;flex:none;}
  .order .od-row span{height:12px;flex:1;background:#eee7d6;border-radius:3px;}
  .order .od-tot{margin-top:auto;font-size:26px;font-weight:900;color:#c23a24;}
  .photo{padding:0;} .ph-sun{position:absolute;top:22px;right:26px;width:60px;height:60px;border-radius:50%;background:rgba(255,255,255,.7);box-shadow:0 0 40px rgba(255,255,255,.6);}
  .badge{position:absolute;top:-12px;right:-12px;background:var(--verm);color:#fff;font-weight:900;font-size:26px;
    padding:4px 16px;border-radius:999px;box-shadow:0 6px 16px rgba(240,82,56,.5);z-index:5;
    opacity:0;transform:scale(.4);transition:opacity .3s,transform .35s cubic-bezier(.2,1.5,.4,1);}
  .badge.show{opacity:1;transform:scale(1);}
  .ring{position:absolute;inset:-6px;border:6px solid var(--verm);border-radius:24px;opacity:0;transition:opacity .25s;z-index:6;}
  .ring.show{opacity:1;}
  .trash{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%) scale(.4);z-index:8;
    width:96px;height:96px;border-radius:50%;background:var(--verm);display:flex;align-items:center;justify-content:center;
    opacity:0;transition:opacity .25s,transform .3s cubic-bezier(.2,1.5,.4,1);box-shadow:0 10px 30px rgba(240,82,56,.5);}
  .trash.show{opacity:1;transform:translate(-50%,-50%) scale(1);}
  .trash svg{width:52px;height:52px;stroke:#fff;fill:none;stroke-width:2.4;}
`;

function photosHeader(sub) {
  return `<div class="phead"><div class="pt">写真</div><div class="ps">${sub}</div></div>`;
}
const HEADER_CSS = `
  .phead{position:absolute;top:96px;left:44px;right:44px;}
  .phead .pt{font-size:64px;font-weight:900;color:#16130F;letter-spacing:.01em;}
  .phead .ps{margin-top:6px;font-size:30px;font-weight:800;color:#8a8377;}
`;

function statusbar(dark) {
  const col = dark ? "#fff" : "#16130F";
  return `<div class="statusbar" style="color:${col}"><div>9:41</div>
    <div class="r"><span class="sig">●●●</span><span class="wifi">令</span><span class="bat"></span></div></div>`;
}

// ---------- グリッド構成（散らかり：スクショ多め＋通常写真少し） ----------
// type: qr/recp/order = スクショ（散らかり）, photo = 通常写真（残る側）
const GRID = [
  "qr", "recp", "photo", "order", "qr", "recp",
  "photo", "recp", "qr", "order", "photo", "recp",
];
function gridHtml({ firstQr = false } = {}) {
  const cells = GRID.map((t, i) => {
    const badge = firstQr && i === 0 ? `<div class="badge" id="badge">+1</div>` : "";
    const ring = i === 0 ? `<div class="ring" id="ring"></div>` : "";
    const trash = i === 0 ? `<div class="trash" id="trash"><svg viewBox="0 0 24 24"><path d="M4 7h16M9 7V5h6v2M6 7l1 13h10l1-13"/></svg></div>` : "";
    // シーン4で先頭を確実にQR(¥1,580)にする
    const type = firstQr && i === 0 ? "qr" : t;
    return `<div class="cell" data-type="${type}" data-i="${i}">${badge}${ring}${trash}${tile(type, i)}</div>`;
  }).join("");
  return `<div class="grid">${cells}</div>`;
}

function page(bodyHtml, extraCss = "") {
  return `<!doctype html><html><head><meta charset="utf-8"><style>${BASE_CSS}${THUMB_CSS}${HEADER_CSS}${extraCss}</style></head><body>${bodyHtml}</body></html>`;
}

// ================= 録画ドライバ =================
const browser = await chromium.launch();

async function record(name, htmlFile, drive, recSize = { width: 1080, height: 1920 }) {
  const dir = `${CLIPS}/_rec_${name}`;
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const ctx = await browser.newContext({
    viewport: { width: 1080, height: 1920 },
    deviceScaleFactor: 1,
    recordVideo: { dir, size: recSize },
    locale: "ja-JP",
  });
  const p = await ctx.newPage();
  await p.goto(pathToFileURL(htmlFile).href, { waitUntil: "load" });
  await p.evaluate(() => document.fonts.ready);
  await sleep(250);
  await drive(p, name);
  const vid = p.video();
  await p.close();
  await ctx.close();
  const raw = await vid.path();
  const dest = `${CLIPS}/${name}.webm`;
  fs.copyFileSync(raw, dest);
  fs.rmSync(dir, { recursive: true, force: true });
  console.log("REC", name, "->", dest);
}

const setClass = (p, sel, cls, on = true) =>
  p.evaluate(({ sel, cls, on }) => {
    const el = document.querySelector(sel);
    if (el) el.classList[on ? "add" : "remove"](cls);
  }, { sel, cls, on });
const shot = (p, name) => p.screenshot({ path: `${FRAMES}/${name}.png` });

// ---- S1 フック：散らかった写真アプリ ----
{
  const veilCss = `
    .veil{position:absolute;inset:0;z-index:30;pointer-events:none;opacity:0;transition:opacity .5s ease;
      background:linear-gradient(180deg,rgba(244,241,233,.86) 0%,rgba(244,241,233,.62) 46%,rgba(244,241,233,.34) 72%,rgba(244,241,233,.14) 100%);}
    .veil.show{opacity:1;}
    .hook{top:16%;} .hook .big{font-size:82px;} .hook .sub{font-size:40px;color:#7a4a3f;}`;
  const html = page(`<div class="screen" style="background:var(--paper)">
    ${statusbar(false)}${photosHeader("スクリーンショットでいっぱい")}${gridHtml()}
    <div class="veil" id="veil"></div>
    <div class="hook" id="hook"><div class="big">レシートも、QR決済も。<br><span class="verm">記録が地味に面倒。</span></div>
      <div class="sub">スクショだけ溜まっていく…</div></div>
  </div>`, veilCss);
  const f = `${CLIPS}/s1.html`;
  fs.writeFileSync(f, html);
  await record("s1", f, async (p, name) => {
    // グリッドを軽く staggered fade-in
    await p.evaluate(() => {
      document.querySelectorAll(".cell").forEach((c, i) => {
        c.style.opacity = "0"; c.style.transform = "translateY(30px) scale(.96)";
        setTimeout(() => { c.style.transition = "opacity .45s ease,transform .5s cubic-bezier(.2,.7,.3,1)"; c.style.opacity = "1"; c.style.transform = "none"; }, 60 + i * 55);
      });
    });
    await sleep(850);
    await setClass(p, "#veil", "show");
    await setClass(p, "#hook", "show");
    await sleep(650);
    await shot(p, "s1");
    await sleep(3300);
  });
}

// ---- S2 スクショ：QR決済画面 → シャッター → 写真に+1 ----
{
  const pay = `<div class="screen paylayer" id="pay" style="background:linear-gradient(165deg,#2b6f83,#123a49)">
    ${statusbar(true)}
    <div class="pay-wrap">
      <div class="pay-check"><svg viewBox="0 0 24 24"><path d="M5 13l4 4L19 7"/></svg></div>
      <div class="pay-title">お支払い完了</div>
      <div class="pay-amt">¥1,580</div>
      <div class="pay-store">サンプルストア</div>
      <div class="pay-meta">QRコード決済 ・ 2026/07/28 12:41</div>
      <div class="pay-code">${Array.from({ length: 64 }).map((_, k) => `<i class="${(k * 5 + 2) % 7 < 3 ? "on" : ""}"></i>`).join("")}</div>
    </div></div>`;
  const photos = `<div class="screen photolayer" id="photos" style="background:var(--paper);opacity:0">
    ${statusbar(false)}${photosHeader("たった今 1枚追加")}${gridHtml({ firstQr: true })}</div>`;
  const flash = `<div id="flash" style="position:absolute;inset:0;background:#fff;opacity:0;z-index:60;pointer-events:none"></div>`;
  const thumb = `<div id="snap" style="position:absolute;z-index:55;border-radius:18px;overflow:hidden;box-shadow:0 20px 60px rgba(0,0,0,.5);opacity:0;
    background:linear-gradient(165deg,#2b6f83,#123a49);"></div>`;
  const extra = `
    .pay-wrap{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:24px;color:#eafcff;}
    .pay-check{width:180px;height:180px;border-radius:50%;background:rgba(255,255,255,.16);display:flex;align-items:center;justify-content:center;}
    .pay-check svg{width:110px;height:110px;stroke:#eafcff;fill:none;stroke-width:2.6;stroke-linecap:round;stroke-linejoin:round;}
    .pay-title{font-size:46px;font-weight:800;opacity:.95;}
    .pay-amt{font-size:150px;font-weight:900;letter-spacing:.01em;line-height:1;}
    .pay-store{font-size:40px;font-weight:800;}
    .pay-meta{font-size:28px;font-weight:700;opacity:.8;}
    .pay-code{margin-top:26px;display:grid;grid-template-columns:repeat(8,1fr);gap:6px;width:260px;height:260px;background:#eafcff;padding:16px;border-radius:16px;}
    .pay-code i{border-radius:2px;} .pay-code i.on{background:#0d2b34;}
    .lower .t1 .verm{color:#FF6A4D;}
  `;
  const html = page(`${photos}${pay}${thumb}${flash}
    <div class="lower" id="tel"><div class="card"><div class="t1">支払い画面を<span class="verm">スクショ</span></div></div></div>`, extra);
  const f = `${CLIPS}/s2.html`;
  fs.writeFileSync(f, html);
  await record("s2", f, async (p, name) => {
    await sleep(300);
    await setClass(p, "#tel", "show");
    await sleep(300);
    await shot(p, "s2");
    await sleep(500);
    // シャッター：フラッシュ＋画面がサムネに縮小して左下へ
    await p.evaluate(() => {
      const flash = document.getElementById("flash");
      flash.style.transition = "opacity .09s ease";
      flash.style.opacity = "1";
      setTimeout(() => { flash.style.transition = "opacity .35s ease"; flash.style.opacity = "0"; }, 90);
      // snap thumbnail = full pay screen shrinking to corner
      const snap = document.getElementById("snap");
      snap.style.left = "0px"; snap.style.top = "0px"; snap.style.width = "1080px"; snap.style.height = "1920px";
      snap.style.opacity = "1"; snap.style.borderRadius = "0px";
      document.getElementById("pay").style.opacity = "0";
      requestAnimationFrame(() => {
        snap.style.transition = "all .55s cubic-bezier(.4,.1,.2,1)";
        snap.style.left = "46px"; snap.style.top = "1560px"; snap.style.width = "240px"; snap.style.height = "426px"; snap.style.borderRadius = "22px";
      });
    });
    await sleep(650);
    // 写真アプリに切替（+1 バッジ）
    await p.evaluate(() => {
      document.getElementById("photos").style.transition = "opacity .3s ease";
      document.getElementById("photos").style.opacity = "1";
      const snap = document.getElementById("snap");
      snap.style.transition = "opacity .4s ease,transform .4s ease";
      snap.style.opacity = "0";
    });
    await sleep(200);
    await setClass(p, "#badge", "show");
    await sleep(200);
    await shot(p, "s2b");
    await sleep(900);
  });
}

// ---- S4 削除：写真アプリ → 該当スクショが消える → スッキリ ----
{
  const html = page(`<div class="screen" style="background:var(--paper)">
    ${statusbar(false)}${photosHeader("記録ずみ")}${gridHtml({ firstQr: true })}
    <div class="lower" id="tel"><div class="card"><div class="t1">記録したら、元のスクショは<br><span class="verm">即・削除。</span></div>
      <div class="t2">写真フォルダも散らからない</div></div></div>
  </div>`);
  const f = `${CLIPS}/s4.html`;
  fs.writeFileSync(f, html);
  await record("s4", f, async (p, name) => {
    await sleep(300);
    // 対象（先頭のQR ¥1,580）を選択リング＋ゴミ箱
    await setClass(p, "#badge", "show", false);
    await setClass(p, "#ring", "show");
    await sleep(450);
    await setClass(p, "#trash", "show");
    await setClass(p, "#tel", "show");
    await sleep(650);
    await shot(p, "s4");
    // 削除：対象セルが縮小消滅、ついでに他のスクショ系も間引いて「散らからない」を演出
    await p.evaluate(() => {
      const cells = [...document.querySelectorAll(".cell")];
      cells[0].classList.add("gone"); // ¥1,580 スクショ
      // 他のスクショ(qr/recp/order)を数枚フェードで整理
      const declutter = cells.filter((c) => c.dataset.type !== "photo" && c.dataset.i !== "0").slice(0, 4);
      declutter.forEach((c, k) => setTimeout(() => c.classList.add("gone"), 260 + k * 130));
    });
    await sleep(1050);
    // 残ったセルを詰めて（grid 再配置）スッキリ見せる
    await p.evaluate(() => {
      document.querySelectorAll(".cell.gone").forEach((c) => (c.style.display = "none"));
    });
    await sleep(300);
    await shot(p, "s4b");
    await sleep(1400);
  });
}

// ---- S5 締め：撮る→記録→消える → ブランド ----
{
  const extra = `
    .beats{position:absolute;left:0;right:0;top:20%;text-align:center;}
    .beat{display:inline-block;font-weight:900;font-size:88px;color:#eaf6ff;margin:0 8px;
      opacity:0;transform:translateY(24px) scale(.9);transition:opacity .4s,transform .45s cubic-bezier(.2,1.4,.4,1);}
    .beat.show{opacity:1;transform:none;} .beat.verm{color:#FF6A4D;} .beat.sage{color:#6BD69B;}
    .arrow{color:#5f8a9c;font-size:64px;}
    .lock{position:absolute;left:0;right:0;top:44%;display:flex;align-items:center;justify-content:center;gap:6px;
      opacity:0;transform:scale(.92);transition:opacity .5s,transform .5s cubic-bezier(.2,1.2,.4,1);}
    .lock.show{opacity:1;transform:none;}
    .lock .cash{font-weight:900;font-size:150px;color:#F4F1E9;letter-spacing:-.01em;line-height:1;}
    .lock img{height:150px;display:block;}
    .tag{position:absolute;left:0;right:0;top:62%;text-align:center;font-weight:800;font-size:40px;color:#bcd3dd;
      padding:0 10%;opacity:0;transition:opacity .5s;} .tag.show{opacity:1;}
    .cta{position:absolute;left:50%;top:73%;transform:translateX(-50%) scale(.9);opacity:0;
      transition:opacity .5s,transform .5s cubic-bezier(.2,1.3,.4,1);
      background:var(--verm);color:#fff;font-weight:900;font-size:44px;padding:26px 60px;border-radius:999px;
      box-shadow:0 16px 40px rgba(240,82,56,.45);white-space:nowrap;} .cta.show{opacity:1;transform:translateX(-50%) scale(1);}
  `;
  const html = page(`<div class="screen" style="background:radial-gradient(120% 90% at 50% 30%,#12303c,#0a1620)">
    ${statusbar(true)}
    <div class="beats"><span class="beat" id="b1">撮る</span><span class="beat arrow" id="a1">→</span><span class="beat sage" id="b2">記録</span><span class="beat arrow" id="a2">→</span><span class="beat verm" id="b3">消える</span></div>
    <div class="lock" id="lock"><span class="cash">Cash</span><img src="${SYNC}" alt="sync"></div>
    <div class="tag" id="tag">レシートもQR決済も、スクショで完結する家計簿</div>
    <div class="cta" id="cta">App Store で近日公開</div>
  </div>`, extra);
  const f = `${CLIPS}/s5.html`;
  fs.writeFileSync(f, html);
  await record("s5", f, async (p, name) => {
    await sleep(200);
    for (const id of ["#b1", "#a1", "#b2", "#a2", "#b3"]) { await setClass(p, id, "show"); await sleep(230); }
    await sleep(500);
    await setClass(p, "#lock", "show");
    await sleep(450);
    await setClass(p, "#tag", "show");
    await sleep(250);
    await setClass(p, "#cta", "show");
    await sleep(350);
    await shot(p, "s5");
    await sleep(1900);
  });
}

await browser.close();
console.log("MOCK DONE");
