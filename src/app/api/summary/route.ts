// ホーム画面用の集約API。定期計上の lazy 実行もここで行う。
import { AuthError, requireUser, unauthorized } from "@/lib/auth";
import { db } from "@/lib/db";
import {
  currentMonth,
  dailyBudget,
  monthFixedCost,
  monthForecast,
  monthSummary,
  nextPayday,
  noMoneyDays,
  postRecurringForMonth,
  todaySpent,
} from "@/lib/money";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const user = await requireUser();
    const month = currentMonth();
    postRecurringForMonth(user.id, month);
    const summary = monthSummary(user.id, month);
    const d = db();
    const goalRow = d.prepare("SELECT savings_goal FROM users WHERE id = ?").get(user.id) as
      | { savings_goal: number }
      | undefined;
    const savingsGoal = goalRow?.savings_goal ?? 0;
    const recent = d
      .prepare(
        `SELECT e.id, e.date, e.amount, e.memo, e.source, e.category_id, e.receipt_id, c.name AS category, c.icon
         FROM expenses e LEFT JOIN categories c ON c.id = e.category_id AND c.user_id = e.user_id
         WHERE e.user_id = ? ORDER BY e.date DESC, e.created_at DESC LIMIT 5`,
      )
      .all(user.id);
    // つけ忘れ判定は recent(5件) ではなく昨日を直接数える（今日多く記録すると誤判定するため）
    const yd = new Date();
    yd.setDate(yd.getDate() - 1);
    const ydStr = `${yd.getFullYear()}-${String(yd.getMonth() + 1).padStart(2, "0")}-${String(yd.getDate()).padStart(2, "0")}`;
    const ydCount = d
      .prepare("SELECT COUNT(*) AS c FROM expenses WHERE user_id = ? AND date = ?")
      .get(user.id, ydStr) as { c: number };
    const presets = d
      .prepare(
        `SELECT p.id, p.label, p.amount, p.category_id, c.icon
         FROM quick_presets p LEFT JOIN categories c ON c.id = p.category_id
         WHERE p.user_id = ? ORDER BY p.sort`,
      )
      .all(user.id);
    // 固定費（定期計上・分割）は今月分を満額先取りし、日々の数字は変動支出だけで動かす
    const budget = dailyBudget(
      summary,
      todaySpent(user.id),
      savingsGoal,
      undefined,
      monthFixedCost(user.id, month),
    );
    return Response.json({
      user: { name: user.name },
      month,
      summary,
      savingsGoal,
      // allowance = 「今日あと使える額」（日次予算 − 今日の変動支出。マイナス＝超過）
      allowance: budget.remainingToday,
      budget,
      daysRemaining: budget.daysRemaining,
      nextPayday: nextPayday(user.id),
      noMoney: noMoneyDays(user.id, month),
      forecast: monthForecast(user.id, summary),
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
