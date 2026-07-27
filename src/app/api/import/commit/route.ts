// C2: 乗り換えインポートの確定。プレビューで選択された行を一括登録する。
// 支出は source='import'、収入は type='import' で記録し、後から見分けられるようにする。
import { AuthError, requireUser, unauthorized } from "@/lib/auth";
import { db, uid } from "@/lib/db";

export const dynamic = "force-dynamic";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_ROWS = 3000;

export async function POST(request: Request) {
  try {
    const user = await requireUser();
    const body = (await request.json()) as {
      rows?: {
        date?: string;
        kind?: string;
        amount?: number;
        categoryId?: string | null;
        memo?: string;
      }[];
    };
    const rows = Array.isArray(body.rows) ? body.rows.slice(0, MAX_ROWS) : [];
    if (rows.length === 0) {
      return Response.json({ error: "登録する明細がありません。" }, { status: 400 });
    }
    const d = db();
    const ownCategories = new Set(
      (
        d.prepare("SELECT id FROM categories WHERE user_id = ?").all(user.id) as unknown as {
          id: string;
        }[]
      ).map((c) => c.id),
    );
    const insExp = d.prepare(
      "INSERT INTO expenses (id, user_id, date, amount, category_id, memo, source, created_at) VALUES (?, ?, ?, ?, ?, ?, 'import', ?)",
    );
    const insInc = d.prepare(
      "INSERT INTO incomes (id, user_id, date, amount, type, memo, created_at) VALUES (?, ?, ?, ?, 'import', ?, ?)",
    );
    let expenses = 0;
    let incomes = 0;
    let invalid = 0;
    // 途中失敗で中途半端に残らないよう、全行を1トランザクションで登録する
    d.exec("BEGIN");
    try {
      const now = Date.now();
      for (const r of rows) {
        const amount = Math.round(Number(r.amount));
        if (!r.date || !DATE_RE.test(r.date) || !Number.isFinite(amount) || amount <= 0) {
          invalid++;
          continue;
        }
        const memo = (r.memo ?? "").trim().slice(0, 100);
        if (r.kind === "income") {
          insInc.run(uid(), user.id, r.date, amount, memo, now);
          incomes++;
        } else {
          const categoryId =
            r.categoryId && ownCategories.has(r.categoryId) ? r.categoryId : null;
          insExp.run(uid(), user.id, r.date, amount, categoryId, memo, now);
          expenses++;
        }
      }
      d.exec("COMMIT");
    } catch (e) {
      d.exec("ROLLBACK");
      throw e;
    }
    return Response.json({ ok: true, expenses, incomes, invalid });
  } catch (e) {
    if (e instanceof AuthError) return unauthorized();
    return Response.json({ error: String(e) }, { status: 500 });
  }
}
