// 週次振り返り：先週（月〜日）の支出サマリーを返す（AI不使用・即答）。
import { AuthError, requireUser, unauthorized } from "@/lib/auth";
import { db } from "@/lib/db";
import { jstDateStr, jstToday } from "@/lib/jst";
import { postRecurringForMonth, currentMonth } from "@/lib/money";

export const dynamic = "force-dynamic";

/** 直近の「完了した週」（月曜はじまり・JST基準）。offset=1でさらに1週前 */
function lastWeekRange(offset = 0): { start: string; end: string } {
  const now = jstToday();
  const dow = (now.dow + 6) % 7; // 月曜=0
  const mondayDay = now.d - dow - 7 * (offset + 1);
  return {
    start: jstDateStr(now.y, now.m, mondayDay),
    end: jstDateStr(now.y, now.m, mondayDay + 6),
  };
}

async function weekStats(userId: string, range: { start: string; end: string }) {
  const d = await db();
  // 週次は「行動の振り返り」なので、家賃・サブスク等の定期計上は除いた変動支出だけで見る
  // （ノーマネーデーの定義とも揃える）
  const total = (
    (await d.get<{ s: number }>(
      "SELECT COALESCE(SUM(amount),0) AS s FROM expenses WHERE user_id = ? AND date >= ? AND date <= ? AND source != 'recurring'",
      userId,
      range.start,
      range.end,
    )) as { s: number }
  ).s;
  const top = await d.get<{ category: string; icon: string; amount: number }>(
    `SELECT COALESCE(c.name,'未分類') AS category, COALESCE(c.icon,'') AS icon, SUM(e.amount) AS amount
     FROM expenses e LEFT JOIN categories c ON c.id = e.category_id AND c.user_id = e.user_id
     WHERE e.user_id = ? AND e.date >= ? AND e.date <= ? AND e.source != 'recurring'
     GROUP BY e.category_id, c.name, c.icon ORDER BY amount DESC LIMIT 1`,
    userId,
    range.start,
    range.end,
  );
  const max = await d.get<{ memo: string; amount: number; date: string }>(
    "SELECT memo, amount, date FROM expenses WHERE user_id = ? AND date >= ? AND date <= ? AND source != 'recurring' ORDER BY amount DESC LIMIT 1",
    userId,
    range.start,
    range.end,
  );
  const spentDays = (
    (await d.get<{ c: number }>(
      "SELECT COUNT(DISTINCT date) AS c FROM expenses WHERE user_id = ? AND date >= ? AND date <= ? AND source != 'recurring'",
      userId,
      range.start,
      range.end,
    )) as { c: number }
  ).c;
  return { total, top: top ?? null, max: max ?? null, noMoneyDays: 7 - spentDays };
}

export async function GET() {
  try {
    const user = await requireUser();
    await postRecurringForMonth(user.id, currentMonth());
    const range = lastWeekRange(0);
    const prevRange = lastWeekRange(1);
    const cur = await weekStats(user.id, range);
    const prev = await weekStats(user.id, prevRange);
    return Response.json({
      range,
      total: cur.total,
      prevTotal: prev.total,
      top: cur.top,
      max: cur.max,
      noMoneyDays: cur.noMoneyDays,
    });
  } catch (e) {
    if (e instanceof AuthError) return unauthorized();
    return Response.json({ error: String(e) }, { status: 500 });
  }
}
