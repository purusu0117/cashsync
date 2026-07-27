// C2: 乗り換えインポート①（CSV）。Zaim/マネーフォワードの標準出力列を自動判定して
// プレビュー用の候補行を返す（保存はしない：/api/import/commit で確定）。
import { AuthError, requireUser, unauthorized } from "@/lib/auth";
import { db } from "@/lib/db";
import { decodeCsvBuffer, mapCsv, resolveCategoryId } from "@/lib/importCsv";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const user = await requireUser();
    const form = await request.formData();
    const file = form.get("file");
    if (!(file instanceof File)) {
      return Response.json({ error: "CSVファイルを選んでください。" }, { status: 400 });
    }
    if (file.size > 5 * 1024 * 1024) {
      return Response.json({ error: "ファイルが大きすぎます（5MBまで）。" }, { status: 400 });
    }
    const text = decodeCsvBuffer(new Uint8Array(await file.arrayBuffer()));
    const parsed = mapCsv(text);
    if (parsed.rows.length === 0) {
      return Response.json(
        {
          error:
            "取り込める行が見つかりませんでした。Zaim・マネーフォワードのエクスポートCSV、または「日付」「金額」列のあるCSVに対応しています。",
        },
        { status: 400 },
      );
    }
    const categories = db()
      .prepare("SELECT id, name FROM categories WHERE user_id = ? ORDER BY sort")
      .all(user.id) as unknown as { id: string; name: string }[];
    const rows = parsed.rows.map((r) => ({
      ...r,
      categoryId: r.kind === "expense" ? resolveCategoryId(r.category, categories) : null,
    }));
    return Response.json({ format: parsed.format, rows, skipped: parsed.skipped });
  } catch (e) {
    if (e instanceof AuthError) return unauthorized();
    return Response.json({ error: String(e) }, { status: 500 });
  }
}
