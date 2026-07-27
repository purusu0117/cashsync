// カレンダービュー用：月の日別のお金の動き（支出・収入・給料日）と、今日使えるお金の計算内訳。
import { AuthError, requireUser, unauthorized } from "@/lib/auth";
import { db } from "@/lib/db";
import {
  currentMonth,
  dailyBudget,
  monthFixedCost,
  monthPlan,
  monthSummary,
  paydays,
  postRecurringForMonth,
  todaySpent,
} from "@/lib/money";
import type { Payday } from "@/lib/money";

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
    // 未来月：定期・分割・給料日を「予定」として計算（実体化しない読み取り専用）。
    // 給料日はシフト確定分も予定側にまとめ、実記録と混ざらないようにする。
    const isFuture = month > currentMonth();
    // クラウド版（Vercel⇄Supabase）はDB往復ごとにレイテンシが乗るため、独立クエリは並列で投げる。
    // シフト収入は monthSummary が内包する値を使い、重複計算（monthShiftIncome の二重実行）も削除。
    const [expenses, incomes, pd, plan, summary, goalRow, spentToday, fixedTotal] =
      await Promise.all([
      d.all(
        `SELECT e.id, e.date, e.amount, e.memo, e.source, c.name AS category, c.icon
         FROM expenses e LEFT JOIN categories c ON c.id = e.category_id AND c.user_id = e.user_id
         WHERE e.user_id = ? AND e.date LIKE ? ORDER BY e.date, e.created_at`,
        user.id,
        `${month}-%`,
      ),
      d.all(
        "SELECT id, date, amount, type, memo FROM incomes WHERE user_id = ? AND date LIKE ? ORDER BY date",
        user.id,
        `${month}-%`,
      ),
      isFuture ? Promise.resolve<Payday[]>([]) : paydays(user.id, month),
      monthPlan(user.id, month),
      // 今日使えるお金の計算内訳（今月のみ意味を持つ）
      monthSummary(user.id, month),
      d.get<{ savings_goal: number }>("SELECT savings_goal FROM users WHERE id = ?", user.id),
      todaySpent(user.id),
      monthFixedCost(user.id, month),
    ]);
    const shift = summary.shift;
    const savingsGoal = goalRow?.savings_goal ?? 0;
    const otherIncome = summary.incomeTotal - shift.total;
    // 今月のみ：日次予算＋繰り越し方式（固定費は満額先取りし、予算は昨日までの変動支出で割り、今日の分は満額引く）
    const budget =
      month === currentMonth()
        ? dailyBudget(summary, spentToday, savingsGoal, undefined, fixedTotal)
        : null;
    // 未来月は「予定込みの1系統」に統一：収入＝予定収入（定期＋入力済みシフトの給料）＋実収入レコード、
    // 支出＝予定支出（定期・分割）＋実支出レコード。「予定合計」と「残り」が別系統の値にならないようにする。
    const planIncomeTotal = isFuture ? plan.incomeTotal + otherIncome : summary.incomeTotal;
    const planExpenseTotal = isFuture ? plan.expenseTotal + summary.expenseTotal : summary.expenseTotal;

    return Response.json({
      month,
      expenses,
      incomes,
      paydays: pd,
      plan,
      breakdown: {
        planned: isFuture, // true=予定ベースの未来月（実績行は出さない）
        shiftIncome: shift.total,
        otherIncome,
        incomeTotal: planIncomeTotal,
        savingsGoal,
        expenseTotal: planExpenseTotal,
        fixedTotal: budget ? budget.fixedTotal : null, // 今月の固定費（先取り済み）
        // remain: 今月は「固定費先取り＋昨日までの変動支出」を引いた予算の土台、
        //         未来月は 予定収入 − 貯金目標 − 予定支出、過去月は実績の収支
        remain: budget
          ? budget.monthRemaining
          : planIncomeTotal - savingsGoal - planExpenseTotal,
        daysRemaining: budget ? budget.daysRemaining : null,
        todayBudget: budget ? budget.todayBudget : null,
        spentToday: budget ? budget.spentToday : null,
        spentBeforeToday: budget ? budget.spentBeforeToday : null,
        // allowance = 「今日あと使える額」（今日の予算 − 今日の変動支出）
        allowance: budget ? budget.remainingToday : null,
      },
    });
  } catch (e) {
    if (e instanceof AuthError) return unauthorized();
    return Response.json({ error: String(e) }, { status: 500 });
  }
}
