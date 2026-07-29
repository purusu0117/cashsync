// ホーム画面用の集約API。定期計上の lazy 実行もここで行う。
import { AuthError, requireUser, unauthorized } from "@/lib/auth";
import { db } from "@/lib/db";
import { jstTodayStr } from "@/lib/jst";
import {
  accountingMonthFor,
  currentMonth,
  dailyBudget,
  getMonthStartDay,
  monthFixedCost,
  monthForecast,
  monthRangeFor,
  monthSummary,
  nextPayday,
  noMoneyDays,
  postRecurringForMonth,
  todaySpent,
  todayStr,
} from "@/lib/money";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const user = await requireUser();
    // 定期計上はカレンダー月キーで冪等管理（支払日ベース）なので従来どおり実カレンダー月まで
    await postRecurringForMonth(user.id, currentMonth());
    // B9: 「今月」は締め日基準の集計月（デフォルト開始日1なら実カレンダー月と同一）
    const monthStartDay = await getMonthStartDay(user.id);
    const month = accountingMonthFor(todayStr(), monthStartDay);
    const range = monthRangeFor(month, monthStartDay);
    const d = await db();
    // つけ忘れ判定は recent(5件) ではなく昨日を直接数える（今日多く記録すると誤判定するため）
    const ydStr = jstTodayStr(-1);
    // クラウド版（Vercel⇄Supabase）はDB往復ごとにレイテンシが乗るため、独立クエリは並列で投げる。
    // forecast だけは summary に依存するので、summary の完了に連結する。
    const [
      sf,
      goalRow,
      recent,
      ydCount,
      presets,
      noMoney,
      spentToday,
      fixedTotal,
      payday,
      counts,
      categoryBreakdown,
    ] = await Promise.all([
      monthSummary(user.id, month).then(async (summary) => ({
        summary,
        forecast: await monthForecast(user.id, summary),
      })),
      d.get<{ savings_goal: number; work_style: string | null }>(
        "SELECT savings_goal, work_style FROM users WHERE id = ?",
        user.id,
      ),
      d.all(
        `SELECT e.id, e.date, e.amount, e.memo, e.source, e.category_id, e.receipt_id, c.name AS category, c.icon
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
      monthFixedCost(user.id, month),
      nextPayday(user.id),
      // B3: 初回セットアップカード用の登録状況（全期間）。expensesAll は空データ時の
      // 虚偽表示（ノーマネーデー称賛・振り返り案内・黒字判子）の抑制にも使う
      (async () => {
        const [jobs, rec, recInc, exp] = await Promise.all([
          d.get<{ c: number }>("SELECT COUNT(*) AS c FROM jobs WHERE user_id = ?", user.id),
          d.get<{ c: number }>(
            "SELECT COUNT(*) AS c FROM recurring_items WHERE user_id = ? AND kind = 'expense'",
            user.id,
          ),
          // 社会人向け：毎月の給料（手取り）を定期収入として登録しているか。
          // 収入源が「シフト(jobs)」か「定期収入」かはユーザー次第なので、初回セットアップの
          // 「収入を登録」ステップは jobs か recurringIncome のどちらかがあれば完了とみなす。
          d.get<{ c: number }>(
            "SELECT COUNT(*) AS c FROM recurring_items WHERE user_id = ? AND kind = 'income'",
            user.id,
          ),
          d.get<{ c: number }>("SELECT COUNT(*) AS c FROM expenses WHERE user_id = ?", user.id),
        ]);
        return {
          jobs: jobs?.c ?? 0,
          recurringExpense: rec?.c ?? 0,
          recurringIncome: recInc?.c ?? 0,
          expensesAll: exp?.c ?? 0,
        };
      })(),
      // カテゴリ別の当月支出（ホームの円グラフ用）。集計期間（締め日基準）で合算。
      // GROUP BY に c.name / c.icon を含める（Postgres の集約規則対応。category_id ごとに一意なので結果は不変）
      d.all(
        `SELECT c.name AS name, c.icon AS icon, SUM(e.amount) AS total
         FROM expenses e LEFT JOIN categories c ON c.id = e.category_id AND c.user_id = e.user_id
         WHERE e.user_id = ? AND e.date >= ? AND e.date <= ?
         GROUP BY e.category_id, c.name, c.icon
         ORDER BY total DESC`,
        user.id,
        range.start,
        range.end,
      ) as Promise<{ name: string | null; icon: string | null; total: number }[]>,
    ]);
    const { summary, forecast } = sf;
    const savingsGoal = goalRow?.savings_goal ?? 0;
    // 固定費（定期計上・分割）は今月分を満額先取りし、日々の数字は変動支出だけで動かす
    const budget = dailyBudget(summary, spentToday, savingsGoal, undefined, fixedTotal, monthStartDay);
    return Response.json({
      user: { name: user.name },
      month,
      // B9: 集計期間（開始日1なら実カレンダー月と同じ）。ホームの「7/25〜8/24の集計」表示用
      range,
      monthStartDay,
      summary,
      savingsGoal,
      // 働き方（収入タイプ）。ホームのセットアップ導線・下タブのシフト表示切替に使う
      workStyle: goalRow?.work_style ?? "hourly",
      // allowance = 「今日あと使える額」（日次予算 − 今日の変動支出。マイナス＝超過）
      allowance: budget.remainingToday,
      budget,
      daysRemaining: budget.daysRemaining,
      nextPayday: payday,
      noMoney,
      forecast,
      yesterday: { date: ydStr, recorded: ydCount.c > 0 },
      recent,
      presets,
      counts,
      // ホームの円グラフ用：カテゴリ別の当月支出（金額降順）
      categoryBreakdown,
    });
  } catch (e) {
    if (e instanceof AuthError) return unauthorized();
    return Response.json(
      { error: e instanceof Error ? e.message : "summary failed" },
      { status: 500 },
    );
  }
}
