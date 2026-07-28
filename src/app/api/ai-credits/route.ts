// リワード動画視聴の報酬：当月のAI利用ボーナス枠を +3 する。
// ネイティブアプリの「動画を見て+3回」ボタンから呼ばれる。
// 視聴トークンの厳密検証は行わない代わりに、1日 REWARD_DAILY_MAX 本の上限でガードする。
import { REWARD_IP_DAILY_MAX, clientIp, consumeRewardIp } from "@/lib/abuse";
import {
  getUserPlan,
  grantRewardBonus,
  REWARD_DAILY_MAX,
  type UsageKind,
} from "@/lib/aiUsage";
import { AuthError, requireUser, unauthorized } from "@/lib/auth";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const user = await requireUser();
    const body = (await request.json().catch(() => ({}))) as { kind?: string };
    const kind: UsageKind | null =
      body.kind === "scans" || body.kind === "parses" ? body.kind : null;
    if (!kind) {
      return Response.json({ ok: false, error: "kind must be 'scans' or 'parses'" }, { status: 400 });
    }
    const plan = await getUserPlan(user.id);
    if (plan !== "free") {
      // premium/founder は無制限なのでボーナス不要（正常応答で返す）
      return Response.json({ ok: true, added: 0, remainingToday: 0, plan });
    }
    // 不正対策③: ユーザー単位の1日10本に加え、IP単位の日次上限で複数アカウントfarmingを止める。
    const ip = clientIp(request);
    const ipCheck = await consumeRewardIp(ip);
    if (!ipCheck.ok) {
      return Response.json(
        {
          ok: false,
          error: "reward-limit",
          message: `本日の動画ボーナスは上限（${REWARD_IP_DAILY_MAX}回）に達しました。また明日どうぞ。`,
        },
        { status: 429 },
      );
    }
    const grant = await grantRewardBonus(user.id, kind);
    if (!grant.ok) {
      return Response.json(
        {
          ok: false,
          error: "reward-limit",
          message: `今日の動画ボーナスは上限（${REWARD_DAILY_MAX}回）に達しました。また明日どうぞ。`,
        },
        { status: 429 },
      );
    }
    return Response.json({ ok: true, added: grant.added, remainingToday: grant.remainingToday });
  } catch (e) {
    if (e instanceof AuthError) return unauthorized();
    return Response.json({ error: String(e) }, { status: 500 });
  }
}
