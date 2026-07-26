// クイック登録ボタン（よく使う支出のワンタップ記録）。
import { AuthError, requireUser, unauthorized } from "@/lib/auth";
import { db, uid } from "@/lib/db";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const user = await requireUser();
    const d = await db();
    const presets = await d.all(
      `SELECT p.id, p.label, p.amount, p.category_id, c.name AS category, c.icon
       FROM quick_presets p LEFT JOIN categories c ON c.id = p.category_id
       WHERE p.user_id = ? ORDER BY p.sort`,
      user.id,
    );
    return Response.json({ presets });
  } catch (e) {
    if (e instanceof AuthError) return unauthorized();
    return Response.json({ error: String(e) }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const user = await requireUser();
    const body = (await request.json()) as {
      label?: string;
      amount?: number;
      categoryId?: string | null;
    };
    const label = (body.label ?? "").trim();
    const amount = Math.round(Number(body.amount));
    if (!label || !Number.isFinite(amount) || amount <= 0) {
      return Response.json({ error: "ラベルと金額は必須です。" }, { status: 400 });
    }
    const d = await db();
    const max = (await d.get<{ m: number }>(
      "SELECT COALESCE(MAX(sort), -1) AS m FROM quick_presets WHERE user_id = ?",
      user.id,
    )) as { m: number };
    const id = uid();
    await d.run(
      "INSERT INTO quick_presets (id, user_id, label, amount, category_id, sort) VALUES (?, ?, ?, ?, ?, ?)",
      id,
      user.id,
      label,
      amount,
      body.categoryId ?? null,
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
    await d.run("DELETE FROM quick_presets WHERE id = ? AND user_id = ?", id, user.id);
    return Response.json({ ok: true });
  } catch (e) {
    if (e instanceof AuthError) return unauthorized();
    return Response.json({ error: String(e) }, { status: 500 });
  }
}
