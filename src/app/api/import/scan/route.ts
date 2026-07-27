// C2: 乗り換えインポート②（他アプリ画面のスクショをAI読取）。
// 既存のレシート読取と違い、画面内の【明細リスト】を複数件の配列で返す。
// 保存はしない：プレビューで選択 → /api/import/commit で確定。
// AI回数は通常のスキャンと同じ枠を消費する（free=月30回・premium/founder=無制限相当）。
import { promises as fs } from "fs";
import os from "os";
import path from "path";
import { askClaudeImportList } from "@/lib/ai";
import { checkAndCountUsage, getUserPlan, limitResponseBody } from "@/lib/aiUsage";
import { AuthError, requireUser, unauthorized } from "@/lib/auth";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";
export const maxDuration = 180;

export async function POST(request: Request) {
  let tmp = "";
  try {
    const user = await requireUser();
    const plan = await getUserPlan(user.id);
    const usage = await checkAndCountUsage(user.id, plan, "scans");
    if (!usage.allowed) {
      // { ok:false, error:'limit', message:'…' }。UI側は message を優先表示する
      return Response.json(limitResponseBody("scans", usage, plan), { status: 429 });
    }
    const form = await request.formData();
    const file = form.get("image");
    if (!(file instanceof File)) {
      return Response.json({ error: "image required" }, { status: 400 });
    }
    const buf = Buffer.from(await file.arrayBuffer());
    const dir = path.join(os.tmpdir(), "cashsync-scan");
    await fs.mkdir(dir, { recursive: true });
    const ext = file.type.includes("png") ? "png" : "jpg";
    tmp = path.join(dir, `${globalThis.crypto.randomUUID()}.${ext}`);
    await fs.writeFile(tmp, buf);

    const d = await db();
    const categories = await d.all<{ id: string; name: string }>(
      "SELECT id, name FROM categories WHERE user_id = ? ORDER BY sort",
      user.id,
    );
    const entries = await askClaudeImportList(
      tmp,
      categories.map((c) => c.name),
      plan,
    );
    if (entries.length === 0) {
      return Response.json(
        { error: "明細を読み取れませんでした。明細リストが写った画面を選んでください。" },
        { status: 400 },
      );
    }
    const byName = new Map(categories.map((c) => [c.name, c.id]));
    const rows = entries.map((e) => ({
      ...e,
      categoryId: e.kind === "expense" ? (byName.get(e.category) ?? null) : null,
    }));
    return Response.json({ format: "scan", rows, skipped: 0 });
  } catch (e) {
    if (e instanceof AuthError) return unauthorized();
    return Response.json({ error: e instanceof Error ? e.message : "scan failed" }, { status: 500 });
  } finally {
    if (tmp) await fs.rm(tmp, { force: true }).catch(() => {});
  }
}
