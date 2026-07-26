// 確認シートで確定したレシートを保存：receipts 1件 ＋ expenses 1件（レシート1枚=支出1レコード）。
import { AuthError, requireUser, unauthorized } from "@/lib/auth";
import { db, uid } from "@/lib/db";
import { todayStr } from "@/lib/money";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const user = await requireUser();
    const body = (await request.json()) as {
      store?: string;
      date?: string;
      total?: number;
      categoryId?: string | null;
      items?: { name: string; price: number }[];
    };
    const total = Math.round(Number(body.total));
    if (!Number.isFinite(total) || total <= 0) {
      return Response.json({ error: "合計金額を入力してください。" }, { status: 400 });
    }
    const date =
      body.date && /^\d{4}-\d{2}-\d{2}$/.test(body.date) ? body.date : todayStr();
    const store = (body.store ?? "").trim();
    const items = Array.isArray(body.items) ? body.items.slice(0, 30) : [];
    const d = await db();
    const receiptId = uid();
    const expenseId = uid();
    // レシートと支出は必ずセットで保存（片方だけ残る中途半端な状態を防ぐ）
    try {
      await d.transaction(async (tx) => {
        await tx.run(
          "INSERT INTO receipts (id, user_id, store, taken_date, total, items_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
          receiptId,
          user.id,
          store,
          date,
          total,
          JSON.stringify(items),
          Date.now(),
        );
        await tx.run(
          "INSERT INTO expenses (id, user_id, date, amount, category_id, memo, source, receipt_id, created_at) VALUES (?, ?, ?, ?, ?, ?, 'receipt', ?, ?)",
          expenseId,
          user.id,
          date,
          total,
          body.categoryId ?? null,
          store,
          receiptId,
          Date.now(),
        );
      });
    } catch (e) {
      console.error("[receipts] save failed:", e);
      throw e;
    }
    return Response.json({ ok: true, receiptId, expenseId });
  } catch (e) {
    if (e instanceof AuthError) return unauthorized();
    return Response.json({ error: String(e) }, { status: 500 });
  }
}

export async function GET(request: Request) {
  try {
    const user = await requireUser();
    const id = new URL(request.url).searchParams.get("id");
    if (!id) return Response.json({ error: "id required" }, { status: 400 });
    const d = await db();
    const row = await d.get(
      "SELECT id, store, taken_date, total, items_json FROM receipts WHERE id = ? AND user_id = ?",
      id,
      user.id,
    );
    return Response.json({ receipt: row ?? null });
  } catch (e) {
    if (e instanceof AuthError) return unauthorized();
    return Response.json({ error: String(e) }, { status: 500 });
  }
}
