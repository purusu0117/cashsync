// サーバー専用：日本時間（Asia/Tokyo）固定の「今日」ユーティリティ。
// PC版はサーバーTZ=JSTなので new Date() のローカル取得で問題なかったが、
// クラウド（Vercel等）はTZ=UTCのため 0-9時JSTに日付がズレる。
// → 「今」を扱う箇所はすべてここを経由し、UTC+9時間したDateをgetUTC*で読むことでTZ非依存にする。
// （既存の純カレンダー計算：daysInMonth・月シフト・"YYYY-MM-DD"文字列比較などはTZ非依存なので対象外）

const JST_OFFSET_MS = 9 * 60 * 60 * 1000;

/** JSTの今日（offsetDaysで前後の日をずらせる）。y/m/dは1始まりの暦値、dowは0=日曜 */
export function jstToday(offsetDays = 0): { y: number; m: number; d: number; dow: number } {
  const t = new Date(Date.now() + JST_OFFSET_MS + offsetDays * 86_400_000);
  return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate(), dow: t.getUTCDay() };
}

/** JSTの今日を 'YYYY-MM-DD' で */
export function jstTodayStr(offsetDays = 0): string {
  const { y, m, d } = jstToday(offsetDays);
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

/** JSTの今日を基準に、暦計算（day差し引き等）した日付を 'YYYY-MM-DD' で返す */
export function jstDateStr(y: number, m: number, d: number): string {
  // Date.UTCで暦の繰り上げ（月跨ぎ・年跨ぎ）を処理。TZ非依存。
  const t = new Date(Date.UTC(y, m - 1, d));
  return `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, "0")}-${String(t.getUTCDate()).padStart(2, "0")}`;
}
