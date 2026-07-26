// 比較シート生成：画面ごとに「現状 | 案X | 案Y」を横並び（ラベル付き）
import sharp from "sharp";

const BASE = "C:/Users/daito/projects/cashsync-design/ui-proposals";
const SHOT_W = 780; // 390 @2x
const SHOT_H = 1688;
const GAP = 40;
const LABEL_H = 96;
const PAD = 40;

const COLS = [
  ["current", "現状"],
  ["planX", "案X 読みやすさ特化"],
  ["planY", "案Y 一歩リデザイン"],
];

const SCREENS = [
  ["home", "ホーム"],
  ["calendar", "カレンダー"],
  ["history", "履歴"],
  ["shifts", "シフト"],
  ["stats", "グラフ"],
  ["settings", "設定"],
];

const W = PAD * 2 + SHOT_W * 3 + GAP * 2;
const H = PAD + 70 + LABEL_H + SHOT_H + PAD;

function esc(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
}

for (const [file, title] of SCREENS) {
  const labels = COLS.map(([, label], i) => {
    const x = PAD + i * (SHOT_W + GAP) + SHOT_W / 2;
    const color = i === 0 ? "#6d6656" : "#211d18";
    return `<text x="${x}" y="${PAD + 70 + 58}" text-anchor="middle" font-family="Meiryo, sans-serif" font-size="34" font-weight="bold" fill="${color}">${esc(label)}</text>`;
  }).join("");
  const bg = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
    <rect width="${W}" height="${H}" fill="#ece7dd"/>
    <text x="${PAD}" y="${PAD + 44}" font-family="Meiryo, sans-serif" font-size="44" font-weight="bold" fill="#211d18">CashSync UI比較 — ${esc(title)}</text>
    <text x="${W - PAD}" y="${PAD + 44}" text-anchor="end" font-family="Meiryo, sans-serif" font-size="26" fill="#6d6656">390×844 ・ 同一デモデータ</text>
    ${labels}
  </svg>`);
  const comps = [{ input: bg, top: 0, left: 0 }];
  for (let i = 0; i < COLS.length; i++) {
    const img = await sharp(`${BASE}/${COLS[i][0]}/${file}.png`)
      .resize(SHOT_W, SHOT_H, { fit: "cover", position: "top" })
      .png()
      .toBuffer();
    comps.push({ input: img, top: PAD + 70 + LABEL_H, left: PAD + i * (SHOT_W + GAP) });
  }
  await sharp({ create: { width: W, height: H, channels: 3, background: "#ece7dd" } })
    .composite(comps)
    .png()
    .toFile(`${BASE}/compare-${file}.png`);
  console.log("compare:", file);
}
