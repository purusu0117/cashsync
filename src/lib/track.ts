"use client";

// 自前・軽量アナリティクスのクライアント送信ヘルパー（第三者送信なし・Cookie不要）。
// fire-and-forget：/api/events へ投げっぱなしにし、失敗しても画面には一切影響させない。
import { netFetch } from "./cachedFetch";

/**
 * 最小イベントを1件送る。await しない前提（呼び出し側は結果を待たない）。
 * 送信に失敗しても UX/パフォーマンスに影響させないため、例外は握り潰す。
 */
export function track(name: string, props?: Record<string, unknown>): void {
  try {
    void netFetch("/api/events", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, props }),
      keepalive: true, // 画面遷移・アンマウント中でも送信を落とさない
    }).catch(() => {});
  } catch {
    /* 送信自体が組めなくても無視 */
  }
}
