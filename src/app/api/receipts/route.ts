// 確認シートで確定したレシートを保存：receipts 1件 ＋ expenses 1件（レシート1枚=支出1レコード）。
import { AuthError, requireUser, unauthorized } from "@/lib/auth";
import { db, uid } from "@/lib/db";
import { fmtYen } from "@/lib/format";
import { pushRecordResult } from "@/lib/push";
import {
  DUPLICATE_MESSAGE,
  duplicateExpenseExists,
  learnMerchantCategory,
} from "@/lib/merchant";
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
      suggestedCategoryId?: string | null; // 確認シートに最初に表示した提案（AI or 学習値）
      items?: { name: string; price: number }[];
      allowDuplicate?: boolean; // 409後にユーザーが「本当に別の支払い」と確認した再送信のみ true
      imageHash?: string; // 読み取った画像のsha256（同じ画像の二度読み判定用）
    };
    const total = Math.round(Number(body.total));
    if (!Number.isFinite(total) || total <= 0) {
      return Response.json({ error: "合計金額を入力してください。" }, { status: 400 });
    }
    const date =
      body.date && /^\d{4}-\d{2}-\d{2}$/.test(body.date) ? body.date : todayStr();
    const store = (body.store ?? "").trim();
    const items = Array.isArray(body.items) ? body.items.slice(0, 30) : [];
    // スキャン保存の二重登録ガード（同じスクショを2回読ませた等）。手入力(/add)はこのAPIを通らない。
    // 本当に同じものを2回買うこともあるので完全拒否にはせず、
    // クライアントが409を受けてユーザーに確認 → allowDuplicate: true で再送信したら保存する。
    if (!body.allowDuplicate && (await duplicateExpenseExists(user.id, date, total, store))) {
      return Response.json({ error: DUPLICATE_MESSAGE, duplicate: true }, { status: 409 });
    }
    const d = await db();
    const receiptId = uid();
    const expenseId = uid();
    // レシートと支出は必ずセットで保存（片方だけ残る中途半端な状態を防ぐ）
    try {
      await d.transaction(async (tx) => {
        await tx.run(
          "INSERT INTO receipts (id, user_id, store, taken_date, total, items_json, image_hash, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
          receiptId,
          user.id,
          store,
          date,
          total,
          JSON.stringify(items),
          (body.imageHash ?? "").trim() || null,
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
    // マーチャント学習の入口①：確認シートで提案と違うカテゴリに変えて保存した＝この店の正解を教えてもらった
    if (
      "suggestedCategoryId" in body &&
      body.categoryId &&
      body.categoryId !== (body.suggestedCategoryId ?? null) &&
      store
    ) {
      await learnMerchantCategory(user.id, store, body.categoryId);
    }
    // 記録できたことを通知（設定でOFFにできる）。画面を閉じた後に保存が終わるケースの取りこぼし対策
    await pushRecordResult(
      user.id,
      "CashSync 記録しました",
      `✅${fmtYen(total)}（${store || "店名なし"}）を記録しました`,
    ).catch(() => {});
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
