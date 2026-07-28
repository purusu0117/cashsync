// C3: 記録リマインダー（Vercel Cron／PC版はタスクスケジューラから毎時叩かれる想定）。
// 設定した時刻になっても「今日まだ1件も記録していない」ユーザーにだけ、1日1回通知する。
// 記録済みの人には送らない（無駄な通知で切られないための最重要ルール）。
// Vercel は TZ=UTC なので、時刻の判定は jstHour() で日本時間に固定する。
import { shouldSendAssetReminder } from "@/lib/accounts";
import { db } from "@/lib/db";
import { fmtYen } from "@/lib/format";
import { jstHour, jstToday } from "@/lib/jst";
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
  // Vercel Cron は Authorization: Bearer <CRON_SECRET> を付けてくるので、それも受け付ける
  const bearer = request.headers.get("authorization");
  const cronSecret = process.env.CRON_SECRET;
  const okByKey = !!key && key === process.env.CRON_KEY;
  const okByBearer = !!cronSecret && bearer === `Bearer ${cronSecret}`;
  if (!okByKey && !okByBearer) {
    return Response.json({ error: "forbidden" }, { status: 403 });
  }
  // 通常は現在のJST時刻。テスト用に ?hour= で上書きできる（0〜23）
  const hourParam = params.get("hour");
  const hour =
    hourParam !== null && /^\d{1,2}$/.test(hourParam) && Number(hourParam) <= 23
      ? Number(hourParam)
      : jstHour();
  const today = todayStr();
  const d = await db();
  const users = await d.all<{
    id: string;
    savings_goal: number;
    reminder_hour: number;
    last_reminder_push: string | null;
  }>(
    // 対象は Web Push購読者（ブラウザ/PWA）のみ。
    // ネイティブアプリは端末側のローカル通知で鳴るので、ここから送ると二重になる。
    `SELECT DISTINCT u.id, u.savings_goal, u.reminder_hour, u.last_reminder_push
     FROM users u JOIN push_subscriptions p ON p.user_id = u.id
     WHERE u.reminder_hour = ?`,
    hour,
  );
  let notified = 0;
  let skippedRecorded = 0;
  for (const u of users) {
    if (u.last_reminder_push === today) continue; // 1日1回
    // 今日すでに記録している人には送らない（定期の自動計上は「記録した」に数えない）
    const recorded = Number(
      (
        (await d.get<{ c: number }>(
          "SELECT (SELECT COUNT(*) FROM expenses WHERE user_id = ? AND date = ? AND source != 'recurring') + (SELECT COUNT(*) FROM incomes WHERE user_id = ? AND date = ? AND type != 'recurring') AS c",
          u.id,
          today,
          u.id,
          today,
        )) as { c: number }
      ).c,
    );
    if (recorded > 0) {
      skippedRecorded++;
      continue;
    }
    await postRecurringForMonth(u.id, currentMonth());
    // 「今日あと使える額」を添えて、開く理由をつくる（計算できないときは本文だけ）
    let tail = "";
    try {
      const month = await accountingMonth(u.id);
      const summary = await monthSummary(u.id, month);
      const budget = dailyBudget(
        summary,
        await todaySpent(u.id, today),
        u.savings_goal,
        today,
        await monthFixedCost(u.id, month),
        await getMonthStartDay(u.id),
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
      await d.run("UPDATE users SET last_reminder_push = ? WHERE id = ?", today, u.id);
      notified++;
    }
  }
  // ── 資産(口座残高)更新リマインド（同じ日次cronに相乗り） ──
  // 資産は手入力なので、任意で「毎月◯日に残高を更新しましょう」を1回だけ通知する。
  // 時刻には依存せず「今日の日（JST）」で判定し、月1回制限（last_asset_reminder）で
  // cronが日に複数回走っても重複送信しない。既定 -1(OFF) の人・口座0件の人には送らない。
  const { d: todayDay } = jstToday();
  const month = currentMonth();
  const assetTargets = await d.all<{
    id: string;
    asset_reminder_day: number;
    last_asset_reminder: string | null;
  }>(
    "SELECT id, asset_reminder_day, last_asset_reminder FROM users WHERE asset_reminder_day = ?",
    todayDay,
  );
  let assetNotified = 0;
  for (const u of assetTargets) {
    const accountCount = Number(
      (
        (await d.get<{ c: number }>(
          "SELECT COUNT(*) AS c FROM accounts WHERE user_id = ?",
          u.id,
        )) as { c: number }
      ).c,
    );
    if (
      !shouldSendAssetReminder({
        assetReminderDay: Number(u.asset_reminder_day),
        todayDay,
        lastAssetReminder: u.last_asset_reminder,
        currentMonth: month,
        accountCount,
      })
    ) {
      continue;
    }
    const sent = await pushToUser(
      u.id,
      "CashSync 残高の更新",
      "口座残高を更新して純資産を最新にしましょう",
    );
    if (sent > 0) {
      await d.run("UPDATE users SET last_asset_reminder = ? WHERE id = ?", month, u.id);
      assetNotified++;
    }
  }

  return Response.json({
    ok: true,
    hour,
    targets: users.length,
    notified,
    skippedRecorded,
    assetTargets: assetTargets.length,
    assetNotified,
  });
}
