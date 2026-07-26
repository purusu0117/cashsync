// カレンダービュー用：月の日別のお金の動き（支出・収入・給料日）と、今日使えるお金の計算内訳。
import { AuthError, requireUser, unauthorized } from "@/lib/auth";
import { db } from "@/lib/db";
import {
  currentMonth,
  dailyAllowance,
  daysRemainingInMonth,
  monthShiftIncome,
  monthSummary,
  paydays,
  postRecurringForMonth,
} from "@/lib/money";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const user = await requireUser();
    await postRecurringForMonth(user.id, currentMonth());
    const params = new URL(request.url).searchParams;
    const month = /^\d{4}-\d{2}$/.test(params.get("month") ?? "")
      ? (params.get("month") as string)
      : currentMonth();
    const d = await db();
    const expenses = await d.all(
      `SELECT e.id, e.date, e.amount, e.memo, e.source, c.name AS category, c.icon
       FROM expenses e LEFT JOIN categories c ON c.id = e.category_id AND c.user_id = e.user_id
       WHERE e.user_id = ? AND e.date LIKE ? ORDER BY e.date, e.created_at`,
      user.id,
      `${month}-%`,
    );
    const incomes = await d.all(
      "SELECT id, date, amount, type, memo FROM incomes WHERE user_id = ? AND date LIKE ? ORDER BY date",
      user.id,
      `${month}-%`,
    );
    const pd = await paydays(user.id, month);

    // 今日使えるお金の計算内訳（今月のみ意味を持つ）
    const summary = await monthSummary(user.id, month);
    const shift = await monthShiftIncome(user.id, month);
    const goalRow = await d.get<{ savings_goal: number }>(
      "SELECT savings_goal FROM users WHERE id = ?",
      user.id,
    );
    const savingsGoal = goalRow?.savings_goal ?? 0;
    const otherIncome = summary.incomeTotal - shift.total;

    return Response.json({
      month,
      expenses,
      incomes,
      paydays: pd,
      breakdown: {
        shiftIncome: shift.total,
        otherIncome,
        incomeTotal: summary.incomeTotal,
        savingsGoal,
        expenseTotal: summary.expenseTotal,
        remain: summary.incomeTotal - savingsGoal - summary.expenseTotal,
        daysRemaining: month === currentMonth() ? daysRemainingInMonth() : null,
        allowance: month === currentMonth() ? dailyAllowance(summary, savingsGoal) : null,
      },
    });
  } catch (e) {
    if (e instanceof AuthError) return unauthorized();
    return Response.json({ error: String(e) }, { status: 500 });
  }
}
