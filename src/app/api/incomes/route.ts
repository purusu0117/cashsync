import { AuthError, requireUser, unauthorized } from "@/lib/auth";
import { db, uid } from "@/lib/db";
import { DUPLICATE_MESSAGE, duplicateIncomeExists } from "@/lib/merchant";
import { monthRange, todayStr } from "@/lib/money";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const user = await requireUser();
    const month = new URL(request.url).searchParams.get("month") ?? todayStr().slice(0, 7);
    // B9: 「月」は締め日基準の集計期間（開始日1なら従来のカレンダー月と同一）
    const range = await monthRange(user.id, month);
    const d = await db();
    const incomes = await d.all(
      "SELECT id, date, amount, type, memo FROM incomes WHERE user_id = ? AND date >= ? AND date <= ? ORDER BY date DESC",
      user.id,
      range.start,
      range.end,
    );
    return Response.json({ incomes, range });
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
      allowDuplicate?: boolean; // 409後にユーザーが「本当に別の受け取り」と確認した再送信のみ true
    };
    const amount = Math.round(Number(body.amount));
    if (!Number.isFinite(amount) || amount <= 0) {
      return Response.json({ error: "金額を入力してください。" }, { status: 400 });
    }
    const date = body.date && /^\d{4}-\d{2}-\d{2}$/.test(body.date) ? body.date : todayStr();
    // 完全拒否にはしない：クライアントが409を受けてユーザーに確認 → allowDuplicate: true なら保存する
    if (
      body.dedupe &&
      !body.allowDuplicate &&
      (await duplicateIncomeExists(user.id, date, amount, (body.memo ?? "").trim()))
    ) {
      return Response.json({ error: DUPLICATE_MESSAGE, duplicate: true }, { status: 409 });
    }
    const id = uid();
    const d = await db();
    await d.run(
      "INSERT INTO incomes (id, user_id, date, amount, type, memo, created_at) VALUES (?, ?, ?, ?, 'other', ?, ?)",
      id,
      user.id,
      date,
      amount,
      (body.memo ?? "").trim(),
      Date.now(),
    );
    return Response.json({ ok: true, id });
  } catch (e) {
    if (e instanceof AuthError) return unauthorized();
    return Response.json({ error: String(e) }, { status: 500 });
  }
}

// C8: 収入の編集（金額・日付・メモ）。支出の編集シートと同等の操作を提供する
export async function PUT(request: Request) {
  try {
    const user = await requireUser();
    const body = (await request.json()) as {
      id?: string;
      date?: string;
      amount?: number;
      memo?: string;
    };
    if (!body.id) return Response.json({ error: "id required" }, { status: 400 });
    const amount = Math.round(Number(body.amount));
    if (!Number.isFinite(amount) || amount <= 0) {
      return Response.json({ error: "金額を入力してください。" }, { status: 400 });
    }
    const date = body.date && /^\d{4}-\d{2}-\d{2}$/.test(body.date) ? body.date : todayStr();
    const d = await db();
    await d.run(
      "UPDATE incomes SET date = ?, amount = ?, memo = ? WHERE id = ? AND user_id = ?",
      date,
      amount,
      (body.memo ?? "").trim(),
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
    await d.run("DELETE FROM incomes WHERE id = ? AND user_id = ?", id, user.id);
    return Response.json({ ok: true });
  } catch (e) {
    if (e instanceof AuthError) return unauthorized();
    return Response.json({ error: String(e) }, { status: 500 });
  }
}
