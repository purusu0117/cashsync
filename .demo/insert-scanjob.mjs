// Insert a completed scan_job so /scan?job=1 opens the confirm sheet (no AI call, no personal data).
import { DatabaseSync } from "node:sqlite";

const file = process.env.CASHSYNC_DB_PATH;
if (!file) throw new Error("CASHSYNC_DB_PATH required");
const d = new DatabaseSync(file);

const user = d.prepare("SELECT id FROM users WHERE email = ?").get("demo@cashsync.app");
if (!user) throw new Error("demo user not found");
const cat = d.prepare("SELECT id FROM categories WHERE user_id = ? AND name = ?").get(user.id, "食費");

const items = [
  { name: "牛乳", price: 238 },
  { name: "たまご 10個", price: 268 },
  { name: "食パン", price: 158 },
  { name: "サラダ", price: 198 },
  { name: "鶏むね肉", price: 398 },
  { name: "ヨーグルト", price: 158 },
  { name: "トマト", price: 157 },
  { name: "レジ袋", price: 5 },
];
const total = items.reduce((s, it) => s + it.price, 0); // 1580
const scan = {
  kind: "expense",
  store: "まいばすけっと 相模原店",
  date: "2026-07-28",
  total,
  category: "食費",
  items,
};
const result = JSON.stringify({ scan, categoryId: cat?.id ?? null, learned: false, imageHash: "demo" });
const now = Date.now();
const id = globalThis.crypto.randomUUID();
d.prepare(
  "INSERT INTO scan_jobs (id, user_id, status, result_json, error, image_hash, created_at, updated_at) VALUES (?, ?, 'done', ?, NULL, ?, ?, ?)",
).run(id, user.id, result, "demo", now, now);
console.log("scan_job inserted:", id, "total", total, "category", cat?.id);
