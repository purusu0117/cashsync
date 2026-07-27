// 使いすぎ予兆チェック（タスクスケジューラから毎日20:30に叩かれる想定）。
// 月末予測が赤字ペースのユーザーに、1日1回だけ通知を送る。
import { db } from "@/lib/db";
import {
  currentMonth,
  daysRemainingInMonth,
  monthForecast,
  monthSummary,
  postRecurringForMonth,
  todayStr,
} from "@/lib/money";
import { pushToUser } from "@/lib/push";
import { fmtYen } from "@/lib/format";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const key = new URL(request.url).searchParams.get("key");
  if (!key || key !== process.env.CRON_KEY) {
    return Response.json({ error: "forbidden" }, { status: 403 });
  }
  const d = await db();
  const users = await d.all<{ id: string; savings_goal: number; last_overspend_push: string | null }>(
    "SELECT DISTINCT u.id, u.savings_goal, u.last_overspend_push FROM users u JOIN push_subscriptions p ON p.user_id = u.id",
  );
  const today = todayStr();
  let notified = 0;
  for (const u of users) {
    if (u.last_overspend_push === today) continue; // 1日1回
    await postRecurringForMonth(u.id, currentMonth());
    const summary = await monthSummary(u.id, currentMonth());
    const fc = await monthForecast(u.id, summary);
    let body = "";
    if (fc.forecast < 0) {
      const recover = Math.ceil(-fc.forecast / daysRemainingInMonth());
      body = `⚠ このままだと月末 ${fmtYen(fc.forecast)}。1日あと${fmtYen(recover)}おさえれば黒字に戻せます`;
    } else if (u.savings_goal > 0 && fc.forecast < u.savings_goal) {
      body = `🟡 黒字ペースですが、貯金目標まであと${fmtYen(u.savings_goal - fc.forecast)}足りない見込みです`;
    }
    if (!body) continue;
    const sent = await pushToUser(u.id, "CashSync 使いすぎ予兆", body);
    if (sent > 0) {
      await d.run("UPDATE users SET last_overspend_push = ? WHERE id = ?", today, u.id);
      notified++;
    }
  }
  return Response.json({ ok: true, checked: users.length, notified });
}
