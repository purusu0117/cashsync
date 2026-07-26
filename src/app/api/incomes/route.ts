import { AuthError, requireUser, unauthorized } from "@/lib/auth";
import { db, uid } from "@/lib/db";
import { DUPLICATE_MESSAGE, duplicateIncomeExists } from "@/lib/merchant";
import { todayStr } from "@/lib/money";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const user = await requireUser();
    const month = new URL(request.url).searchParams.get("month") ?? todayStr().slice(0, 7);
    const incomes = db()
      .prepare(
        "SELECT id, date, amount, type, memo FROM incomes WHERE user_id = ? AND date LIKE ? ORDER BY date DESC",
      )
      .all(user.id, `${month}-%`);
    return Response.json({ incomes });
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
      memo?: string;
      dedupe?: boolean; // スキャン保存だけ true（手入力の意図的な同額連続入力は妨げない）
    };
    const amount = Math.round(Number(body.amount));
    if (!Number.isFinite(amount) || amount <= 0) {
      return Response.json({ error: "金額を入力してください。" }, { status: 400 });
    }
    const date = body.date && /^\d{4}-\d{2}-\d{2}$/.test(body.date) ? body.date : todayStr();
    if (body.dedupe && duplicateIncomeExists(user.id, date, amount, (body.memo ?? "").trim())) {
      return Response.json({ error: DUPLICATE_MESSAGE }, { status: 409 });
    }
    const id = uid();
    db()
      .prepare(
        "INSERT INTO incomes (id, user_id, date, amount, type, memo, created_at) VALUES (?, ?, ?, ?, 'other', ?, ?)",
      )
      .run(id, user.id, date, amount, (body.memo ?? "").trim(), Date.now());
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
    db().prepare("DELETE FROM incomes WHERE id = ? AND user_id = ?").run(id, user.id);
    return Response.json({ ok: true });
  } catch (e) {
    if (e instanceof AuthError) return unauthorized();
    return Response.json({ error: String(e) }, { status: 500 });
  }
}
