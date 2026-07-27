// C4: iOSウィジェット用の軽量API。
// ウィジェットはWebViewの外（別プロセス）で動くのでセッションCookieが使えない。
// そのためショートカット連携と同じ Authorization: Bearer <api_token> で認証する。
// 返すのはホーム画面の主役の数字だけ（ウィジェットは狭いので情報を絞る）。
import { userFromBearer } from "@/lib/auth";
import {
  accountingMonthFor,
  currentMonth,
  dailyBudget,
  getMonthStartDay,
  monthFixedCost,
  monthSummary,
  nextPayday,
  postRecurringForMonth,
  todaySpent,
  todayStr,
} from "@/lib/money";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const user = await userFromBearer(request);
    if (!user) {
      return Response.json({ error: "認証エラー：設定画面のトークンを設定してください。" }, { status: 401 });
    }
    await postRecurringForMonth(user.id, currentMonth());
    const monthStartDay = await getMonthStartDay(user.id);
    const today = todayStr();
    const month = accountingMonthFor(today, monthStartDay);
    const d = await db();
    const [summary, goalRow, spent, fixedTotal, payday] = await Promise.all([
      monthSummary(user.id, month),
      d.get<{ savings_goal: number }>("SELECT savings_goal FROM users WHERE id = ?", user.id),
      todaySpent(user.id, today),
      monthFixedCost(user.id, month),
      nextPayday(user.id, today),
    ]);
    const budget = dailyBudget(
      summary,
      spent,
      Number(goalRow?.savings_goal ?? 0),
      today,
      fixedTotal,
      monthStartDay,
    );
    return Response.json({
      // ウィジェットの主役：今日あと使える額（マイナス＝今日は使いすぎ）
      remainingToday: budget.remainingToday,
      todayBudget: budget.todayBudget,
      spentToday: budget.spentToday,
      daysRemaining: budget.daysRemaining,
      // 予算が尽きているときに「次の給料日まで耐える」の目安を出す
      nextPayday: payday ? { date: payday.date, amount: payday.amount, daysUntil: payday.daysUntil } : null,
      date: today,
      updatedAt: Date.now(),
    });
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : "widget failed" }, { status: 500 });
  }
}
