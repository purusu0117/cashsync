// 自然文（「昨日セブンで昼飯650円」）→ 支出レコード案。保存は確認後にクライアントが行う。
import { askClaudeParseEntry } from "@/lib/ai";
import { countUsage } from "@/lib/aiUsage";
import { AuthError, requireUser, unauthorized } from "@/lib/auth";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

export async function POST(request: Request) {
  try {
    const user = await requireUser();
    const { text } = (await request.json()) as { text?: string };
    if (!text || !text.trim()) {
      return Response.json({ error: "テキストを入力してください。" }, { status: 400 });
    }
    const categories = db()
      .prepare("SELECT id, name FROM categories WHERE user_id = ? ORDER BY sort")
      .all(user.id) as unknown as { id: string; name: string }[];
    const parsed = await askClaudeParseEntry(
      text.trim(),
      categories.map((c) => c.name),
    );
    // B12: 残量表示用に今月の文章入力（AI解析）回数を記録（mainは表示のみ・上限拒否はしない）
    countUsage(user.id, "parses");
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
