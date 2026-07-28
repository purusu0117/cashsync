// 資産・口座残高の手動管理API（銀行連携なし）。既存の支出/収入/予算フローとは独立。
import { AuthError, requireUser, unauthorized } from "@/lib/auth";
import {
  accountsOverview,
  createAccount,
  deleteAccount,
  updateAccount,
} from "@/lib/accounts";

export const dynamic = "force-dynamic";

// 一覧＋純資産＋前月比＋直近12ヶ月の推移
export async function GET() {
  try {
    const user = await requireUser();
    const data = await accountsOverview(user.id);
    return Response.json(data);
  } catch (e) {
    if (e instanceof AuthError) return unauthorized();
    return Response.json({ error: String(e) }, { status: 500 });
  }
}

// 口座作成（name必須。作成時に当月スナップショットをupsert）
export async function POST(request: Request) {
  try {
    const user = await requireUser();
    const body = (await request.json()) as { name?: string; kind?: string; balance?: number };
    const name = (body.name ?? "").trim();
    if (!name) return Response.json({ error: "名前は必須です。" }, { status: 400 });
    const id = await createAccount(user.id, { name, kind: body.kind, balance: body.balance });
    return Response.json({ ok: true, id });
  } catch (e) {
    if (e instanceof AuthError) return unauthorized();
    return Response.json({ error: String(e) }, { status: 500 });
  }
}

// 口座更新（balance変更時は当月スナップショットをupsert）
export async function PUT(request: Request) {
  try {
    const user = await requireUser();
    const body = (await request.json()) as {
      id?: string;
      name?: string;
      kind?: string;
      balance?: number;
      sort?: number;
    };
    if (!body.id) return Response.json({ error: "id required" }, { status: 400 });
    if (body.name !== undefined && !body.name.trim())
      return Response.json({ error: "名前は必須です。" }, { status: 400 });
    const ok = await updateAccount(user.id, body.id, {
      name: body.name,
      kind: body.kind,
      balance: body.balance,
      sort: body.sort,
    });
    if (!ok) return Response.json({ error: "口座が見つかりません。" }, { status: 404 });
    return Response.json({ ok: true, id: body.id });
  } catch (e) {
    if (e instanceof AuthError) return unauthorized();
    return Response.json({ error: String(e) }, { status: 500 });
  }
}

// 口座削除（?id=…。スナップショットも削除）
export async function DELETE(request: Request) {
  try {
    const user = await requireUser();
    const id = new URL(request.url).searchParams.get("id");
    if (!id) return Response.json({ error: "id required" }, { status: 400 });
    const ok = await deleteAccount(user.id, id);
    if (!ok) return Response.json({ error: "口座が見つかりません。" }, { status: 404 });
    return Response.json({ ok: true });
  } catch (e) {
    if (e instanceof AuthError) return unauthorized();
    return Response.json({ error: String(e) }, { status: 500 });
  }
}
