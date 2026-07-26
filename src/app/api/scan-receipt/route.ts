// レシート写真 → AIが店名・日付・合計・カテゴリ・品目を抽出（CookSync scan-fridge のフローを流用）。
// 保存はしない：クライアントの確認シートで人間が最終確定してから /api/expenses に POST する。
import { promises as fs } from "fs";
import os from "os";
import path from "path";
import { askClaudeReceipt } from "@/lib/ai";
import { AuthError, requireUser, unauthorized } from "@/lib/auth";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";
export const maxDuration = 180;

export async function POST(request: Request) {
  let tmp = "";
  try {
    const user = await requireUser();
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

    const categories = db()
      .prepare("SELECT id, name FROM categories WHERE user_id = ? ORDER BY sort")
      .all(user.id) as unknown as { id: string; name: string }[];
    const scan = await askClaudeReceipt(
      tmp,
      categories.map((c) => c.name),
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
