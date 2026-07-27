// かんたん入力ボタン（よく使う定型支出のワンタップ記録用プリセット）。
// スクショで撮りにくい支出（Suicaチャージ等）を、設定で登録→ホームで1タップ記録する。
import { AuthError, requireUser, unauthorized } from "@/lib/auth";
import { db, uid } from "@/lib/db";

export const dynamic = "force-dynamic";

// 登録できるプリセットの上限（ホームのグリッドが崩れない範囲）
// ※route.ts はHTTPメソッド以外を export できないため、UI側（設定画面）にも同じ値がある
const MAX_PRESETS = 12;

export async function GET() {
  try {
    const user = await requireUser();
    const presets = db()
      .prepare(
        `SELECT p.id, p.label, p.amount, p.category_id, c.name AS category, c.icon
         FROM quick_presets p
         LEFT JOIN categories c ON c.id = p.category_id AND c.user_id = p.user_id
         WHERE p.user_id = ? ORDER BY p.sort`,
      )
      .all(user.id);
    return Response.json({ presets });
  } catch (e) {
    if (e instanceof AuthError) return unauthorized();
    return Response.json({ error: String(e) }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const user = await requireUser();
    const body = (await request.json()) as {
      label?: string;
      amount?: number;
      categoryId?: string | null;
    };
    const label = (body.label ?? "").trim();
    const amount = Math.round(Number(body.amount));
    if (!label || !Number.isFinite(amount) || amount <= 0) {
      return Response.json({ error: "名前と金額は必須です。" }, { status: 400 });
    }
    if (label.length > 20) {
      return Response.json({ error: "名前は20文字以内にしてください。" }, { status: 400 });
    }
    const d = db();
    const count = d
      .prepare("SELECT COUNT(*) AS n FROM quick_presets WHERE user_id = ?")
      .get(user.id) as { n: number };
    if (count.n >= MAX_PRESETS) {
      return Response.json(
        { error: `かんたん入力ボタンは${MAX_PRESETS}個までです。` },
        { status: 400 },
      );
    }
    // categoryId は本人のカテゴリのみ許可（他ユーザーIDの混入防止）
    let categoryId: string | null = null;
    if (body.categoryId) {
      const row = d
        .prepare("SELECT id FROM categories WHERE id = ? AND user_id = ?")
        .get(body.categoryId, user.id);
      categoryId = row ? body.categoryId : null;
    }
    const max = d
      .prepare("SELECT COALESCE(MAX(sort), -1) AS m FROM quick_presets WHERE user_id = ?")
      .get(user.id) as { m: number };
    const id = uid();
    d.prepare(
      "INSERT INTO quick_presets (id, user_id, label, amount, category_id, sort) VALUES (?, ?, ?, ?, ?, ?)",
    ).run(id, user.id, label, amount, categoryId, max.m + 1);
    return Response.json({ ok: true, id });
  } catch (e) {
    if (e instanceof AuthError) return unauthorized();
    return Response.json({ error: String(e) }, { status: 500 });
  }
}

// B7: かんたん入力ボタンの編集（名前・金額・カテゴリの変更）
export async function PUT(request: Request) {
  try {
    const user = await requireUser();
    const body = (await request.json()) as {
      id?: string;
      label?: string;
      amount?: number;
      categoryId?: string | null;
    };
    if (!body.id) return Response.json({ error: "id required" }, { status: 400 });
    const label = (body.label ?? "").trim();
    const amount = Math.round(Number(body.amount));
    if (!label || !Number.isFinite(amount) || amount <= 0) {
      return Response.json({ error: "名前と金額は必須です。" }, { status: 400 });
    }
    if (label.length > 20) {
      return Response.json({ error: "名前は20文字以内にしてください。" }, { status: 400 });
    }
    const d = db();
    const cur = d
      .prepare("SELECT id FROM quick_presets WHERE id = ? AND user_id = ?")
      .get(body.id, user.id);
    if (!cur) return Response.json({ error: "ボタンが見つかりません。" }, { status: 404 });
    // categoryId は本人のカテゴリのみ許可（他ユーザーIDの混入防止）
    let categoryId: string | null = null;
    if (body.categoryId) {
      const row = d
        .prepare("SELECT id FROM categories WHERE id = ? AND user_id = ?")
        .get(body.categoryId, user.id);
      categoryId = row ? body.categoryId : null;
    }
    d.prepare(
      "UPDATE quick_presets SET label = ?, amount = ?, category_id = ? WHERE id = ? AND user_id = ?",
    ).run(label, amount, categoryId, body.id, user.id);
    return Response.json({ ok: true, id: body.id });
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
    db().prepare("DELETE FROM quick_presets WHERE id = ? AND user_id = ?").run(id, user.id);
    return Response.json({ ok: true });
  } catch (e) {
    if (e instanceof AuthError) return unauthorized();
    return Response.json({ error: String(e) }, { status: 500 });
  }
}
