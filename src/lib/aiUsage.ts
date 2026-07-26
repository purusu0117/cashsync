// サーバー専用：AIプラン階層と月間使用量の管理。
//  - plan: 'free'（無料枠あり・Haiku） / 'premium'（無制限・Sonnet） / 'founder'（初期ユーザー・無制限・Sonnet）
//  - free は 月30スキャン（レシート読取）＋ 月30パース（自然文解析）まで
// 超過時、APIは { ok: false, error: 'limit', message: '…' } を 429 で返す。
import { db } from "./db";
import { jstTodayStr } from "./jst";

export type Plan = "free" | "premium" | "founder";
export type UsageKind = "scans" | "parses";

export const FREE_LIMITS: Record<UsageKind, number> = { scans: 30, parses: 30 };

export const LIMIT_MESSAGE: Record<UsageKind, string> = {
  scans:
    "今月の無料枠（レシート読み取り30回）を使い切りました。来月1日にリセットされます。それまでは手入力をご利用ください。",
  parses:
    "今月の無料枠（AI解析30回）を使い切りました。来月1日にリセットされます。それまでは手入力をご利用ください。",
};

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
 * premium/founder は無制限（カウントは記録のみ）。free は月上限に達していたら false。
 */
export async function checkAndCountUsage(
  userId: string,
  plan: Plan,
  kind: UsageKind,
): Promise<UsageCheck> {
  const d = await db();
  const ym = jstTodayStr().slice(0, 7);
  const row = await d.get<{ scans: number; parses: number }>(
    "SELECT scans, parses FROM ai_usage WHERE user_id = ? AND ym = ?",
    userId,
    ym,
  );
  const used = row ? row[kind] : 0;
  if (plan === "free" && used >= FREE_LIMITS[kind]) {
    return { allowed: false, used, limit: FREE_LIMITS[kind] };
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
  return { allowed: true, used: used + 1, limit: plan === "free" ? FREE_LIMITS[kind] : null };
}

/** 上限超過時の共通レスポンスボディ（既存UIは message を表示する） */
export function limitResponseBody(kind: UsageKind, check: UsageCheck) {
  return {
    ok: false as const,
    error: "limit" as const,
    message: LIMIT_MESSAGE[kind],
    used: check.used,
    limit: check.limit,
  };
}
