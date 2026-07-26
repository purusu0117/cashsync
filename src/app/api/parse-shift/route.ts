// 自然文（「キミハンで明日18時から22時半」「来週金曜17時から閉めまで」）→ シフト案。保存は確認後。
// どのバイト先かも聞き分けて jobId を返す（言っていなければ null → クライアント側でデフォルト）。
import { askClaudeParseShifts } from "@/lib/ai";
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
    const jobs = db()
      .prepare("SELECT id, name FROM jobs WHERE user_id = ?")
      .all(user.id) as unknown as { id: string; name: string }[];
    const shifts = await askClaudeParseShifts(text.trim(), jobs);
    if (shifts.length === 0) {
      return Response.json({ error: "シフトを読み取れませんでした。日付と時間を含めて話してみてください。" }, { status: 422 });
    }
    return Response.json({ shifts, defaultJobId: jobs[0]?.id ?? null });
  } catch (e) {
    if (e instanceof AuthError) return unauthorized();
    return Response.json(
      { error: e instanceof Error ? e.message : "parse failed" },
      { status: 500 },
    );
  }
}
