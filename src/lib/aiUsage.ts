// サーバー専用：AIプラン階層と月間使用量の管理。
//  - plan: 'free'（無料枠あり・Haiku） / 'premium'（¥480/月・Sonnet） / 'founder'（初期ユーザー・無制限・Sonnet）
//  - free は 月30スキャン（レシート読取）＋ 月30パース（自然文解析）まで
//  - premium はフェアユースとして 月200スキャンまで（パースは無制限）。founder は完全無制限
// 超過時、APIは { ok: false, error: 'limit', message: '…' } を 429 で返す。
import { db } from "./db";
import { jstTodayStr } from "./jst";

export type Plan = "free" | "premium" | "founder";
export type UsageKind = "scans" | "parses";

export const FREE_LIMITS: Record<UsageKind, number> = { scans: 30, parses: 30 };

// premium のフェアユース上限（レシート読取のみ。通常利用ではまず届かない値）
export const PREMIUM_SCAN_LIMIT = 200;

// リワード動画1本あたりのボーナス回数と、1日に視聴できる上限本数
export const REWARD_BONUS = 3;
export const REWARD_DAILY_MAX = 10;

export const LIMIT_MESSAGE: Record<UsageKind, string> = {
  scans:
    "今月の無料枠（レシート読み取り30回）を使い切りました。来月1日にリセットされます。それまでは手入力をご利用ください。",
  parses:
    "今月の無料枠（AI解析30回）を使い切りました。来月1日にリセットされます。それまでは手入力をご利用ください。",
};

// premium のフェアユース超過時（free と同系のトーン・429で返す）
export const PREMIUM_LIMIT_MESSAGE: Record<UsageKind, string> = {
  scans: `今月のプレミアム上限（レシート読み取り${PREMIUM_SCAN_LIMIT}回）に達しました。来月1日にリセットされます。それまでは手入力をご利用ください。`,
  parses: "今月のプレミアム上限に達しました。来月1日にリセットされます。それまでは手入力をご利用ください。",
};

/** プランに応じた上限超過メッセージ（premium はフェアユース文言、それ以外は無料枠文言） */
export function limitMessage(kind: UsageKind, plan: Plan): string {
  return plan === "premium" ? PREMIUM_LIMIT_MESSAGE[kind] : LIMIT_MESSAGE[kind];
}

export function normalizePlan(v: unknown): Plan {
  return v === "premium" || v === "founder" ? v : "free";
}

/** ユーザーのプランを取得（不明・未設定は free 扱い） */
export async function getUserPlan(userId: string): Promise<Plan> {
  const d = await db();
  const row = await d.get<{ plan: string | null }>("SELECT plan FROM users WHERE id = ?", userId);
  return normalizePlan(row?.plan);
}

export interface UsageCheck {
  allowed: boolean;
  used: number;
  limit: number | null; // null = 無制限
}

/**
 * 使用枠を確認して1回分カウントする。
 *  - free   : 月上限（FREE_LIMITS＋リワード動画ボーナス bonus_scans / bonus_parses）まで
 *  - premium: パースは無制限。スキャンのみフェアユース（月 PREMIUM_SCAN_LIMIT 回）まで
 *  - founder: 完全無制限（カウントは記録のみ）
 */
export async function checkAndCountUsage(
  userId: string,
  plan: Plan,
  kind: UsageKind,
): Promise<UsageCheck> {
  const d = await db();
  const ym = jstTodayStr().slice(0, 7);
  const row = await d.get<{
    scans: number;
    parses: number;
    bonus_scans: number;
    bonus_parses: number;
  }>(
    "SELECT scans, parses, bonus_scans, bonus_parses FROM ai_usage WHERE user_id = ? AND ym = ?",
    userId,
    ym,
  );
  const used = row ? row[kind] : 0;
  const bonus = row ? (kind === "scans" ? row.bonus_scans : row.bonus_parses) : 0;
  // null = 無制限（founder 全部・premium のパース）
  const monthLimit =
    plan === "free"
      ? FREE_LIMITS[kind] + bonus
      : plan === "premium" && kind === "scans"
        ? PREMIUM_SCAN_LIMIT
        : null;
  if (monthLimit !== null && used >= monthLimit) {
    return { allowed: false, used, limit: monthLimit };
  }
  const col = kind === "scans" ? "scans" : "parses";
  await d.run(
    `INSERT INTO ai_usage (user_id, ym, scans, parses) VALUES (?, ?, ?, ?)
     ON CONFLICT (user_id, ym) DO UPDATE SET ${col} = ai_usage.${col} + 1`,
    userId,
    ym,
    kind === "scans" ? 1 : 0,
    kind === "parses" ? 1 : 0,
  );
  return { allowed: true, used: used + 1, limit: monthLimit };
}

export interface RewardGrant {
  ok: boolean;
  added: number;
  /** 今日あと何本リワード動画を見られるか */
  remainingToday: number;
}

/**
 * リワード動画の視聴完了ボーナスを付与する（当月の bonus_scans / bonus_parses を +3）。
 * 悪用ガードとして1日 REWARD_DAILY_MAX 本まで（超過は ok:false）。sqlite/Postgres 両対応。
 */
export async function grantRewardBonus(userId: string, kind: UsageKind): Promise<RewardGrant> {
  const d = await db();
  const ymd = jstTodayStr();
  const ym = ymd.slice(0, 7);
  return d.transaction(async (tx) => {
    const today = await tx.get<{ count: number }>(
      "SELECT count FROM ai_reward_days WHERE user_id = ? AND ymd = ?",
      userId,
      ymd,
    );
    const usedToday = today?.count ?? 0;
    if (usedToday >= REWARD_DAILY_MAX) {
      return { ok: false, added: 0, remainingToday: 0 };
    }
    await tx.run(
      `INSERT INTO ai_reward_days (user_id, ymd, count) VALUES (?, ?, 1)
       ON CONFLICT (user_id, ymd) DO UPDATE SET count = ai_reward_days.count + 1`,
      userId,
      ymd,
    );
    const col = kind === "scans" ? "bonus_scans" : "bonus_parses";
    await tx.run(
      `INSERT INTO ai_usage (user_id, ym, scans, parses, bonus_scans, bonus_parses) VALUES (?, ?, 0, 0, ?, ?)
       ON CONFLICT (user_id, ym) DO UPDATE SET ${col} = ai_usage.${col} + ${REWARD_BONUS}`,
      userId,
      ym,
      kind === "scans" ? REWARD_BONUS : 0,
      kind === "parses" ? REWARD_BONUS : 0,
    );
    return { ok: true, added: REWARD_BONUS, remainingToday: REWARD_DAILY_MAX - usedToday - 1 };
  });
}

/** 上限超過時の共通レスポンスボディ（既存UIは message を表示する） */
export function limitResponseBody(kind: UsageKind, check: UsageCheck, plan: Plan = "free") {
  return {
    ok: false as const,
    error: "limit" as const,
    message: limitMessage(kind, plan),
    used: check.used,
    limit: check.limit,
  };
}
