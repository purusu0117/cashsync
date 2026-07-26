// 月次振り返りレポート：終わった月の収支をAIが分析し、使いすぎ指摘と貯金アドバイスを返す。
// 生成は月ごとに1回だけ（monthly_reviews にキャッシュ）。モデルはSonnet。
import { askClaudeForJsonSmart } from "@/lib/ai";
import { AuthError, requireUser, unauthorized } from "@/lib/auth";
import { db } from "@/lib/db";
import {
  categoryBreakdown,
  currentMonth,
  monthSummary,
  noMoneyDays,
  postRecurringForMonth,
} from "@/lib/money";
import { fmtMonthJa } from "@/lib/format";

export const dynamic = "force-dynamic";
export const maxDuration = 180;

export interface Review {
  headline: string;
  overspend: { category: string; amount: number; prevAmount: number; comment: string }[];
  good: string[];
  advice: { title: string; detail: string; saveEstimate: number }[];
}

function prevMonth(month: string): string {
  const [y, m] = month.split("-").map(Number);
  const d = new Date(y, m - 2, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

export async function GET(request: Request) {
  try {
    const user = await requireUser();
    const month = new URL(request.url).searchParams.get("month") ?? "";
    if (!/^\d{4}-\d{2}$/.test(month)) {
      return Response.json({ error: "month required" }, { status: 400 });
    }
    if (month >= currentMonth()) {
      return Response.json(
        { error: "月が終わってからレポートを作成できます。" },
        { status: 400 },
      );
    }
    const d = db();
    const cached = d
      .prepare("SELECT report FROM monthly_reviews WHERE user_id = ? AND month = ?")
      .get(user.id, month) as { report: string } | undefined;
    if (cached) {
      return Response.json({ review: JSON.parse(cached.report), month, cached: true });
    }

    postRecurringForMonth(user.id, currentMonth());
    const summary = monthSummary(user.id, month);
    if (summary.expenseTotal === 0 && summary.incomeTotal === 0) {
      return Response.json(
        { error: "この月には記録がないため、レポートを作成できません。" },
        { status: 400 },
      );
    }
    const breakdown = categoryBreakdown(user.id, month);
    const prev = prevMonth(month);
    const prevSummary = monthSummary(user.id, prev);
    const prevBreakdown = categoryBreakdown(user.id, prev);
    const nmd = noMoneyDays(user.id, month);
    const goalRow = d.prepare("SELECT savings_goal FROM users WHERE id = ?").get(user.id) as
      | { savings_goal: number }
      | undefined;

    const data = {
      month,
      収入: summary.incomeTotal,
      支出: summary.expenseTotal,
      貯蓄: summary.incomeTotal - summary.expenseTotal,
      貯金目標: goalRow?.savings_goal ?? 0,
      カテゴリ別支出: breakdown,
      ノーマネーデー日数: nmd.count,
      前月: { month: prev, 収入: prevSummary.incomeTotal, 支出: prevSummary.expenseTotal, カテゴリ別: prevBreakdown },
    };
    const prompt = [
      `あなたは学生・若手社会人向けの家計アドバイザー。次の${fmtMonthJa(month)}の家計データを分析して、振り返りレポートをJSONで返してください。`,
      `データ: ${JSON.stringify(data)}`,
      "・headline: 一言総評（30字以内・励ます調子だが率直に）。",
      "・overspend: 使いすぎているカテゴリ（前月比や金額の大きさで判断、最大3件）。amount=当月額、prevAmount=前月額、comment=なぜ使いすぎと言えるか一言。前月データが0なら金額の大きさで判断。",
      "・good: 良かった点（最大3件、ノーマネーデーや貯蓄達成など具体的に）。",
      "・advice: 来月もっと貯金するための具体的アドバイス（最大3件）。title=短い見出し、detail=具体的な行動（金額入り）、saveEstimate=月いくら浮くかの概算（数値・円）。",
      "・数字はデータにあるものだけを使い、でっち上げない。",
      '出力はJSONだけ: {"headline":"…","overspend":[{"category":"…","amount":0,"prevAmount":0,"comment":"…"}],"good":["…"],"advice":[{"title":"…","detail":"…","saveEstimate":0}]}',
    ].join("\n");
    const review = await askClaudeForJsonSmart<Review>(prompt);
    d.prepare(
      "INSERT INTO monthly_reviews (user_id, month, report, created_at) VALUES (?, ?, ?, ?)",
    ).run(user.id, month, JSON.stringify(review), Date.now());
    return Response.json({ review, month, cached: false });
  } catch (e) {
    if (e instanceof AuthError) return unauthorized();
    return Response.json(
      { error: e instanceof Error ? e.message : "review failed" },
      { status: 500 },
    );
  }
}
