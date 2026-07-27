// ユーザー単位の設定（貯金目標・ショートカット連携トークン・AI残量など）
import { getAiUsage } from "@/lib/aiUsage";
import { AuthError, ensureApiToken, requireUser, unauthorized } from "@/lib/auth";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const user = await requireUser();
    const row = db().prepare("SELECT savings_goal FROM users WHERE id = ?").get(user.id) as
      | { savings_goal: number }
      | undefined;
    // B12: プランと今月のAI使用量（設定のプラン欄・スキャン画面の残量表示用）
    const usage = getAiUsage(user.id);
    return Response.json({
      savingsGoal: row?.savings_goal ?? 0,
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
    const body = (await request.json()) as { savingsGoal?: number };
    const goal = Math.max(0, Math.round(Number(body.savingsGoal) || 0));
    db().prepare("UPDATE users SET savings_goal = ? WHERE id = ?").run(goal, user.id);
    return Response.json({ ok: true, savingsGoal: goal });
  } catch (e) {
    if (e instanceof AuthError) return unauthorized();
    return Response.json({ error: String(e) }, { status: 500 });
  }
}
