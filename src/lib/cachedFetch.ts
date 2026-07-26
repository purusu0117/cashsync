"use client";

// キャッシュファースト（stale-while-revalidate）のGET用fetchヘルパー。
// 前回のレスポンスを sessionStorage に保存し、次回マウント時は即座にキャッシュを表示→
// 裏で再取得して最新に差し替える。
// クラウド版はAPI往復に数百msかかるため、これが無いとタブ切り替えのたびに
// 「デフォルト状態（初期設定っぽい画面）」が一瞬見えてしまう。
// 注意：ログイン・ログアウト・401時は clearApiCache() で必ず全消しする（別ユーザーのデータ混入防止）。

const PREFIX = "cashsync-api:";

// クリア世代カウンタ：clearApiCache() より前に始まった fetch が
// あとから古いユーザーのデータをキャッシュへ書き戻すのを防ぐ
let epoch = 0;

/** 保存済みAPIキャッシュを全て消す（ログイン成功時・ログアウト時・401時に必ず呼ぶ） */
export function clearApiCache(): void {
  epoch++;
  try {
    for (let i = sessionStorage.length - 1; i >= 0; i--) {
      const k = sessionStorage.key(i);
      if (k?.startsWith(PREFIX)) sessionStorage.removeItem(k);
    }
  } catch {
    /* プライベートモード等で sessionStorage が使えなくても動作は変わらない */
  }
}

function readCache<T>(url: string): T | null {
  try {
    const raw = sessionStorage.getItem(PREFIX + url);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

function writeCache(url: string, data: unknown): void {
  try {
    sessionStorage.setItem(PREFIX + url, JSON.stringify(data));
  } catch {
    /* 容量超過等は無視（キャッシュ無しと同じ挙動になるだけ） */
  }
}

/**
 * キャッシュがあれば即 apply →裏で fetch して最新を apply（＋キャッシュ更新）。
 * - 401: キャッシュを全消しして /login へ
 * - fetch失敗: キャッシュ表示済みなら静かに無視（次の再取得で回復）、初回（キャッシュ無し）なら throw
 * apply はキャッシュ→最新の順で最大2回呼ばれる。戻り値は「最新データを取得できたか」。
 */
export async function cachedFetch<T>(url: string, apply: (data: T) => void): Promise<boolean> {
  const started = epoch;
  const cached = readCache<T>(url);
  if (cached !== null) apply(cached);
  try {
    const res = await fetch(url);
    if (res.status === 401) {
      clearApiCache();
      location.href = "/login";
      return false;
    }
    const data = (await res.json()) as T & { error?: string };
    if (!res.ok) throw new Error(data?.error ?? "読み込みに失敗しました。");
    if (epoch !== started) return false; // fetch中にログアウト等でクリアされた→書き戻さない
    writeCache(url, data);
    apply(data);
    return true;
  } catch (e) {
    if (cached === null) throw e;
    return false;
  }
}
