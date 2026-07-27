// 週次振り返り：先週（月〜日）の支出サマリーを返す（AI不使用・即答）。
import { AuthError, requireUser, unauthorized } from "@/lib/auth";
import { db } from "@/lib/db";
import { postRecurringForMonth, currentMonth } from "@/lib/money";

export const dynamic = "force-dynamic";

function fmt(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** 直近の「完了した週」（月曜はじまり）。offset=1でさらに1週前 */
function lastWeekRange(offset = 0): { start: string; end: string } {
  const now = new Date();
  const dow = (now.getDay() + 6) % 7; // 月曜=0
  const monday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - dow - 7 * (offset + 1));
  const sunday = new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + 6);
  return { start: fmt(monday), end: fmt(sunday) };
}

function weekStats(userId: string, range: { start: string; end: string }) {
  const d = db();
  // 週次は「行動の振り返り」なので、家賃・サブスク等の定期計上は除いた変動支出だけで見る
  // （ノーマネーデーの定義とも揃える）
  const total = (
    d
      .prepare(
        "SELECT COALESCE(SUM(amount),0) AS s FROM expenses WHERE user_id = ? AND date >= ? AND date <= ? AND source != 'recurring'",
      )
      .get(userId, range.start, range.end) as { s: number }
  ).s;
  const top = d
    .prepare(
      `SELECT COALESCE(c.name,'未分類') AS category, COALESCE(c.icon,'') AS icon, SUM(e.amount) AS amount
       FROM expenses e LEFT JOIN categories c ON c.id = e.category_id AND c.user_id = e.user_id
       WHERE e.user_id = ? AND e.date >= ? AND e.date <= ? AND e.source != 'recurring'
       GROUP BY e.category_id ORDER BY amount DESC LIMIT 1`,
    )
    .get(userId, range.start, range.end) as
    | { category: string; icon: string; amount: number }
    | undefined;
  const max = d
    .prepare(
      "SELECT memo, amount, date FROM expenses WHERE user_id = ? AND date >= ? AND date <= ? AND source != 'recurring' ORDER BY amount DESC LIMIT 1",
    )
    .get(userId, range.start, range.end) as
    | { memo: string; amount: number; date: string }
    | undefined;
  const spentDays = (
    d
      .prepare(
        "SELECT COUNT(DISTINCT date) AS c FROM expenses WHERE user_id = ? AND date >= ? AND date <= ? AND source != 'recurring'",
      )
      .get(userId, range.start, range.end) as { c: number }
  ).c;
  // B3: 記録0件の週は「支出ゼロ！」と称賛せず、記録開始の案内に切り替えるための行数
  const recordCount = (
    d
      .prepare(
        "SELECT COUNT(*) AS c FROM expenses WHERE user_id = ? AND date >= ? AND date <= ? AND source != 'recurring'",
      )
      .get(userId, range.start, range.end) as { c: number }
  ).c;
  return { total, top: top ?? null, max: max ?? null, noMoneyDays: 7 - spentDays, recordCount };
}

export async function GET() {
  try {
    const user = await requireUser();
    postRecurringForMonth(user.id, currentMonth());
    const range = lastWeekRange(0);
    const prevRange = lastWeekRange(1);
    const cur = weekStats(user.id, range);
    const prev = weekStats(user.id, prevRange);
    return Response.json({
      range,
      total: cur.total,
      prevTotal: prev.total,
      top: cur.top,
      max: cur.max,
      noMoneyDays: cur.noMoneyDays,
      recordCount: cur.recordCount,
    });
  } catch (e) {
    if (e instanceof AuthError) return unauthorized();
    return Response.json({ error: String(e) }, { status: 500 });
  }
}
