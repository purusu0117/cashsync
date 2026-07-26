// ユーザー単位の設定（貯金目標・ショートカット連携トークンなど）
import { AuthError, ensureApiToken, requireUser, unauthorized } from "@/lib/auth";
import { normalizePlan } from "@/lib/aiUsage";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const user = await requireUser();
    const d = await db();
    const row = await d.get<{ savings_goal: number; plan: string | null }>(
      "SELECT savings_goal, plan FROM users WHERE id = ?",
      user.id,
    );
    return Response.json({
      savingsGoal: row?.savings_goal ?? 0,
      plan: normalizePlan(row?.plan),
      apiToken: await ensureApiToken(user.id),
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
    const d = await db();
    await d.run("UPDATE users SET savings_goal = ? WHERE id = ?", goal, user.id);
    return Response.json({ ok: true, savingsGoal: goal });
  } catch (e) {
    if (e instanceof AuthError) return unauthorized();
    return Response.json({ error: String(e) }, { status: 500 });
  }
}
