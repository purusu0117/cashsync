import { AuthError, requireUser, unauthorized } from "@/lib/auth";
import { DEFAULT_CATEGORY_ICON, isCategoryIconKey, stripCategoryEmoji } from "@/lib/categoryIcons";
import { db, uid } from "@/lib/db";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const user = await requireUser();
    const d = await db();
    const categories = await d.all(
      "SELECT id, name, icon, sort FROM categories WHERE user_id = ? ORDER BY sort",
      user.id,
    );
    return Response.json({ categories });
  } catch (e) {
    if (e instanceof AuthError) return unauthorized();
    return Response.json({ error: String(e) }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const user = await requireUser();
    const body = (await request.json()) as { name?: string; icon?: string };
    // 名前の絵文字は保存前に除去（UI/AIプロンプトとも絵文字なしで統一）
    const name = stripCategoryEmoji((body.name ?? "").trim());
    if (!name) return Response.json({ error: "名前は必須です。" }, { status: 400 });
    // icon はアイコンキーのみ受け付ける（旧クライアントの絵文字はデフォルトのタグに落とす）
    const icon = isCategoryIconKey((body.icon ?? "").trim())
      ? (body.icon ?? "").trim()
      : DEFAULT_CATEGORY_ICON;
    const d = await db();
    const max = (await d.get<{ m: number }>(
      "SELECT COALESCE(MAX(sort), -1) AS m FROM categories WHERE user_id = ?",
      user.id,
    )) as { m: number };
    const id = uid();
    await d.run(
      "INSERT INTO categories (id, user_id, name, icon, sort) VALUES (?, ?, ?, ?, ?)",
      id,
      user.id,
      name,
      icon,
      max.m + 1,
    );
    return Response.json({ ok: true, id });
  } catch (e) {
    if (e instanceof AuthError) return unauthorized();
    return Response.json({ error: String(e) }, { status: 500 });
  }
}

export async function DELETE(request: Request) {
  try {
    const user = await requireUser();
    const id = new URL(request.url).searchParams.get("id");
    if (!id) return Response.json({ error: "id required" }, { status: 400 });
    const d = await db();
    await d.run("UPDATE expenses SET category_id = NULL WHERE category_id = ? AND user_id = ?", id, user.id);
    // 定期・プリセットの参照も外す（存在しないカテゴリIDでの計上を防ぐ）
    await d.run(
      "UPDATE recurring_items SET category_id = NULL WHERE category_id = ? AND user_id = ?",
      id,
      user.id,
    );
    await d.run(
      "UPDATE quick_presets SET category_id = NULL WHERE category_id = ? AND user_id = ?",
      id,
      user.id,
    );
    await d.run("DELETE FROM categories WHERE id = ? AND user_id = ?", id, user.id);
    return Response.json({ ok: true });
  } catch (e) {
    if (e instanceof AuthError) return unauthorized();
    return Response.json({ error: String(e) }, { status: 500 });
  }
}
