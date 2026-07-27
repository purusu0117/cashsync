// ユーザー単位の設定（貯金目標・ショートカット連携トークン・AI残量など）
import { getAiUsage } from "@/lib/aiUsage";
import { AuthError, ensureApiToken, requireUser, unauthorized } from "@/lib/auth";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const user = await requireUser();
    const row = db()
      .prepare("SELECT savings_goal, month_start_day, reminder_hour FROM users WHERE id = ?")
      .get(user.id) as
      | { savings_goal: number; month_start_day: number; reminder_hour: number }
      | undefined;
    // B12: プランと今月のAI使用量（設定のプラン欄・スキャン画面の残量表示用）
    const usage = getAiUsage(user.id);
    return Response.json({
      savingsGoal: row?.savings_goal ?? 0,
      // B9: 家計簿の月の開始日（1〜28。デフォルト1＝カレンダー月）
      monthStartDay: row?.month_start_day ?? 1,
      // C3: 記録リマインダーの時刻（0〜23時。-1＝OFF）
      reminderHour: row?.reminder_hour ?? -1,
      apiToken: ensureApiToken(user.id),
      plan: usage.plan,
      aiUsage: { scans: usage.scans, parses: usage.parses },
    });
  } catch (e) {
    if (e instanceof AuthError) return unauthorized();
    return Response.json({ error: String(e) }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const user = await requireUser();
    const body = (await request.json()) as {
      savingsGoal?: number;
      monthStartDay?: number;
      reminderHour?: number; // C3: 0〜23＝その時刻に通知、-1＝OFF
    };
    if (body.savingsGoal !== undefined) {
      const goal = Math.max(0, Math.round(Number(body.savingsGoal) || 0));
      db().prepare("UPDATE users SET savings_goal = ? WHERE id = ?").run(goal, user.id);
    }
    // B9: 月の開始日（1〜28のみ許可。29〜31は月によって存在しないため不可）
    if (body.monthStartDay !== undefined) {
      const day = Math.round(Number(body.monthStartDay) || 1);
      if (day < 1 || day > 28) {
        return Response.json(
          { error: "月の開始日は1〜28日の間で設定してください。" },
          { status: 400 },
        );
      }
      db().prepare("UPDATE users SET month_start_day = ? WHERE id = ?").run(day, user.id);
    }
    // C3: 記録リマインダーの時刻（0〜23。-1でOFF。それ以外の値は弾く）
    if (body.reminderHour !== undefined) {
      const hour = Math.round(Number(body.reminderHour));
      if (!Number.isFinite(hour) || hour < -1 || hour > 23) {
        return Response.json({ error: "リマインダーの時刻が不正です。" }, { status: 400 });
      }
      db().prepare("UPDATE users SET reminder_hour = ? WHERE id = ?").run(hour, user.id);
    }
    return Response.json({ ok: true });
  } catch (e) {
    if (e instanceof AuthError) return unauthorized();
    return Response.json({ error: String(e) }, { status: 500 });
  }
}
