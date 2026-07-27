// B10: データのエクスポート。支出・収入・シフトをまとめたCSV（UTF-8 BOM付き）をダウンロードさせる。
// ?start=YYYY-MM-DD&end=YYYY-MM-DD（両端含む・省略時は全期間）
import { AuthError, requireUser, unauthorized } from "@/lib/auth";
import { collectExportRows, toCsv } from "@/lib/exportCsv";
import { todayStr } from "@/lib/money";

export const dynamic = "force-dynamic";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export async function GET(request: Request) {
  try {
    const user = await requireUser();
    const p = new URL(request.url).searchParams;
    const start = DATE_RE.test(p.get("start") ?? "") ? (p.get("start") as string) : undefined;
    const end = DATE_RE.test(p.get("end") ?? "") ? (p.get("end") as string) : undefined;
    const csv = toCsv(collectExportRows(user.id, start, end));
    const stamp = todayStr().replace(/-/g, "");
    return new Response(csv, {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="cashsync-${stamp}.csv"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (e) {
    if (e instanceof AuthError) return unauthorized();
    return Response.json({ error: String(e) }, { status: 500 });
  }
}
