// 袋分けポケット：カテゴリ別の月予算と今月の消化状況。
import { AuthError, requireUser, unauthorized } from "@/lib/auth";
import { db } from "@/lib/db";
import { currentMonth } from "@/lib/money";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const user = await requireUser();
    const month = currentMonth();
    const d = await db();
    const rows = await d.all(
      `SELECT c.id, c.name, c.icon, COALESCE(b.amount, 0) AS budget,
              COALESCE((SELECT SUM(e.amount) FROM expenses e WHERE e.user_id = c.user_id AND e.category_id = c.id AND e.date LIKE ?), 0) AS spent
       FROM categories c
       LEFT JOIN category_budgets b ON b.category_id = c.id AND b.user_id = c.user_id
       WHERE c.user_id = ? ORDER BY c.sort`,
      `${month}-%`,
      user.id,
    );
    return Response.json({ month, pockets: rows });
  } catch (e) {
    if (e instanceof AuthError) return unauthorized();
    return Response.json({ error: String(e) }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const user = await requireUser();
    const body = (await request.json()) as { categoryId?: string; amount?: number };
    if (!body.categoryId) return Response.json({ error: "categoryId required" }, { status: 400 });
    const d = await db();
    const cat = await d.get(
      "SELECT id FROM categories WHERE id = ? AND user_id = ?",
      body.categoryId,
      user.id,
    );
    if (!cat) return Response.json({ error: "カテゴリが見つかりません。" }, { status: 400 });
    const amount = Math.max(0, Math.round(Number(body.amount) || 0));
    if (amount === 0) {
      await d.run(
        "DELETE FROM category_budgets WHERE user_id = ? AND category_id = ?",
        user.id,
        body.categoryId,
      );
    } else {
      await d.run(
        "INSERT INTO category_budgets (user_id, category_id, amount) VALUES (?, ?, ?) ON CONFLICT (user_id, category_id) DO UPDATE SET amount = excluded.amount",
        user.id,
        body.categoryId,
        amount,
      );
    }
    return Response.json({ ok: true });
  } catch (e) {
    if (e instanceof AuthError) return unauthorized();
    return Response.json({ error: String(e) }, { status: 500 });
  }
}
