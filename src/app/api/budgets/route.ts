// 袋分けポケット：カテゴリ別の月予算と今月の消化状況。
// C13: carryover=1 のカテゴリは前月の余り（予算−支出・0下限）を当月予算に加算表示する。
import { AuthError, requireUser, unauthorized } from "@/lib/auth";
import { db } from "@/lib/db";
import { currentMonth, pocketBudgets } from "@/lib/money";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const user = await requireUser();
    const month = currentMonth();
    return Response.json({ month, pockets: await pocketBudgets(user.id, month) });
  } catch (e) {
    if (e instanceof AuthError) return unauthorized();
    return Response.json({ error: String(e) }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const user = await requireUser();
    const body = (await request.json()) as {
      categoryId?: string;
      amount?: number;
      carryover?: boolean; // C13: 前月の余りを繰り越すか
    };
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
      const carryover = body.carryover ? 1 : 0; // C13: 前月の余りを繰り越すか
      await d.run(
        "INSERT INTO category_budgets (user_id, category_id, amount, carryover) VALUES (?, ?, ?, ?) ON CONFLICT (user_id, category_id) DO UPDATE SET amount = excluded.amount, carryover = excluded.carryover",
        user.id,
        body.categoryId,
        amount,
        carryover,
      );
    }
    return Response.json({ ok: true });
  } catch (e) {
    if (e instanceof AuthError) return unauthorized();
    return Response.json({ error: String(e) }, { status: 500 });
  }
}
