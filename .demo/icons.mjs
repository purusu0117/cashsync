// アイコン文脈比較：iPhoneホーム画面風グリッドに3候補を配置（squircle角丸適用）
import sharp from "sharp";

const OUT = "C:/Users/daito/projects/cashsync-design/ui-proposals/compare-icons.png";
const ICONS = "C:/Users/daito/projects/cashsync-design/icons-v2";

// @2x 相当：画面 780x1500（グリッド部分のみ）＋下に凡例
const W = 780;
const SCREEN_H = 1120;
const LEGEND_H = 150;
const H = SCREEN_H + LEGEND_H;

const ICON = 124; // ≒60pt @2x
const R = Math.round(ICON * 0.2237); // iOS squircle 近似
const COLS = 4;
const MARGIN_X = 54;
const GAP_X = (W - MARGIN_X * 2 - ICON * COLS) / (COLS - 1);
const TOP = 140;
const ROW_H = 216;

function squircle(w, r, fillDef, fill, inner = "") {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${w}">
    <defs>${fillDef}</defs>
    <rect width="${w}" height="${w}" rx="${r}" fill="${fill}"/>${inner}</svg>`;
}

// ダミーアプリ（一般的なアプリの雰囲気・簡略グリフ）
const dummies = {
  mail: squircle(ICON, R, `<linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#1c86f2"/><stop offset="1" stop-color="#0a60c4"/></linearGradient>`, "url(#g)",
    `<rect x="24" y="38" width="76" height="50" rx="8" fill="none" stroke="#fff" stroke-width="6"/><path d="M26 42 62 68 98 42" fill="none" stroke="#fff" stroke-width="6" stroke-linecap="round" stroke-linejoin="round"/>`),
  camera: squircle(ICON, R, "", "#d8d9dd",
    `<rect x="22" y="40" width="80" height="52" rx="10" fill="#5b5d63"/><rect x="46" y="30" width="24" height="12" rx="4" fill="#5b5d63"/><circle cx="62" cy="66" r="17" fill="#d8d9dd"/><circle cx="62" cy="66" r="11" fill="#3a3b40"/>`),
  music: squircle(ICON, R, `<linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fb5c74"/><stop offset="1" stop-color="#f23b4d"/></linearGradient>`, "url(#g)",
    `<path d="M50 88V44l34-8v44" fill="none" stroke="#fff" stroke-width="7" stroke-linejoin="round"/><circle cx="43" cy="88" r="10" fill="#fff"/><circle cx="77" cy="80" r="10" fill="#fff"/>`),
  maps: squircle(ICON, R, "", "#f4f2ec",
    `<path d="M0 0h62v62H0Z" fill="#a8d98d" transform="translate(8,8)"/><path d="M70 54h46v62H70Z" fill="#f0e9d8"/><path d="M8 84c30-8 52-30 62-70" fill="none" stroke="#4c8ef5" stroke-width="12"/><circle cx="86" cy="40" r="12" fill="#e8442e"/>`),
  clock: squircle(ICON, R, "", "#111",
    `<circle cx="62" cy="62" r="44" fill="#fff"/><path d="M62 30v32l22 14" fill="none" stroke="#111" stroke-width="6" stroke-linecap="round"/>`),
  weather: squircle(ICON, R, `<linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#3f9bf5"/><stop offset="1" stop-color="#1b6fd0"/></linearGradient>`, "url(#g)",
    `<circle cx="48" cy="50" r="18" fill="#ffd147"/><ellipse cx="72" cy="74" rx="28" ry="18" fill="#fff"/><ellipse cx="48" cy="78" rx="20" ry="14" fill="#fff"/>`),
  notes: squircle(ICON, R, "", "#fff",
    `<rect width="124" height="34" rx="0" fill="#f7d64a"/><rect y="28" width="124" height="6" fill="#e6c33a"/><path d="M24 58h76M24 78h76M24 98h52" stroke="#c9c9ce" stroke-width="5" stroke-linecap="round"/>`),
  calc: squircle(ICON, R, "", "#1c1c1e",
    `<rect x="26" y="24" width="72" height="24" rx="6" fill="#3a3a3c"/><g fill="#ff9f0a"><circle cx="96" cy="66" r="9"/><circle cx="96" cy="92" r="9"/></g><g fill="#8e8e93"><circle cx="34" cy="66" r="9"/><circle cx="65" cy="66" r="9"/><circle cx="34" cy="92" r="9"/><circle cx="65" cy="92" r="9"/></g>`),
  safari: squircle(ICON, R, "", "#f2f2f7",
    `<circle cx="62" cy="62" r="44" fill="#1f8ef7"/><path d="M84 40 54 54 40 84l30-14z" fill="#fff"/><path d="M84 40 54 54l16 16z" fill="#ff4b40"/>`),
  photos: squircle(ICON, R, "", "#fff",
    `<g opacity="0.85"><ellipse cx="62" cy="34" rx="12" ry="22" fill="#f7c948"/><ellipse cx="62" cy="90" rx="12" ry="22" fill="#4c8ef5"/><ellipse cx="34" cy="62" rx="22" ry="12" fill="#e8442e"/><ellipse cx="90" cy="62" rx="22" ry="12" fill="#57b85c"/><ellipse cx="42" cy="42" rx="16" ry="10" fill="#f2882f" transform="rotate(-45 42 42)"/><ellipse cx="82" cy="42" rx="16" ry="10" fill="#c9d64a" transform="rotate(45 82 42)"/><ellipse cx="42" cy="82" rx="16" ry="10" fill="#8a5fbf" transform="rotate(45 42 82)"/><ellipse cx="82" cy="82" rx="16" ry="10" fill="#3fb7d0" transform="rotate(-45 82 82)"/></g>`),
  settings: squircle(ICON, R, "", "#c9cace",
    `<circle cx="62" cy="62" r="34" fill="#6e7076"/><circle cx="62" cy="62" r="14" fill="#c9cace"/><g stroke="#6e7076" stroke-width="10"><path d="M62 18v14M62 92v14M18 62h14M92 62h14M31 31l10 10M83 83l10 10M93 31 83 41M41 83 31 93"/></g>`),
  chat: squircle(ICON, R, "", "#33c653",
    `<path d="M62 30c-22 0-40 14-40 32 0 11 7 20 17 26l-3 14 15-8c4 .7 7 1 11 1 22 0 40-14 40-33S84 30 62 30Z" fill="#fff"/>`),
};

const layout = [
  ["mail", "メール"], ["safari", "Safari"], ["photos", "写真"], ["weather", "天気"],
  ["music", "ミュージック"], ["maps", "マップ"], ["notes", "メモ"], ["clock", "時計"],
  ["CAND:a-fold-yen", "CashSync"], ["chat", "LINE"], ["CAND:c-dot-yen", "CashSync"], ["settings", "設定"],
  ["calc", "計算機"], ["CAND:d-red-receipt-barcode", "CashSync"], ["camera", "カメラ"], ["mail2", ""],
];

const mask = Buffer.from(
  `<svg xmlns="http://www.w3.org/2000/svg" width="${ICON}" height="${ICON}"><rect width="${ICON}" height="${ICON}" rx="${R}" fill="#fff"/></svg>`,
);

// 壁紙：iOS標準っぽい落ち着いたダークグラデ
const wallpaper = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
  <defs>
    <linearGradient id="wp" x1="0" y1="0" x2="0.9" y2="1">
      <stop offset="0" stop-color="#26303f"/>
      <stop offset="0.55" stop-color="#151c26"/>
      <stop offset="1" stop-color="#0c1016"/>
    </linearGradient>
  </defs>
  <rect width="${W}" height="${SCREEN_H}" fill="url(#wp)"/>
  <text x="${W / 2}" y="92" text-anchor="middle" font-family="Meiryo, sans-serif" font-size="42" fill="#fff" opacity="0.92">9:41</text>
  <rect y="${SCREEN_H}" width="${W}" height="${LEGEND_H}" fill="#ece7dd"/>
  <text x="40" y="${SCREEN_H + 62}" font-family="Meiryo, sans-serif" font-size="30" font-weight="bold" fill="#211d18">アイコン候補の文脈比較（ホーム画面での見え方）</text>
  <text x="40" y="${SCREEN_H + 106}" font-family="Meiryo, sans-serif" font-size="22" fill="#6d6656">● 印 = 候補（squircle角丸適用）。順に a-fold-yen / c-dot-yen / d-red-receipt-barcode</text>
</svg>`);

const comps = [];
for (let i = 0; i < layout.length; i++) {
  const [key, label] = layout[i];
  if (key === "mail2") continue; // 空きスロット
  const col = i % COLS;
  const row = Math.floor(i / COLS);
  const x = Math.round(MARGIN_X + col * (ICON + GAP_X));
  const y = TOP + row * ROW_H;
  const isCand = key.startsWith("CAND:");
  let buf;
  if (isCand) {
    buf = await sharp(`${ICONS}/${key.slice(5)}.png`)
      .resize(ICON, ICON)
      .composite([{ input: mask, blend: "dest-in" }])
      .png()
      .toBuffer();
  } else {
    buf = await sharp(Buffer.from(dummies[key])).png().toBuffer();
  }
  comps.push({ input: buf, top: y, left: x });
  // ラベル
  const labelSvg = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${ICON + 60}" height="60">
    <text x="${(ICON + 60) / 2}" y="30" text-anchor="middle" font-family="Meiryo, sans-serif" font-size="24" fill="#fff" opacity="0.95">${label}</text>
    ${isCand ? `<circle cx="${(ICON + 60) / 2}" cy="48" r="6" fill="#e8442e"/>` : ""}
  </svg>`);
  comps.push({ input: labelSvg, top: y + ICON + 8, left: x - 30 });
}

await sharp(wallpaper).composite(comps).png().toFile(OUT);
console.log("icons sheet:", OUT);
