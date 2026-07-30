// グラフ用の月次集計。?months=N で直近N月（さらに ?before=YYYY-MM でページング遡り）。
import { AuthError, requireUser, unauthorized } from "@/lib/auth";
import { db } from "@/lib/db";
import {
  FIXED_EXPENSE_COND,
  accountingMonth,
  buildMonthComparison,
  currentMonth,
  monthRange,
  monthShiftIncome,
  monthSummary,
  postRecurringForMonth,
} from "@/lib/money";

export const dynamic = "force-dynamic";

function shiftMonth(month: string, delta: number): string {
  const [y, m] = month.split("-").map(Number);
  const d = new Date(y, m - 1 + delta, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

export async function GET(request: Request) {
  try {
    const user = await requireUser();
    await postRecurringForMonth(user.id, currentMonth()); // ホーム未訪問でも定期計上が欠けないように
    const params = new URL(request.url).searchParams;
    const months = Math.min(Math.max(1, Number(params.get("months")) || 6), 24);
    // B9: 「今月」は締め日基準の集計月。各月の合計も monthRange 経由の期間で集計する
    const end = /^\d{4}-\d{2}$/.test(params.get("before") ?? "")
      ? (params.get("before") as string)
      : await accountingMonth(user.id);
    const d = await db();
    const series = [];
    for (let i = months - 1; i >= 0; i--) {
      const month = shiftMonth(end, -i);
      const range = await monthRange(user.id, month);
      const expense = (
        (await d.get<{ s: number }>(
          "SELECT COALESCE(SUM(amount), 0) AS s FROM expenses WHERE user_id = ? AND date >= ? AND date <= ?",
          user.id,
          range.start,
          range.end,
        )) as { s: number }
      ).s;
      const income =
        (
          (await d.get<{ s: number }>(
            "SELECT COALESCE(SUM(amount), 0) AS s FROM incomes WHERE user_id = ? AND date >= ? AND date <= ?",
            user.id,
            range.start,
            range.end,
          )) as { s: number }
        ).s + (await monthShiftIncome(user.id, month)).total;
      series.push({ month, income, expense, savings: income - expense });
    }
    // 選択月のカテゴリ内訳（?month= 指定、デフォルトは end）
    const bdMonth = /^\d{4}-\d{2}$/.test(params.get("month") ?? "")
      ? (params.get("month") as string)
      : end;
    const bdRange = await monthRange(user.id, bdMonth);
    // C12: カテゴリごとに「うち固定費」も集計し、内訳を固定費/変動費に分離表示できるようにする
    // （Postgres の集約規則に合わせて GROUP BY に c.name / c.icon も含める。結果は sqlite と同一）
    const breakdown = (
      await d.all<{ category: string; icon: string; amount: number; fixedamount?: number; fixedAmount?: number; categoryId?: string | null; categoryid?: string | null }>(
        `SELECT COALESCE(c.name, '未分類') AS category, COALESCE(c.icon, '') AS icon, SUM(e.amount) AS amount,
                SUM(CASE WHEN ${FIXED_EXPENSE_COND} THEN e.amount ELSE 0 END) AS "fixedAmount",
                e.category_id AS "categoryId"
         FROM expenses e LEFT JOIN categories c ON c.id = e.category_id AND c.user_id = e.user_id
         WHERE e.user_id = ? AND e.date >= ? AND e.date <= ?
         GROUP BY e.category_id, c.name, c.icon ORDER BY amount DESC`,
        user.id,
        bdRange.start,
        bdRange.end,
      )
    ).map((r) => ({
      category: r.category,
      icon: r.icon,
      amount: Number(r.amount),
      fixedAmount: Number(r.fixedAmount ?? r.fixedamount ?? 0),
      categoryId: (r.categoryId ?? r.categoryid ?? null) as string | null, // 内訳タップ→履歴の月内カテゴリ絞り込み用
    }));
    // 前月比・前年同月比の比較（?compare=1。選択月＝bdMonth に対して算出）。
    // 既存の monthSummary / 内訳クエリを再利用するだけの軽い再集計。
    let compare;
    if (params.get("compare")) {
      const prevMonth = shiftMonth(bdMonth, -1);
      const prevYearMonth = shiftMonth(bdMonth, -12);
      const curSum = await monthSummary(user.id, bdMonth);
      const prevSum = await monthSummary(user.id, prevMonth);
      const prevYearSum = await monthSummary(user.id, prevYearMonth);
      const prevRange = await monthRange(user.id, prevMonth);
      const prevBreakdown = (
        await d.all<{ category: string; icon: string; amount: number }>(
          `SELECT COALESCE(c.name, '未分類') AS category, COALESCE(c.icon, '') AS icon, SUM(e.amount) AS amount
           FROM expenses e LEFT JOIN categories c ON c.id = e.category_id AND c.user_id = e.user_id
           WHERE e.user_id = ? AND e.date >= ? AND e.date <= ?
           GROUP BY e.category_id, c.name, c.icon ORDER BY amount DESC`,
          user.id,
          prevRange.start,
          prevRange.end,
        )
      ).map((r) => ({ category: r.category, icon: r.icon, amount: Number(r.amount) }));
      // 記録が1件も無い月は「比較データなし」（収支どちらも0）
      const hasData = (s: { incomeTotal: number; expenseTotal: number }) =>
        s.incomeTotal > 0 || s.expenseTotal > 0;
      compare = buildMonthComparison(
        { income: curSum.incomeTotal, expense: curSum.expenseTotal },
        hasData(prevSum) ? { income: prevSum.incomeTotal, expense: prevSum.expenseTotal } : null,
        hasData(prevYearSum)
          ? { income: prevYearSum.incomeTotal, expense: prevYearSum.expenseTotal }
          : null,
        breakdown.map((b) => ({ category: b.category, icon: b.icon, amount: b.amount })),
        prevBreakdown,
      );
    }
    return Response.json({ series, breakdown, breakdownMonth: bdMonth, compare });
  } catch (e) {
    if (e instanceof AuthError) return unauthorized();
    return Response.json({ error: String(e) }, { status: 500 });
  }
}
