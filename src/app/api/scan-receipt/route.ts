// レシート写真 → AIが店名・日付・合計・カテゴリ・品目を抽出（CookSync scan-fridge のフローを流用）。
// 保存はしない：クライアントの確認シートで人間が最終確定してから /api/expenses に POST する。
import { promises as fs } from "fs";
import os from "os";
import path from "path";
import { askClaudeReceipt } from "@/lib/ai";
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
      return Response.json(limitResponseBody("scans", usage), { status: 429 });
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
    const scan = await askClaudeReceipt(
      tmp,
      categories.map((c) => c.name),
      plan,
    );
    const category = categories.find((c) => c.name === scan.category);
    return Response.json({ scan, categoryId: category?.id ?? null });
  } catch (e) {
    if (e instanceof AuthError) return unauthorized();
    return Response.json(
      { error: e instanceof Error ? e.message : "scan failed" },
      { status: 500 },
    );
  } finally {
    if (tmp) await fs.rm(tmp, { force: true }).catch(() => {});
  }
}
