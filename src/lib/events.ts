// サーバー専用：自前・軽量アナリティクス（第三者送信なし・Cookie不要）。
// events(id, user_id nullable, name, props_json, ts) に最小イベントだけ積む。
// 個人を特定する生データは持たない（user_id は既存の内部IDのみ）。
import { db, uid } from "./db";

// 受け付けるイベント名（未知の名前は捨てる＝ゴミデータ・悪用の混入防止）
export const KNOWN_EVENTS = [
  "signup",
  "activated",
  "scan_used",
  "parse_used",
  "manual_add",
  "app_open",
  "subscribe",
] as const;
export type EventName = (typeof KNOWN_EVENTS)[number];

export function isKnownEvent(name: unknown): name is EventName {
  return typeof name === "string" && (KNOWN_EVENTS as readonly string[]).includes(name);
}

/**
 * イベントを1件記録する（fire-and-forget前提・失敗は握り潰して呼び出し元に投げない）。
 * props は小さなオブジェクトのみ想定。巨大化しないよう文字列化して2KBで打ち切る。
 */
export async function recordEvent(
  userId: string | null,
  name: string,
  props?: Record<string, unknown>,
): Promise<void> {
  if (!isKnownEvent(name)) return;
  try {
    const d = await db();
    let propsJson = "{}";
    if (props && typeof props === "object") {
      const s = JSON.stringify(props);
      propsJson = s.length > 2048 ? "{}" : s;
    }
    await d.run(
      "INSERT INTO events (id, user_id, name, props_json, ts) VALUES (?, ?, ?, ?, ?)",
      uid(),
      userId,
      name,
      propsJson,
      Date.now(),
    );
  } catch {
    /* 計測失敗はアプリの動作に影響させない */
  }
}

export interface EventSummaryRow {
  name: string;
  count: number;
  users: number; // このイベントを起こしたユニークユーザー数（user_id 非NULL）
}

/** 管理者ダッシュボード用の集計（イベント名ごとの件数とユニークユーザー数） */
export async function eventSummary(): Promise<EventSummaryRow[]> {
  const d = await db();
  const rows = await d.all<{ name: string; count: number; users: number }>(
    `SELECT name, COUNT(*) AS count, COUNT(DISTINCT user_id) AS users
     FROM events GROUP BY name ORDER BY count DESC`,
  );
  return rows.map((r) => ({ name: r.name, count: Number(r.count), users: Number(r.users) }));
}
