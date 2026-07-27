// グラフ用の月次集計。?months=N で直近N月（さらに ?before=YYYY-MM でページング遡り）。
import { AuthError, requireUser, unauthorized } from "@/lib/auth";
import { db } from "@/lib/db";
import {
  accountingMonth,
  currentMonth,
  monthRange,
  monthShiftIncome,
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
    const breakdown = await d.all(
      `SELECT COALESCE(c.name, '未分類') AS category, COALESCE(c.icon, '') AS icon, SUM(e.amount) AS amount
       FROM expenses e LEFT JOIN categories c ON c.id = e.category_id AND c.user_id = e.user_id
       WHERE e.user_id = ? AND e.date >= ? AND e.date <= ?
       GROUP BY e.category_id, c.name, c.icon ORDER BY amount DESC`,
      user.id,
      bdRange.start,
      bdRange.end,
    );
    return Response.json({ series, breakdown, breakdownMonth: bdMonth });
  } catch (e) {
    if (e instanceof AuthError) return unauthorized();
    return Response.json({ error: String(e) }, { status: 500 });
  }
}
