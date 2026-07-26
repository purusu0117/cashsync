// ユーザー単位の設定（貯金目標・ショートカット連携トークンなど）
import { AuthError, ensureApiToken, requireUser, unauthorized } from "@/lib/auth";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const user = await requireUser();
    const row = db().prepare("SELECT savings_goal FROM users WHERE id = ?").get(user.id) as
      | { savings_goal: number }
      | undefined;
    return Response.json({
      savingsGoal: row?.savings_goal ?? 0,
      apiToken: ensureApiToken(user.id),
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
