"use client";

// 書き込み系 fetch の共通ラッパー：401はログインへ、エラーは throw して呼び出し元で表示する。
// （以前は res.ok を見ずに成功扱いしてサイレント失敗していたバグの対策）
// A5: 通信断は netFetch が1回だけ自動リトライ→日本語の案内文で throw する。
import { clearApiCache, netFetch } from "./cachedFetch";

export { netFetch, NETWORK_ERROR_MESSAGE } from "./cachedFetch";

export async function apiCall<T = Record<string, unknown>>(
  url: string,
  init?: RequestInit,
): Promise<T> {
  const res = await netFetch(url, init);
  if (res.status === 401) {
    clearApiCache(); // セッション切れ：別ユーザーで再ログインしてもキャッシュが混ざらないように
    location.href = "/login";
    throw new Error("ログインしてください。");
  }
  let data: T & { error?: string };
  try {
    data = await res.json();
  } catch {
    throw new Error("通信に失敗しました。");
  }
  if (!res.ok) throw new Error(data.error ?? "保存に失敗しました。");
  return data;
}

export function apiJson(body: unknown, method = "POST"): RequestInit {
  return {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}
