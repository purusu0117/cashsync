// 横断タグの一覧／作成／改名・並替／削除、および支出のタグ取得・タグ別集計。
// 既存の支出フローには割り込まない（このルートと expense_tags テーブルだけを扱う）。
import { AuthError, requireUser, unauthorized } from "@/lib/auth";
import {
  createTag,
  deleteTag,
  getExpenseTagIds,
  listTags,
  renameTag,
  reorderTags,
  tagSpend,
} from "@/lib/tags";
import { todayStr } from "@/lib/money";

export const dynamic = "force-dynamic";

const MONTH_RE = /^\d{4}-\d{2}$/;

export async function GET(request: Request) {
  try {
    const user = await requireUser();
    const params = new URL(request.url).searchParams;
    // 編集シート用：ある支出に付いているタグID
    const expenseId = params.get("expenseId");
    if (expenseId) {
      return Response.json({ tagIds: await getExpenseTagIds(user.id, expenseId) });
    }
    // タグ別集計：?stats=YYYY-MM（省略時は今月）。締め日基準の集計期間で合計する
    const stats = params.get("stats");
    if (stats !== null) {
      const month = MONTH_RE.test(stats) ? stats : todayStr().slice(0, 7);
      return Response.json(await tagSpend(user.id, month));
    }
    return Response.json({ tags: await listTags(user.id) });
  } catch (e) {
    if (e instanceof AuthError) return unauthorized();
    return Response.json({ error: String(e) }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const user = await requireUser();
    const body = (await request.json()) as { name?: string };
    const created = await createTag(user.id, body.name ?? "");
    if (!created) return Response.json({ error: "タグ名を入力してください。" }, { status: 400 });
    return Response.json({ ok: true, id: created.id });
  } catch (e) {
    if (e instanceof AuthError) return unauthorized();
    return Response.json({ error: String(e) }, { status: 500 });
  }
}

export async function PUT(request: Request) {
  try {
    const user = await requireUser();
    const body = (await request.json()) as { id?: string; name?: string; order?: string[] };
    // 並べ替え（order 配列が来たら sort を振り直す）
    if (Array.isArray(body.order)) {
      await reorderTags(user.id, body.order);
      return Response.json({ ok: true });
    }
    // 改名
    if (!body.id) return Response.json({ error: "id required" }, { status: 400 });
    const ok = await renameTag(user.id, body.id, body.name ?? "");
    if (!ok) return Response.json({ error: "タグ名を入力してください。" }, { status: 400 });
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
    await deleteTag(user.id, id);
    return Response.json({ ok: true });
  } catch (e) {
    if (e instanceof AuthError) return unauthorized();
    return Response.json({ error: String(e) }, { status: 500 });
  }
}
