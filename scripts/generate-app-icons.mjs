// アプリアイコン生成：public/icons/app-icon.svg（A案「紙の折り返し＋朱赤¥」）から
// PWA・favicon・apple-touch-icon・iOSネイティブ（Capacitor 8 = 1024x1024単一）を書き出す。
// 角丸はOS側が適用するため焼き込まない（full-bleed正方形のまま）。
//   実行: node scripts/generate-app-icons.mjs
import { fileURLToPath } from "node:url";
import path from "node:path";
import sharp from "sharp";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = path.join(root, "public", "icons", "app-icon.svg");

const targets = [
  // PWA（manifest.ts が参照）
  { out: "public/icons/icon-192.png", size: 192 },
  { out: "public/icons/icon-512.png", size: 512 },
  // ブラウザタブ用 favicon（Next の app/icon.png 規約で自動リンク）
  { out: "src/app/icon.png", size: 192 },
  // iOS Safari「ホーム画面に追加」（app/apple-icon.png 規約＋既定パスの両方）
  { out: "src/app/apple-icon.png", size: 180 },
  { out: "public/apple-touch-icon.png", size: 180 },
  // iOSネイティブ（Capacitor 8 は 1024x1024 の単一アイコン）
  { out: "ios/App/App/Assets.xcassets/AppIcon.appiconset/AppIcon-512@2x.png", size: 1024 },
];

for (const t of targets) {
  const dest = path.join(root, t.out);
  await sharp(src, { density: Math.max(72, (72 * t.size) / 1024) })
    .resize(t.size, t.size, { fit: "fill" })
    .png()
    .toFile(dest);
  console.log(`OK ${t.out} (${t.size}x${t.size})`);
}
