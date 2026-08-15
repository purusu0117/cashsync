"use client";

/**
 * アプリ（App Store版）用の Google 認証。
 *
 * 🔴 なぜ専用の実装が要るか（2026-08-15 大翔の報告「アプリでカレンダー連携できない」）
 * アプリは WKWebView で本番サイトを読み込む構成（Capacitor remote URL 方式）。
 * Google は **アプリ内WebViewでのOAuthをポリシーで禁止**しているため、
 * 従来の `calendarImport.ts`（Google Identity Services のポップアップ）は
 * アプリからは必ず弾かれる（disallowed_useragent）。
 *
 * → **端末の本物のブラウザ（SFSafariViewController）で認証する**形に変える。
 *   iOS用のOAuthクライアント（＝シークレット無し）＋ PKCE を使うので、
 *   クライアントシークレットをアプリにもサーバーにも置かなくてよい。
 *
 * 流れ:
 *   1. code_verifier を作る → SHA-256 の challenge を付けて Safari で認証画面を開く
 *   2. 許可すると `com.googleusercontent.apps.<id>:/oauth2redirect?code=...` でアプリに戻る
 *   3. その code と verifier をトークンに交換（client_secret 不要）
 *   4. refresh_token を端末に保存 → 以後は無言で access_token を取り直せる
 */

const IOS_CLIENT_ID =
  process.env.NEXT_PUBLIC_GOOGLE_IOS_CLIENT_ID ||
  "781974345385-4i0asbd7gsntj3v0c7ijjr5jd1ha1u5k.apps.googleusercontent.com";

/** iOSクライアントの戻り先は「クライアントIDの逆順スキーム」。Info.plist にも登録済み */
const REDIRECT_URI = `com.googleusercontent.apps.${IOS_CLIENT_ID.replace(
  ".apps.googleusercontent.com",
  "",
)}:/oauth2redirect`;

const SCOPE = "https://www.googleapis.com/auth/calendar.readonly";
const LS_REFRESH = "cashsync_google_refresh";

interface CapacitorGlobal {
  isNativePlatform?: () => boolean;
}
interface NativeWindow extends Window {
  Capacitor?: CapacitorGlobal;
}

/** アプリ（ネイティブ）で動いているか */
export function isNativeApp(): boolean {
  if (typeof window === "undefined") return false;
  return Boolean((window as NativeWindow).Capacitor?.isNativePlatform?.());
}

function base64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function randomVerifier(): string {
  const bytes = new Uint8Array(64);
  crypto.getRandomValues(bytes);
  return base64url(bytes);
}

async function challengeOf(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return base64url(new Uint8Array(digest));
}

/** 保存済みのリフレッシュトークンからアクセストークンを取り直す（無言・再同意なし） */
async function refreshAccessToken(refreshToken: string): Promise<string | null> {
  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: IOS_CLIENT_ID,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }),
  });
  if (!r.ok) return null;
  const j = (await r.json()) as { access_token?: string };
  return j.access_token ?? null;
}

/** 端末に連携済みのGoogleアカウントがあるか */
export function hasNativeGoogleLink(): boolean {
  if (typeof window === "undefined") return false;
  return Boolean(localStorage.getItem(LS_REFRESH));
}

/** 連携を解除する（トークンを捨てるだけ。Google側の許可はアカウント設定から） */
export function clearNativeGoogleLink(): void {
  try {
    localStorage.removeItem(LS_REFRESH);
  } catch {
    /* 失敗してもアプリは動く */
  }
}

/**
 * アクセストークンを取得する。
 * 保存済みトークンがあれば無言で更新し、無ければSafariを開いて許可をもらう。
 */
export async function getNativeCalendarToken(): Promise<string> {
  const saved = typeof window === "undefined" ? null : localStorage.getItem(LS_REFRESH);
  if (saved) {
    const token = await refreshAccessToken(saved);
    if (token) return token;
    clearNativeGoogleLink(); // 期限切れ・取り消し済み → 取り直す
  }

  const [{ Browser }, { App }] = await Promise.all([
    import("@capacitor/browser"),
    import("@capacitor/app"),
  ]);

  const verifier = randomVerifier();
  const challenge = await challengeOf(verifier);
  const authUrl =
    "https://accounts.google.com/o/oauth2/v2/auth?" +
    new URLSearchParams({
      client_id: IOS_CLIENT_ID,
      redirect_uri: REDIRECT_URI,
      response_type: "code",
      scope: SCOPE,
      code_challenge: challenge,
      code_challenge_method: "S256",
      access_type: "offline",
      prompt: "consent",
    }).toString();

  const code = await new Promise<string>((resolve, reject) => {
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      void listener.then((l) => l.remove()).catch(() => {});
      void Browser.close().catch(() => {});
      fn();
    };
    // 3分応答が無ければ諦める（画面が「同期中…」のまま固まらないように）
    const timer = setTimeout(
      () =>
        finish(() =>
          reject(new Error("Googleの許可画面から戻ってきませんでした。もう一度試してください。")),
        ),
      180_000,
    );

    const listener = App.addListener("appUrlOpen", ({ url }) => {
      if (!url.startsWith(REDIRECT_URI.split(":/")[0])) return;
      const q = new URLSearchParams(url.split("?")[1] ?? "");
      const err = q.get("error");
      const c = q.get("code");
      if (err) return finish(() => reject(new Error("カレンダーへのアクセスが許可されませんでした。")));
      if (c) return finish(() => resolve(c));
    });

    void Browser.open({ url: authUrl, presentationStyle: "popover" }).catch((e) =>
      finish(() => reject(e instanceof Error ? e : new Error("ブラウザを開けませんでした。"))),
    );
  });

  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: IOS_CLIENT_ID,
      code,
      code_verifier: verifier,
      grant_type: "authorization_code",
      redirect_uri: REDIRECT_URI,
    }),
  });
  if (!r.ok) {
    throw new Error(`Googleとの接続に失敗しました（${r.status}）。もう一度試してください。`);
  }
  const j = (await r.json()) as { access_token?: string; refresh_token?: string };
  if (!j.access_token) throw new Error("Googleからトークンを受け取れませんでした。");
  if (j.refresh_token) {
    try {
      localStorage.setItem(LS_REFRESH, j.refresh_token);
    } catch {
      /* 保存できなくても今回の同期はできる */
    }
  }
  return j.access_token;
}
