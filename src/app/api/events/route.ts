// 自前・軽量アナリティクスの受け口。
//   POST /api/events  … { name, props? } を1件記録（未ログインでも受ける・fire-and-forget）
//   GET  /api/events  … 管理者（founderプラン）のみ：イベント名ごとの集計を返す
// 第三者送信なし・Cookie不要。user_id は既存の内部IDのみ（未ログインは NULL）。
import { getUserPlan } from "@/lib/aiUsage";
import { currentUser } from "@/lib/auth";
import { eventSummary, recordEvent } from "@/lib/events";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const body = (await request.json().catch(() => ({}))) as {
      name?: string;
      props?: Record<string, unknown>;
    };
    // user_id は取れれば付ける（未ログインでも受ける）。認証は必須にしない。
    const user = await currentUser().catch(() => null);
    await recordEvent(user?.id ?? null, body.name ?? "", body.props);
    // 記録可否にかかわらず 204 相当で軽く返す（クライアントは結果を見ない）
    return Response.json({ ok: true });
  } catch {
    // 計測はベストエフォート。失敗してもクライアントには成功で返し、画面に影響させない
    return Response.json({ ok: true });
  }
}

export async function GET() {
  // 管理者だけが見られる最小ダッシュ用API。管理者判定は plan='founder'（初期ユーザー）。
  const user = await currentUser();
  if (!user) return Response.json({ error: "unauthorized" }, { status: 401 });
  const plan = await getUserPlan(user.id);
  if (plan !== "founder") return Response.json({ error: "forbidden" }, { status: 403 });
  const summary = await eventSummary();
  return Response.json({ summary });
}
