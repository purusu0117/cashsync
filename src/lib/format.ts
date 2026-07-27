// クライアント/サーバー共用の表示ユーティリティ（DBに触らない）
/** 金額表示。負値は「-¥1,234」形式（「¥-1,234」にしない）で全画面統一 */
export function fmtYen(n: number): string {
  const v = Math.round(n);
  return v < 0 ? `-¥${(-v).toLocaleString("ja-JP")}` : `¥${v.toLocaleString("ja-JP")}`;
}

const DAYS = ["日", "月", "火", "水", "木", "金", "土"];

/** '2026-07-24' → '7月24日(金)' */
export function fmtDateJa(date: string): string {
  const [y, m, d] = date.split("-").map(Number);
  const dt = new Date(y, m - 1, d);
  return `${m}月${d}日(${DAYS[dt.getDay()]})`;
}

/** '2026-07' → '2026年7月' */
export function fmtMonthJa(month: string): string {
  const [y, m] = month.split("-").map(Number);
  return `${y}年${m}月`;
}

export function todayLocal(): string {
  const n = new Date();
  return `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, "0")}-${String(n.getDate()).padStart(2, "0")}`;
}

export function minToHHMM(min: number): string {
  return `${String(Math.floor(min / 60)).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;
}

export function hhmmToMin(v: string): number {
  const [h, m] = v.split(":").map(Number);
  return h * 60 + (m || 0);
}
