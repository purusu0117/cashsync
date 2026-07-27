// ホーム画面用の集約API。定期計上の lazy 実行もここで行う。
import { AuthError, requireUser, unauthorized } from "@/lib/auth";
import { db } from "@/lib/db";
import { jstTodayStr } from "@/lib/jst";
import {
  currentMonth,
  dailyBudget,
  monthForecast,
  monthSummary,
  noMoneyDays,
  postRecurringForMonth,
  todaySpent,
} from "@/lib/money";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const user = await requireUser();
    const month = currentMonth();
    await postRecurringForMonth(user.id, month);
    const d = await db();
    // つけ忘れ判定は recent(5件) ではなく昨日を直接数える（今日多く記録すると誤判定するため）
    const ydStr = jstTodayStr(-1);
    // クラウド版（Vercel⇄Supabase）はDB往復ごとにレイテンシが乗るため、独立クエリは並列で投げる。
    // forecast だけは summary に依存するので、summary の完了に連結する。
    const [sf, goalRow, recent, ydCount, presets, noMoney, spentToday] = await Promise.all([
      monthSummary(user.id, month).then(async (summary) => ({
        summary,
        forecast: await monthForecast(user.id, summary),
      })),
      d.get<{ savings_goal: number }>("SELECT savings_goal FROM users WHERE id = ?", user.id),
      d.all(
        `SELECT e.id, e.date, e.amount, e.memo, e.source, c.name AS category, c.icon
         FROM expenses e LEFT JOIN categories c ON c.id = e.category_id AND c.user_id = e.user_id
         WHERE e.user_id = ? ORDER BY e.date DESC, e.created_at DESC LIMIT 5`,
        user.id,
      ),
      d.get<{ c: number }>(
        "SELECT COUNT(*) AS c FROM expenses WHERE user_id = ? AND date = ?",
        user.id,
        ydStr,
      ) as Promise<{ c: number }>,
      d.all(
        `SELECT p.id, p.label, p.amount, p.category_id, c.icon
         FROM quick_presets p LEFT JOIN categories c ON c.id = p.category_id
         WHERE p.user_id = ? ORDER BY p.sort`,
        user.id,
      ),
      noMoneyDays(user.id, month),
      todaySpent(user.id),
    ]);
    const { summary, forecast } = sf;
    const savingsGoal = goalRow?.savings_goal ?? 0;
    const budget = dailyBudget(summary, spentToday, savingsGoal);
    return Response.json({
      user: { name: user.name },
      month,
      summary,
      savingsGoal,
      // allowance = 「今日あと使える額」（日次予算 − 今日の支出。マイナス＝超過）
      allowance: budget.remainingToday,
      budget,
      daysRemaining: budget.daysRemaining,
      noMoney,
      forecast,
      yesterday: { date: ydStr, recorded: ydCount.c > 0 },
      recent,
      presets,
    });
  } catch (e) {
    if (e instanceof AuthError) return unauthorized();
    return Response.json(
      { error: e instanceof Error ? e.message : "summary failed" },
      { status: 500 },
    );
  }
}
