// CashSync demo seed — リアルなデモデータ（キミハン風バイト・2週間の支出・シフト・貯金目標）
import { DatabaseSync } from "node:sqlite";

const db = new DatabaseSync("C:/Users/daito/AppData/Local/Temp/cashsync-demo/demo.db");
const uid = () => globalThis.crypto.randomUUID();
const now = Date.now();

const user = db.prepare("SELECT id FROM users WHERE email = ?").get("demo@cashsync.app");
if (!user) throw new Error("user not found");
const U = user.id;

// 名前の文字化け修正＋貯金目標
db.prepare("UPDATE users SET name = ?, savings_goal = ? WHERE id = ?").run("大翔", 20000, U);

// カテゴリID取得
const cats = {};
for (const r of db.prepare("SELECT id, name FROM categories WHERE user_id = ?").all(U)) {
  cats[r.name] = r.id;
}

// バイト先（キミハン風）
const jobId = uid();
db.prepare(
  `INSERT INTO jobs (id, user_id, name, weekday_rate, weekend_holiday_rate, transport_per_shift,
   calendar_keywords, calendar_exclude, color, closing_day, pay_month_offset, pay_day, pay_same_day)
   VALUES (?, ?, ?, ?, ?, ?, '', '', ?, 31, 1, 10, 0)`,
).run(jobId, U, "キミハン", 1150, 1200, 0, "#e8442e");

// シフト（7月：実績＋今後）17:00-22:00 中心
const shifts = [
  ["2026-07-03", 1020, 1320, 0],
  ["2026-07-05", 1020, 1350, 15],
  ["2026-07-08", 1080, 1320, 0],
  ["2026-07-11", 1020, 1350, 15],
  ["2026-07-12", 600, 900, 0],
  ["2026-07-15", 1020, 1320, 0],
  ["2026-07-18", 1020, 1350, 15],
  ["2026-07-19", 600, 900, 0],
  ["2026-07-22", 1080, 1320, 0],
  ["2026-07-25", 1020, 1350, 15],
  ["2026-07-27", 1020, 1320, 0],
  ["2026-07-29", 1080, 1320, 0],
  ["2026-07-31", 1020, 1350, 15],
];
const insShift = db.prepare(
  "INSERT INTO shifts (id, user_id, job_id, date, start_min, end_min, break_min, source) VALUES (?, ?, ?, ?, ?, ?, ?, 'manual')",
);
for (const [d, s, e, b] of shifts) insShift.run(uid(), U, jobId, d, s, e, b);

// 収入（6月分給料＋仕送り）
const insInc = db.prepare(
  "INSERT INTO incomes (id, user_id, date, amount, type, memo, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
);
insInc.run(uid(), U, "2026-07-10", 61480, "salary", "キミハン 6月分給料", now);
insInc.run(uid(), U, "2026-07-01", 30000, "allowance", "仕送り", now);

// 支出（7/12〜7/26 の2週間＋月前半少し）
const E = [
  // date, amount, category, memo
  ["2026-07-02", 590, "食費", "松屋 牛めし"],
  ["2026-07-04", 1280, "食費", "まいばすけっと"],
  ["2026-07-06", 790, "サブスク", "Netflix"],
  ["2026-07-07", 3278, "通信", "ahamo"],
  ["2026-07-09", 1650, "交際", "サイゼ 飲み"],
  ["2026-07-12", 650, "食費", "セブンイレブン"],
  ["2026-07-12", 1000, "交通", "Suicaチャージ"],
  ["2026-07-13", 486, "食費", "ローソン"],
  ["2026-07-14", 1540, "日用品", "マツキヨ"],
  ["2026-07-15", 480, "食費", "富士そば"],
  ["2026-07-16", 678, "食費", "スタバ"],
  ["2026-07-17", 2990, "洋服", "ユニクロ"],
  ["2026-07-18", 1180, "食費", "業務スーパー"],
  ["2026-07-19", 3450, "交際", "焼肉きんぐ"],
  ["2026-07-21", 1320, "学び", "技術書"],
  ["2026-07-22", 524, "食費", "ファミマ"],
  ["2026-07-23", 1100, "娯楽", "映画（レイトショー）"],
  ["2026-07-24", 968, "食費", "まいばすけっと"],
  ["2026-07-25", 650, "食費", "セブンイレブン"],
  ["2026-07-26", 429, "食費", "ローソン"],
];
const insExp = db.prepare(
  "INSERT INTO expenses (id, user_id, date, amount, category_id, memo, source, created_at) VALUES (?, ?, ?, ?, ?, ?, 'manual', ?)",
);
let t = now - E.length * 60000;
for (const [d, a, c, m] of E) insExp.run(uid(), U, d, a, cats[c] ?? null, m, (t += 60000));

// 袋分け予算（stats用）
const insBud = db.prepare(
  "INSERT INTO category_budgets (user_id, category_id, amount) VALUES (?, ?, ?)",
);
insBud.run(U, cats["食費"], 25000);
insBud.run(U, cats["交際"], 8000);
insBud.run(U, cats["娯楽"], 5000);

console.log("seeded:", db.prepare("SELECT COUNT(*) c FROM expenses").get().c, "expenses");
