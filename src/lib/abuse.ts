// サーバー専用：公開前の不正対策のうち「IPベースの歯止め」。
//  - 新規登録の同一IP連打（捨てメアド乱造）を短時間ウィンドウで制限
//  - リワード動画ボーナスのIP日次上限（ユーザー単位の上限に加える歯止め）
// next 非依存（Request からヘッダを読むだけ）。テストスイートから直接呼べるようにここへ集約する。
import { db } from "./db";
import { jstTodayStr } from "./jst";

// 新規登録：1IP あたり RegisterLimit 件 / SIGNUP_WINDOW_MS。健全なユーザーの家族共有IP等でも
// まず届かない緩めの値にする（乱造だけを止める）。
export const SIGNUP_IP_LIMIT = 5;
export const SIGNUP_WINDOW_MS = 60 * 60 * 1000; // 1時間

// リワード動画ボーナス：1IP あたり REWARD_IP_DAILY_MAX 回/日（複数アカウント farming の歯止め）。
// ユーザー単位の日次上限（aiUsage.REWARD_DAILY_MAX=10）より緩め＝正規利用は妨げない。
export const REWARD_IP_DAILY_MAX = 30;

export const SIGNUP_RATE_MESSAGE =
  "短時間に登録が続いたため、しばらくお待ちください。時間をおいて、もう一度お試しください。";

/**
 * リクエスト元IP。Vercel(hnd1固定)は x-forwarded-for の先頭が実クライアントIP。
 * 取れないときは "unknown"（＝同一バケットに集約されるだけで、機能は壊れない）。
 */
export function clientIp(request: Request): string {
  const xff = request.headers.get("x-forwarded-for");
  if (xff) {
    const first = xff.split(",")[0]?.trim();
    if (first) return first;
  }
  return request.headers.get("x-real-ip")?.trim() || "unknown";
}

/** 直近ウィンドウ内の登録試行回数を数える（この試行を記録する前に呼ぶ） */
export async function recentSignupAttempts(ip: string, now = Date.now()): Promise<number> {
  const d = await db();
  const row = await d.get<{ c: number }>(
    "SELECT COUNT(*) AS c FROM signup_attempts WHERE ip = ? AND ts >= ?",
    ip,
    now - SIGNUP_WINDOW_MS,
  );
  return Number(row?.c ?? 0);
}

/** 登録試行を1件記録する（成否にかかわらず。古い行はついでに掃除） */
export async function recordSignupAttempt(ip: string, now = Date.now()): Promise<void> {
  const d = await db();
  await d.run("INSERT INTO signup_attempts (ip, ts) VALUES (?, ?)", ip, now);
  // テーブルが無限に太らないよう、ウィンドウ外の古い行を間引く
  await d.run("DELETE FROM signup_attempts WHERE ts < ?", now - SIGNUP_WINDOW_MS);
}

/**
 * IP日次のリワード上限を1つ消費する。上限内なら { ok:true }、超過なら { ok:false }。
 * ユーザー単位の付与（aiUsage.grantRewardBonus）の前段でIPの歯止めをかける。
 */
export async function consumeRewardIp(ip: string): Promise<{ ok: boolean }> {
  const d = await db();
  const ymd = jstTodayStr();
  return d.transaction(async (tx) => {
    const row = await tx.get<{ count: number }>(
      "SELECT count FROM reward_ip_days WHERE ip = ? AND ymd = ?",
      ip,
      ymd,
    );
    if (Number(row?.count ?? 0) >= REWARD_IP_DAILY_MAX) return { ok: false };
    await tx.run(
      `INSERT INTO reward_ip_days (ip, ymd, count) VALUES (?, ?, 1)
       ON CONFLICT (ip, ymd) DO UPDATE SET count = reward_ip_days.count + 1`,
      ip,
      ymd,
    );
    return { ok: true };
  });
}
