import sharp from "sharp";
import fs from "node:fs";
import path from "node:path";
const MK = "C:/Users/daito/projects/cashsync-design/store/screenshots/marketing";
const slots = ["01","02","03","04","05","06","07"];
const w = 150;
const imgs = [];
for (const s of slots) {
  const buf = await sharp(path.join(MK, `${s}.png`)).resize(w).png().toBuffer();
  imgs.push(buf);
}
// build a horizontal strip
const metas = await Promise.all(imgs.map((b) => sharp(b).metadata()));
const h = Math.max(...metas.map((m) => m.height));
const gap = 12;
const stripW = slots.length * w + (slots.length + 1) * gap;
const composites = imgs.map((b, i) => ({ input: b, top: gap, left: gap + i * (w + gap) }));
await sharp({ create: { width: stripW, height: h + gap * 2, channels: 3, background: "#444" } })
  .composite(composites).png().toFile(path.join(MK, "_thumbstrip.png"));
console.log("thumbstrip done", stripW, h);
