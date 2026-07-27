// サーバー専用：AI使用量の記録と残量表示（main＝ローカル版）。
// main は回数の「表示」だけで、上限による拒否（429）は行わない（拒否は cloud 版のみ）。
// plan は cloud 版と表示互換：'free'（月30回表示） / 'premium' / 'founder'（無制限表示）。
import { db } from "./db";

export type Plan = "free" | "premium" | "founder";
export type UsageKind = "scans" | "parses";

export const FREE_LIMITS: Record<UsageKind, number> = { scans: 30, parses: 30 };

export function normalizePlan(v: unknown): Plan {
  return v === "premium" || v === "founder" ? v : "free";
}

function currentYm(): string {
  const n = new Date();
  return `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, "0")}`;
}

/** 今月の使用回数を1回分カウントする（記録のみ・拒否はしない） */
export function countUsage(userId: string, kind: UsageKind): void {
  const col = kind === "scans" ? "scans" : "parses";
  db()
    .prepare(
      `INSERT INTO ai_usage (user_id, ym, scans, parses) VALUES (?, ?, ?, ?)
       ON CONFLICT (user_id, ym) DO UPDATE SET ${col} = ${col} + 1`,
    )
    .run(userId, currentYm(), kind === "scans" ? 1 : 0, kind === "parses" ? 1 : 0);
}

export interface AiUsageInfo {
  plan: Plan;
  // limit: null = 無制限（premium / founder）
  scans: { used: number; limit: number | null };
  parses: { used: number; limit: number | null };
}

/** 設定・スキャン画面の残量表示用（今月の使用回数とプラン別上限） */
export function getAiUsage(userId: string): AiUsageInfo {
  const row = db()
    .prepare("SELECT scans, parses FROM ai_usage WHERE user_id = ? AND ym = ?")
    .get(userId, currentYm()) as { scans: number; parses: number } | undefined;
  const planRow = db().prepare("SELECT plan FROM users WHERE id = ?").get(userId) as
    | { plan: string | null }
    | undefined;
  const plan = normalizePlan(planRow?.plan);
  const unlimited = plan !== "free";
  return {
    plan,
    scans: { used: row?.scans ?? 0, limit: unlimited ? null : FREE_LIMITS.scans },
    parses: { used: row?.parses ?? 0, limit: unlimited ? null : FREE_LIMITS.parses },
  };
}
