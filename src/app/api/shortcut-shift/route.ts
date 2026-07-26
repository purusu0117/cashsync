// iPhoneショートカット用のワンショットAPI：
// 音声入力（ディクテーション）したテキストを受け取り → AI解析 → シフトをそのまま自動登録 → 結果メッセージを返す。
// どのアプリを開いていても、アクションボタン/背面タップ等のショートカットから一言でシフトを入れられる
// （Webアプリはバックグラウンドでマイクを使えないため、その代替手段）。
// 認証は shortcut-scan と同じ Authorization: Bearer <api_token>。
import { askClaudeParseShifts } from "@/lib/ai";
import { checkAndCountUsage, getUserPlan, limitMessage } from "@/lib/aiUsage";
import { userFromBearer } from "@/lib/auth";
import { db, uid } from "@/lib/db";
import { fmtDateJa, minToHHMM } from "@/lib/format";

export const dynamic = "force-dynamic";
export const maxDuration = 180;

export async function POST(request: Request) {
  try {
    // 注意: ok は boolean ではなく文字列 "true"/"false" で返す（iOSショートカットのif文対策・shortcut-scanと同じ）。
    const user = await userFromBearer(request);
    if (!user) {
      return Response.json(
        { ok: "false", message: "認証エラー：設定画面のトークンをショートカットに設定してください。" },
        { status: 401 },
      );
    }
    const { text } = (await request.json()) as { text?: string };
    if (!text || !text.trim()) {
      // 音声入力中に画面を離れる/無言のままだと、空テキストが送られてくる
      return Response.json(
        { ok: "false", message: "音声を聞き取れませんでした。音声入力が出たらすぐ話し、話し終わるまで画面はそのままにしてください。" },
        { status: 400 },
      );
    }
    const plan = await getUserPlan(user.id);
    const usage = await checkAndCountUsage(user.id, plan, "parses");
    if (!usage.allowed) {
      return Response.json(
        { ok: "false", error: "limit", message: limitMessage("parses", plan) },
        { status: 429 },
      );
    }
    const d = await db();
    const jobs = await d.all<{ id: string; name: string }>(
      "SELECT id, name FROM jobs WHERE user_id = ?",
      user.id,
    );
    if (jobs.length === 0) {
      return Response.json(
        { ok: "false", message: "先にアプリでバイト先を登録してください。" },
        { status: 400 },
      );
    }
    const shifts = await askClaudeParseShifts(text.trim(), jobs, plan);
    if (shifts.length === 0) {
      return Response.json(
        { ok: "false", message: "シフトを読み取れませんでした。日付と時間を含めて話してください。" },
        { status: 422 },
      );
    }
    const names = new Map(jobs.map((j) => [j.id, j.name]));
    const lines: string[] = [];
    for (const s of shifts) {
      const jobId = s.jobId ?? jobs[0].id; // バイト先を言っていなければ最初のバイト先
      // 同じバイト先×同じ日の既存シフトは置き換え（言い直しで二重登録しない。別バイトの掛け持ちは残す）
      await d.run(
        "DELETE FROM shifts WHERE user_id = ? AND job_id = ? AND date = ?",
        user.id,
        jobId,
        s.date,
      );
      await d.run(
        "INSERT INTO shifts (id, user_id, job_id, date, start_min, end_min, break_min, source) VALUES (?, ?, ?, ?, ?, ?, 0, 'manual')",
        uid(),
        user.id,
        jobId,
        s.date,
        s.startMin,
        s.endMin,
      );
      lines.push(
        `${fmtDateJa(s.date)} ${minToHHMM(s.startMin)}〜${minToHHMM(s.endMin)}${jobs.length > 1 ? `（${names.get(jobId)}）` : ""}`,
      );
    }
    return Response.json({
      ok: "true",
      message: `✅ シフト${lines.length}件を登録しました\n${lines.join("\n")}`,
    });
  } catch (e) {
    console.error("[shortcut-shift] failed:", e); // server.logに残す（原因調査用）
    return Response.json(
      { ok: "false", message: `登録に失敗しました：${e instanceof Error ? e.message : "エラー"}` },
      { status: 500 },
    );
  }
}
