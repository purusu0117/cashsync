// C3: 記録リマインダー（毎時タスクスケジューラ／Vercel Cron から叩かれる想定）。
// 設定した時刻になっても「今日まだ1件も記録していない」ユーザーにだけ、1日1回通知する。
// 記録済みの人には送らない（無駄な通知で切られないための最重要ルール）。
import { db } from "@/lib/db";
import { fmtYen } from "@/lib/format";
import {
  accountingMonth,
  currentMonth,
  dailyBudget,
  getMonthStartDay,
  monthFixedCost,
  monthSummary,
  postRecurringForMonth,
  todaySpent,
  todayStr,
} from "@/lib/money";
import { pushToUser } from "@/lib/push";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const key = params.get("key");
  if (!key || key !== process.env.CRON_KEY) {
    return Response.json({ error: "forbidden" }, { status: 403 });
  }
  // 通常は現在時刻。テスト用に ?hour= で上書きできる（0〜23）
  const hourParam = params.get("hour");
  const hour =
    hourParam !== null && /^\d{1,2}$/.test(hourParam) && Number(hourParam) <= 23
      ? Number(hourParam)
      : new Date().getHours();
  const today = todayStr();
  const d = db();
  const users = d
    .prepare(
      `SELECT DISTINCT u.id, u.savings_goal, u.reminder_hour, u.last_reminder_push
       FROM users u JOIN push_subscriptions p ON p.user_id = u.id
       WHERE u.reminder_hour = ?`,
    )
    .all(hour) as unknown as {
    id: string;
    savings_goal: number;
    reminder_hour: number;
    last_reminder_push: string | null;
  }[];
  let notified = 0;
  let skippedRecorded = 0;
  for (const u of users) {
    if (u.last_reminder_push === today) continue; // 1日1回
    // 今日すでに記録している人には送らない（定期の自動計上は「記録した」に数えない）
    const recorded = (
      d
        .prepare(
          "SELECT (SELECT COUNT(*) FROM expenses WHERE user_id = ? AND date = ? AND source != 'recurring') + (SELECT COUNT(*) FROM incomes WHERE user_id = ? AND date = ? AND type != 'recurring') AS c",
        )
        .get(u.id, today, u.id, today) as { c: number }
    ).c;
    if (recorded > 0) {
      skippedRecorded++;
      continue;
    }
    postRecurringForMonth(u.id, currentMonth());
    // 「今日あと使える額」を添えて、開く理由をつくる（計算できないときは本文だけ）
    let tail = "";
    try {
      const summary = monthSummary(u.id, accountingMonth(u.id));
      const budget = dailyBudget(
        summary,
        todaySpent(u.id, today),
        u.savings_goal,
        today,
        monthFixedCost(u.id, accountingMonth(u.id)),
        getMonthStartDay(u.id),
      );
      if (budget.remainingToday > 0) tail = `（今日はあと${fmtYen(budget.remainingToday)}使えます）`;
    } catch {
      tail = "";
    }
    const sent = await pushToUser(
      u.id,
      "CashSync 記録リマインド",
      `今日の記録がまだです。レシートを撮るだけなら3秒で終わります${tail}`,
    );
    if (sent > 0) {
      d.prepare("UPDATE users SET last_reminder_push = ? WHERE id = ?").run(today, u.id);
      notified++;
    }
  }
  return Response.json({ ok: true, hour, targets: users.length, notified, skippedRecorded });
}
