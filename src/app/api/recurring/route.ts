// 定期支出/収入（サブスク・家賃・仕送り等）。前作の fixedExpenses + revolving + monthlyOtherIncome を統合。
import { AuthError, requireUser, unauthorized } from "@/lib/auth";
import { db, uid } from "@/lib/db";
import { currentMonth } from "@/lib/money";

export const dynamic = "force-dynamic";

const MONTH_RE = /^\d{4}-\d{2}$/;

export async function GET() {
  try {
    const user = await requireUser();
    const items = db()
      .prepare(
        `SELECT r.id, r.kind, r.name, r.amount, r.category_id, r.start_month, r.end_month, r.post_day, c.name AS category
         FROM recurring_items r LEFT JOIN categories c ON c.id = r.category_id
         WHERE r.user_id = ? ORDER BY r.kind, r.name`,
      )
      .all(user.id);
    return Response.json({ items });
  } catch (e) {
    if (e instanceof AuthError) return unauthorized();
    return Response.json({ error: String(e) }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const user = await requireUser();
    const body = (await request.json()) as {
      kind?: string;
      name?: string;
      amount?: number;
      categoryId?: string | null;
      startMonth?: string;
      endMonth?: string | null;
      postDay?: number;
    };
    const name = (body.name ?? "").trim();
    const amount = Math.round(Number(body.amount));
    const kind = body.kind === "income" ? "income" : "expense";
    if (!name || !Number.isFinite(amount) || amount <= 0) {
      return Response.json({ error: "名前と金額は必須です。" }, { status: 400 });
    }
    const now = currentMonth();
    const startMonth = body.startMonth && MONTH_RE.test(body.startMonth) ? body.startMonth : now;
    const endMonth = body.endMonth && MONTH_RE.test(body.endMonth) ? body.endMonth : null;
    const postDay = Math.min(Math.max(1, Math.round(Number(body.postDay) || 1)), 31);
    const id = uid();
    db()
      .prepare(
        "INSERT INTO recurring_items (id, user_id, kind, name, amount, category_id, start_month, end_month, post_day) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(id, user.id, kind, name, amount, body.categoryId ?? null, startMonth, endMonth, postDay);
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
    db().prepare("DELETE FROM recurring_items WHERE id = ? AND user_id = ?").run(id, user.id);
    // 計上済みレコードはそのまま残す（履歴の事実は消さない）
    return Response.json({ ok: true });
  } catch (e) {
    if (e instanceof AuthError) return unauthorized();
    return Response.json({ error: String(e) }, { status: 500 });
  }
}
