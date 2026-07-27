// カレンダービュー用：月の日別のお金の動き（支出・収入・給料日）と、今日使えるお金の計算内訳。
import { AuthError, requireUser, unauthorized } from "@/lib/auth";
import { db } from "@/lib/db";
import {
  currentMonth,
  dailyBudget,
  monthPlan,
  monthShiftIncome,
  monthSummary,
  paydays,
  postRecurringForMonth,
  todaySpent,
} from "@/lib/money";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const user = await requireUser();
    postRecurringForMonth(user.id, currentMonth());
    const params = new URL(request.url).searchParams;
    const month = /^\d{4}-\d{2}$/.test(params.get("month") ?? "")
      ? (params.get("month") as string)
      : currentMonth();
    const d = db();
    const expenses = d
      .prepare(
        `SELECT e.id, e.date, e.amount, e.memo, e.source, c.name AS category, c.icon
         FROM expenses e LEFT JOIN categories c ON c.id = e.category_id AND c.user_id = e.user_id
         WHERE e.user_id = ? AND e.date LIKE ? ORDER BY e.date, e.created_at`,
      )
      .all(user.id, `${month}-%`);
    const incomes = d
      .prepare(
        "SELECT id, date, amount, type, memo FROM incomes WHERE user_id = ? AND date LIKE ? ORDER BY date",
      )
      .all(user.id, `${month}-%`);
    // 未来月：定期・分割・給料日を「予定」として計算（実体化しない読み取り専用）。
    // 給料日はシフト確定分も予定側にまとめ、実記録と混ざらないようにする。
    const isFuture = month > currentMonth();
    const plan = monthPlan(user.id, month);
    const pd = isFuture ? [] : paydays(user.id, month);

    // 今日使えるお金の計算内訳（今月のみ意味を持つ）
    const summary = monthSummary(user.id, month);
    const shift = monthShiftIncome(user.id, month);
    const goalRow = d.prepare("SELECT savings_goal FROM users WHERE id = ?").get(user.id) as
      | { savings_goal: number }
      | undefined;
    const savingsGoal = goalRow?.savings_goal ?? 0;
    const otherIncome = summary.incomeTotal - shift.total;
    // 今月のみ：日次予算＋繰り越し方式（予算は昨日までの支出で割り、今日の分は満額引く）
    const budget =
      month === currentMonth() ? dailyBudget(summary, todaySpent(user.id), savingsGoal) : null;

    return Response.json({
      month,
      expenses,
      incomes,
      paydays: pd,
      plan,
      breakdown: {
        shiftIncome: shift.total,
        otherIncome,
        incomeTotal: summary.incomeTotal,
        savingsGoal,
        expenseTotal: summary.expenseTotal,
        // remain: 今月は「昨日までの支出」を引いた予算の分母、過去/未来月は月の収支
        remain: budget
          ? summary.incomeTotal - savingsGoal - budget.spentBeforeToday
          : summary.incomeTotal - savingsGoal - summary.expenseTotal,
        daysRemaining: budget ? budget.daysRemaining : null,
        todayBudget: budget ? budget.todayBudget : null,
        spentToday: budget ? budget.spentToday : null,
        spentBeforeToday: budget ? budget.spentBeforeToday : null,
        // allowance = 「今日あと使える額」（今日の予算 − 今日の支出）
        allowance: budget ? budget.remainingToday : null,
      },
    });
  } catch (e) {
    if (e instanceof AuthError) return unauthorized();
    return Response.json({ error: String(e) }, { status: 500 });
  }
}
