import { AuthError, requireUser, unauthorized } from "@/lib/auth";
import { db, uid } from "@/lib/db";
import { learnMerchantCategory } from "@/lib/merchant";
import { postRecurringForMonth, todayStr } from "@/lib/money";

export const dynamic = "force-dynamic";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** categoryId が本人のものでなければ null に落とす（他ユーザーIDの混入防止） */
function ownCategoryId(userId: string, categoryId?: string | null): string | null {
  if (!categoryId) return null;
  const row = db()
    .prepare("SELECT id FROM categories WHERE id = ? AND user_id = ?")
    .get(categoryId, userId);
  return row ? categoryId : null;
}

export async function GET(request: Request) {
  try {
    const user = await requireUser();
    postRecurringForMonth(user.id, todayStr().slice(0, 7)); // ホーム未訪問でも定期計上が欠けないように
    const month = new URL(request.url).searchParams.get("month") ?? todayStr().slice(0, 7);
    const rows = db()
      .prepare(
        `SELECT e.id, e.date, e.amount, e.memo, e.source, e.category_id, e.receipt_id, c.name AS category, c.icon
         FROM expenses e LEFT JOIN categories c ON c.id = e.category_id AND c.user_id = e.user_id
         WHERE e.user_id = ? AND e.date LIKE ? ORDER BY e.date DESC, e.created_at DESC`,
      )
      .all(user.id, `${month}-%`);
    return Response.json({ expenses: rows });
  } catch (e) {
    if (e instanceof AuthError) return unauthorized();
    return Response.json({ error: String(e) }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const user = await requireUser();
    const body = (await request.json()) as {
      date?: string;
      amount?: number;
      categoryId?: string | null;
      memo?: string;
      source?: string;
      receiptId?: string | null;
    };
    const amount = Math.round(Number(body.amount));
    if (!Number.isFinite(amount) || amount <= 0) {
      return Response.json({ error: "金額を入力してください。" }, { status: 400 });
    }
    const date = body.date && DATE_RE.test(body.date) ? body.date : todayStr();
    const source = ["manual", "receipt", "voice", "quick", "recurring", "text"].includes(
      body.source ?? "",
    )
      ? (body.source as string)
      : "manual";
    const categoryId = ownCategoryId(user.id, body.categoryId);
    const id = uid();
    db()
      .prepare(
        "INSERT INTO expenses (id, user_id, date, amount, category_id, memo, source, receipt_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        id,
        user.id,
        date,
        amount,
        categoryId,
        (body.memo ?? "").trim(),
        source,
        body.receiptId ?? null,
        Date.now(),
      );
    return Response.json({ ok: true, id });
  } catch (e) {
    if (e instanceof AuthError) return unauthorized();
    return Response.json({ error: String(e) }, { status: 500 });
  }
}

export async function PUT(request: Request) {
  try {
    const user = await requireUser();
    const body = (await request.json()) as {
      id?: string;
      date?: string;
      amount?: number;
      categoryId?: string | null;
      memo?: string;
    };
    if (!body.id) return Response.json({ error: "id required" }, { status: 400 });
    const amount = Math.round(Number(body.amount));
    if (!Number.isFinite(amount) || amount <= 0) {
      return Response.json({ error: "金額を入力してください。" }, { status: 400 });
    }
    const date = body.date && DATE_RE.test(body.date) ? body.date : todayStr();
    const categoryId = ownCategoryId(user.id, body.categoryId);
    const memo = (body.memo ?? "").trim();
    const prev = db()
      .prepare("SELECT category_id FROM expenses WHERE id = ? AND user_id = ?")
      .get(body.id, user.id) as unknown as { category_id: string | null } | undefined;
    db()
      .prepare(
        "UPDATE expenses SET date = ?, amount = ?, category_id = ?, memo = ? WHERE id = ? AND user_id = ?",
      )
      .run(date, amount, categoryId, memo, body.id, user.id);
    // マーチャント学習の入口②：履歴の編集でカテゴリを変えた＝この店（memo）の正解を教えてもらった
    if (prev && categoryId && categoryId !== prev.category_id && memo) {
      learnMerchantCategory(user.id, memo, categoryId);
    }
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
    db().prepare("DELETE FROM expenses WHERE id = ? AND user_id = ?").run(id, user.id);
    return Response.json({ ok: true });
  } catch (e) {
    if (e instanceof AuthError) return unauthorized();
    return Response.json({ error: String(e) }, { status: 500 });
  }
}
