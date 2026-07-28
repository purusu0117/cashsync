// CashSync marketing screenshots compositor (v2). 1320x2868, single-frame per slot.
// Usage: node render.mjs [slot1 slot2 ...]   (no args = all 8)
//        node render.mjs 02a 02b 03a ...      (variant scoring: <slot><letter>)
import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const OUT = "C:/Users/daito/projects/cashsync-design/store/screenshots/marketing";
const SHOTS = "C:/Users/daito/projects/cashsync-design/store/screenshots";
const ASSET = path.join(OUT, "assets");

const W = 1320, H = 2868;
const toUrl = (p) => pathToFileURL(p).href;

const BG = { hero: toUrl(path.join(ASSET, "bg-hero.png")), main: toUrl(path.join(ASSET, "bg-main.png")) };
const SS = (n) => toUrl(path.join(SHOTS, n));
const FONT_NOTO = toUrl("C:/Windows/Fonts/NotoSansJP-VF.ttf");
const FONT_BIZ = toUrl("C:/Windows/Fonts/BIZ-UDGothicB.ttc");

// palette
const WHITE = "#F4F1E9";
const SUB = "rgba(244,241,233,0.74)";
const SAGE = "#5BBE83";
const VERM = "#F05238";

// feature icons (light stroke) for CTA
const ic = {
  camera: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M3 8.5A2 2 0 0 1 5 6.5h1.2l1-1.6a1.5 1.5 0 0 1 1.3-.7h5a1.5 1.5 0 0 1 1.3.7l1 1.6H19a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><circle cx="12" cy="13" r="3.4"/></svg>`,
  calendar: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="3.5" y="5" width="17" height="16" rx="2.5"/><path d="M3.5 9.5h17M8 3v4M16 3v4"/></svg>`,
  chart: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/></svg>`,
  wallet: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="6" width="18" height="13" rx="2.5"/><path d="M3 10h18M16.5 14.5h.01"/></svg>`,
  tag: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M20.5 13.3 13 20.8a2 2 0 0 1-2.8 0l-6-6A2 2 0 0 1 3.6 13V5.2a1.6 1.6 0 0 1 1.6-1.6H13a2 2 0 0 1 1.4.6l6.1 6.1a2 2 0 0 1 0 3z"/><circle cx="8" cy="8" r="1.4"/></svg>`,
};

// slots: caption HTML + bg + screenshot + layout tweaks
const SLOTS = {
  // 1枚目：入力3秒（レシート自動読取）— おカネレコの"2秒手入力"に"撮るだけ自動"で対抗
  "01": {
    bg: BG.hero, ss: SS("07-scan.png"), phoneW: 754, phoneTop: 690,
    caption: `<div class="line n">レシート撮るだけ、</div>
      <div class="line big"><span class="verm">入力3秒</span><span class="wht">。</span></div>`,
    sub: `カメラで撮る → 店名・金額・明細まで自動入力`,
  },
  // 2枚目：月末予測（黒字/赤字）— 競合6社が誰もやっていない最大の空白地帯
  "02": {
    bg: BG.main, ss: SS("10-home-forecast.png"), phoneW: 726, phoneTop: 744,
    caption: `<div class="line big"><span class="sage">黒字？</span><span class="verm">赤字？</span></div>
      <div class="line n">月末を、いまから予測。</div>`,
    sub: `このまま使い続けたら…をホームで先読み`,
  },
  // 3枚目：レシートが出ない支払い（QR決済・ネット注文）の画面スクショ→自動記録→元スクショ削除
  "03": {
    bg: BG.hero, ss: SS("12-scan-confirm-order.png"), phoneW: 726, phoneTop: 744,
    caption: `<div class="line n">QR決済もネット注文も、</div>
      <div class="line big"><span class="wht">スクショで</span><span class="verm">一発</span></div>`,
    sub: `読み取って自動で記録→元のスクショはワンタップ削除`,
  },
  // 4枚目：シフト給料×家計 1画面（変動収入の統合＝競合ゼロ）
  "04": {
    bg: BG.main, ss: SS("02-calendar.png"),
    caption: `<div class="line n">シフトも給料も支出も、</div>
      <div class="line big"><span class="sage">1画面</span><span class="wht">に。</span></div>`,
  },
  // 5枚目：資産・純資産
  "05": {
    bg: BG.main, ss: SS("05-assets.png"),
    caption: `<div class="line n">口座も資産も、</div>
      <div class="line big"><span class="sage">まとめて把握</span><span class="wht">。</span></div>`,
    sub: `純資産がひと目で・データは安全に管理`,
  },
  // 6枚目：横断タグ集計
  "06": {
    bg: BG.main, ss: SS("08-tags.png"),
    caption: `<div class="line big"><span class="sage">費目を横断</span><span class="wht">。</span></div>
      <div class="line n">“何にいくら”を集計。</div>`,
  },
  // 7枚目：レシート風UI（世界観・続けやすさ）
  "07": {
    bg: BG.main, ss: SS("03-history.png"),
    caption: `<div class="line big"><span class="sage">続けたくなる</span><span class="wht">。</span></div>
      <div class="line n">レシート風の家計簿。</div>`,
  },
  // 8枚目：まとめ／CTA
  "08": {
    bg: BG.hero, ss: SS("01-home.png"), cta: true, phoneW: 604,
    caption: `<div class="line n">入力3秒の家計簿を、</div>
      <div class="line big"><span class="wht">今すぐ</span><span class="verm">無料</span><span class="wht">で。</span></div>`,
  },
};

// 採点用キャプション候補（<slot><letter>）。ベースは SLOTS[slot]。
const VARIANTS = {
  "02a": { base: "02",
    caption: `<div class="line n">今のペースで、月末は</div>
      <div class="line big"><span class="sage">黒字？</span><span class="verm">赤字？</span></div>`,
    sub: `このまま使い続けたら…をホームで先読み` },
  "02b": { base: "02",
    caption: `<div class="line n">使う前に、先読み。</div>
      <div class="line big"><span class="sage">月末いくら残る？</span></div>`,
    sub: `今のペースの着地を、ホームで自動予測` },
  "02c": { base: "02",
    caption: `<div class="line big"><span class="sage">黒字？</span><span class="verm">赤字？</span></div>
      <div class="line n">月末を、いまから予測。</div>`,
    sub: `このまま使い続けたら…をホームで先読み` },
  // 03: レシートが出ない支払い（QR決済・ネット注文）の画面スクショ→自動記録→元スクショ削除、をシナリオ先導で。
  "03a": { base: "03", ss: SS("11-scan-confirm-qr.png"),
    caption: `<div class="line n">レシートがない支払いも、</div>
      <div class="line big"><span class="sage">スクショ</span><span class="wht">で記録</span></div>`,
    sub: `QR決済・ネット注文の画面を読み取り→元のスクショは削除` },
  "03b": { base: "03", ss: SS("12-scan-confirm-order.png"),
    caption: `<div class="line n">QR決済もネット注文も、</div>
      <div class="line big"><span class="wht">スクショで</span><span class="verm">一発</span></div>`,
    sub: `読み取ったら、元のスクショはワンタップ削除` },
  "03c": { base: "03", ss: SS("11-scan-confirm-qr.png"),
    caption: `<div class="line n">支払い画面をスクショ→記録→</div>
      <div class="line big"><span class="verm">削除</span><span class="wht">。</span></div>`,
    sub: `読み取った内容はアプリに保存、元のスクショはワンタップで削除` },
};

function resolve(key) {
  if (SLOTS[key]) return { slot: SLOTS[key], out: `${key}.png` };
  const v = VARIANTS[key];
  if (v) {
    const { base, ...over } = v;
    return { slot: { ...SLOTS[base], ...over }, out: `_v-${key}.png` };
  }
  throw new Error(`unknown slot ${key}`);
}

function html(s) {
  const phoneW = s.phoneW ?? 726;
  const ratio = 1290 / 2796;
  const screenH = Math.round(phoneW / ratio);
  const bez = 15;
  const frameW = phoneW + bez * 2;
  const frameH = screenH + bez * 2;
  const zoom = s.zoom ?? 1;
  const posY = s.posY ?? "top";

  const phoneTop = s.phoneTop ?? (s.cta ? 720 : 762);
  const iconsTop = phoneTop + frameH + 84;
  const ctaTop = iconsTop + 168;
  const extras = s.cta
    ? `<div class="icons" style="top:${iconsTop}px">
        ${[["camera", "撮る"], ["calendar", "カレンダー"], ["chart", "グラフ"], ["wallet", "資産"], ["tag", "タグ"]]
          .map(([k, l]) => `<div class="ico"><div class="glyph">${ic[k]}</div><span>${l}</span></div>`)
          .join("")}
      </div>
      <div class="ctaBtn" style="top:${ctaTop}px">App Store で無料</div>`
    : `<div class="brand" style="top:80px">CASHSYNC</div>
       <div class="brand" style="bottom:76px">CashSync ・ 入力3秒の家計簿</div>`;

  const sub = s.sub ? `<div class="sub">${s.sub}</div>` : "";

  return `<!doctype html><html><head><meta charset="utf-8"><style>
    @font-face{font-family:'NotoJP';src:url('${FONT_NOTO}') format('truetype');font-weight:100 900;}
    @font-face{font-family:'BizB';src:url('${FONT_BIZ}') format('truetype');font-weight:700;}
    *{margin:0;padding:0;box-sizing:border-box;}
    html,body{width:${W}px;height:${H}px;overflow:hidden;}
    .stage{position:relative;width:${W}px;height:${H}px;background:#111;
      font-family:'NotoJP','BizB',sans-serif;color:${WHITE};}
    .bg{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;}
    /* readability overlay: strongest at top (caption zone), fading to mid */
    .ov{position:absolute;inset:0;background:
       linear-gradient(180deg, rgba(8,9,11,0.62) 0%, rgba(8,9,11,0.42) 22%, rgba(8,9,11,0.12) 40%, rgba(8,9,11,0.05) 60%, rgba(8,9,11,0.28) 100%);}
    .cap{position:absolute;top:150px;left:0;right:0;padding:0 90px;text-align:center;
      text-shadow:0 6px 30px rgba(0,0,0,0.55);}
    .line{letter-spacing:0.02em;}
    .line.n{font-weight:800;font-size:76px;line-height:1.32;color:${WHITE};}
    .line.big{font-weight:900;font-size:150px;line-height:1.18;letter-spacing:0.01em;
      display:flex;align-items:baseline;justify-content:center;flex-wrap:wrap;}
    .line.big .wht{color:${WHITE};font-size:150px;}
    .line.big .sage,.line.big .verm{font-size:150px;}
    .sage{color:${SAGE};}
    .verm{color:${VERM};}
    .sub{margin-top:26px;font-weight:700;font-size:40px;color:${SUB};letter-spacing:0.04em;}
    .phoneWrap{position:absolute;left:50%;transform:translateX(-50%);}
    .contact{position:absolute;left:50%;transform:translateX(-50%);
      width:${Math.round(frameW*0.82)}px;height:90px;border-radius:50%;
      background:radial-gradient(ellipse at center, rgba(0,0,0,0.55) 0%, rgba(0,0,0,0) 70%);filter:blur(6px);}
    .frame{width:${frameW}px;height:${frameH}px;border-radius:${Math.round(bez*4.6)}px;
      background:linear-gradient(160deg,#26262b,#0b0b0d 55%);padding:${bez}px;
      box-shadow:0 40px 90px rgba(0,0,0,0.55), 0 8px 20px rgba(0,0,0,0.4),
        inset 0 0 0 1.5px rgba(255,255,255,0.06);}
    .screen{width:${phoneW}px;height:${screenH}px;border-radius:${Math.round(bez*3.4)}px;
      overflow:hidden;background:#efece3;box-shadow:inset 0 0 0 1px rgba(0,0,0,0.35);}
    .screen img{width:100%;height:100%;object-fit:cover;object-position:${posY} center;display:block;
      transform:scale(${zoom});transform-origin:top center;}
    .brand{position:absolute;left:0;right:0;text-align:center;font-weight:800;
      font-size:38px;letter-spacing:0.22em;color:rgba(244,241,233,0.62);}
    /* CTA */
    .icons{position:absolute;left:0;right:0;display:flex;justify-content:center;gap:44px;}
    .ico{display:flex;flex-direction:column;align-items:center;gap:12px;color:rgba(244,241,233,0.9);}
    .ico .glyph{width:64px;height:64px;}
    .ico .glyph svg{width:100%;height:100%;}
    .ico span{font-weight:700;font-size:28px;color:${SUB};letter-spacing:0.02em;}
    .ctaBtn{position:absolute;left:50%;transform:translateX(-50%);
      background:${VERM};color:#fff;font-weight:900;font-size:46px;letter-spacing:0.02em;
      padding:34px 70px;border-radius:999px;white-space:nowrap;
      box-shadow:0 14px 30px rgba(240,82,56,0.4), inset 0 -4px 0 rgba(0,0,0,0.18);}
  </style></head><body>
    <div class="stage">
      <img class="bg" src="${s.bg}">
      <div class="ov"></div>
      <div class="cap">${s.caption}${sub}</div>
      <div class="contact" style="top:${phoneTop + frameH - 24}px"></div>
      <div class="phoneWrap" style="top:${phoneTop}px">
        <div class="frame"><div class="screen"><img src="${s.ss}"></div></div>
      </div>
      ${extras}
    </div>
  </body></html>`;
}

const args = process.argv.slice(2);
const targets = args.length ? args : Object.keys(SLOTS);

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
const page = await ctx.newPage();
for (const key of targets) {
  const { slot, out } = resolve(key);
  const doc = html(slot);
  const tmp = path.join(OUT, `_tmp-${key}.html`);
  fs.writeFileSync(tmp, doc);
  await page.goto(toUrl(tmp), { waitUntil: "networkidle" });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(OUT, out), clip: { x: 0, y: 0, width: W, height: H } });
  fs.rmSync(tmp, { force: true });
  console.log("rendered", key, "->", out);
}
await browser.close();
console.log("DONE");
