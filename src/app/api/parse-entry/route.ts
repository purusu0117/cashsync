// 自然文（「昨日セブンで昼飯650円」）→ 支出レコード案。保存は確認後にクライアントが行う。
import { EMAIL_UNVERIFIED_MESSAGE, emailVerificationRequired, isUserVerified } from "@/lib/account";
import { askClaudeParseEntry } from "@/lib/ai";
import { checkAndCountUsage, getUserPlan, limitResponseBody } from "@/lib/aiUsage";
import { AuthError, requireUser, unauthorized } from "@/lib/auth";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

export async function POST(request: Request) {
  try {
    const user = await requireUser();
    // 不正対策①（フラグ制御）: 確認必須ON時のみ、未確認ユーザーのAIコスト系を拒否（無料枠farming防止）。
    if (emailVerificationRequired() && !(await isUserVerified(user.id))) {
      return Response.json({ error: "unverified", message: EMAIL_UNVERIFIED_MESSAGE }, { status: 403 });
    }
    const { text } = (await request.json()) as { text?: string };
    if (!text || !text.trim()) {
      return Response.json({ error: "テキストを入力してください。" }, { status: 400 });
    }
    const plan = await getUserPlan(user.id);
    const usage = await checkAndCountUsage(user.id, plan, "parses");
    if (!usage.allowed) {
      return Response.json(limitResponseBody("parses", usage, plan), { status: 429 });
    }
    const d = await db();
    const categories = await d.all<{ id: string; name: string }>(
      "SELECT id, name FROM categories WHERE user_id = ? ORDER BY sort",
      user.id,
    );
    const parsed = await askClaudeParseEntry(
      text.trim(),
      categories.map((c) => c.name),
      plan,
    );
    const category = categories.find((c) => c.name === parsed.category);
    return Response.json({ parsed, categoryId: category?.id ?? null });
  } catch (e) {
    if (e instanceof AuthError) return unauthorized();
    return Response.json(
      { error: e instanceof Error ? e.message : "parse failed" },
      { status: 500 },
    );
  }
}
