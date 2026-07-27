// 定期支出/収入（サブスク・家賃・仕送り等）。前作の fixedExpenses + revolving + monthlyOtherIncome を統合。
import { AuthError, requireUser, unauthorized } from "@/lib/auth";
import { db, uid } from "@/lib/db";
import { currentMonth } from "@/lib/money";

export const dynamic = "force-dynamic";

const MONTH_RE = /^\d{4}-\d{2}$/;

export async function GET() {
  try {
    const user = await requireUser();
    const d = await db();
    const items = await d.all(
      `SELECT r.id, r.kind, r.name, r.amount, r.category_id, r.start_month, r.end_month, r.post_day, r.interval, r.is_fixed, c.name AS category
       FROM recurring_items r LEFT JOIN categories c ON c.id = r.category_id
       WHERE r.user_id = ? ORDER BY r.kind, r.name`,
      user.id,
    );
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
      interval?: string;
      isFixed?: boolean; // C12: false=変動費扱い（既定は固定費）
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
    const interval = body.interval === "yearly" ? "yearly" : "monthly";
    const isFixed = body.isFixed === false ? 0 : 1; // C12: 既定は固定費
    const id = uid();
    const d = await db();
    await d.run(
      "INSERT INTO recurring_items (id, user_id, kind, name, amount, category_id, start_month, end_month, post_day, interval, is_fixed) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      id,
      user.id,
      kind,
      name,
      amount,
      body.categoryId ?? null,
      startMonth,
      endMonth,
      postDay,
      interval,
      isFixed,
    );
    return Response.json({ ok: true, id });
  } catch (e) {
    if (e instanceof AuthError) return unauthorized();
    return Response.json({ error: String(e) }, { status: 500 });
  }
}

// C12: 固定費/変動費フラグの切り替え（一覧のタグをタップで反転）
export async function PUT(request: Request) {
  try {
    const user = await requireUser();
    const body = (await request.json()) as { id?: string; isFixed?: boolean };
    if (!body.id || typeof body.isFixed !== "boolean") {
      return Response.json({ error: "id と isFixed は必須です。" }, { status: 400 });
    }
    const d = await db();
    await d.run(
      "UPDATE recurring_items SET is_fixed = ? WHERE id = ? AND user_id = ?",
      body.isFixed ? 1 : 0,
      body.id,
      user.id,
    );
    return Response.json({ ok: true });
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
    await d.run("DELETE FROM recurring_items WHERE id = ? AND user_id = ?", id, user.id);
    // 計上済みレコードはそのまま残す（履歴の事実は消さない）
    return Response.json({ ok: true });
  } catch (e) {
    if (e instanceof AuthError) return unauthorized();
    return Response.json({ error: String(e) }, { status: 500 });
  }
}
