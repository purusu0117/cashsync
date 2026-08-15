"use client";

// Googleカレンダーからシフトを読み取る（もこもこ家計簿 fetchKimihanIncome の移植・一般化）。
// 前作と違い「毎回計算」ではなく「シフト表への取り込み」方式：
//  - 給与計算・祝日判定はサーバーの payroll ロジック（holiday_jp）に一元化
//  - 取り込み後はカレンダー連携なしでも動く
// OAuth Client ID は前作と共用（Google Cloud Console 側で
// http://localhost:3004 と https://node.tail41e069.ts.net:8448 を承認済みオリジンに追加すること）。

import { getNativeCalendarToken, isNativeApp } from "./calendarAuthNative";

const CLIENT_ID =
  process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID ||
  "781974345385-o19aokomoquiv7mrnenduprs7ng841n0.apps.googleusercontent.com";
const SCOPE = "https://www.googleapis.com/auth/calendar.readonly";

interface TokenClient {
  requestAccessToken: (opts?: { prompt?: string }) => void;
}
interface GisWindow extends Window {
  google?: {
    accounts: {
      oauth2: {
        initTokenClient: (cfg: {
          client_id: string;
          scope: string;
          callback: (resp: { access_token?: string; error?: string }) => void;
          error_callback?: (err: { type?: string; message?: string }) => void;
        }) => TokenClient;
      };
    };
  };
}

let cachedToken: { token: string; at: number } | null = null;

function loadGis(): Promise<void> {
  return new Promise((resolve, reject) => {
    const w = window as GisWindow;
    if (w.google?.accounts?.oauth2) return resolve();
    const s = document.createElement("script");
    s.src = "https://accounts.google.com/gsi/client";
    s.async = true;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error("Google認証スクリプトの読み込みに失敗しました。"));
    document.head.appendChild(s);
  });
}

/**
 * アクセストークンを取得（初回はGoogleの同意ポップアップ、以降は約50分キャッシュ）。
 * ポップアップが開けない/閉じられた/オリジン未承認などの失敗は error_callback＋タイムアウトで
 * 必ず reject する（「同期中…」のまま固まらないように）。
 */
export async function getCalendarToken(): Promise<string> {
  if (cachedToken && Date.now() - cachedToken.at < 50 * 60 * 1000) {
    return cachedToken.token;
  }
  // 🔴 アプリ（App Store版）は WKWebView なので、Googleのポップアップ方式が
  // ポリシーで禁止されている（disallowed_useragent）。端末のSafariで認証する経路へ回す。
  // 2026-08-15 大翔の報告「アプリでカレンダー連携できない」の対応。
  if (isNativeApp()) {
    const token = await getNativeCalendarToken();
    cachedToken = { token, at: Date.now() };
    return token;
  }
  await loadGis();
  const w = window as GisWindow;
  return new Promise((resolve, reject) => {
    let settled = false;
    const done = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };
    // 90秒応答が無ければ諦める（ポップアップ放置・想定外の失敗の保険）
    const timer = setTimeout(
      () =>
        done(() =>
          reject(
            new Error(
              "Googleログインの応答がありません。ポップアップがブロックされていないか確認して、もう一度試してください。",
            ),
          ),
        ),
      90_000,
    );
    try {
      const client = w.google!.accounts.oauth2.initTokenClient({
        client_id: CLIENT_ID,
        scope: SCOPE,
        callback: (resp) => {
          if (resp.error || !resp.access_token) {
            done(() =>
              reject(
                new Error(
                  resp.error === "access_denied"
                    ? "カレンダーへのアクセスが許可されませんでした。"
                    : `Googleログインに失敗しました（${resp.error ?? "no token"}）。ポップアップ内にエラー400（origin_mismatch等）が出る場合は、Google Cloud Console の承認済みオリジン設定が未反映です。`,
                ),
              ),
            );
            return;
          }
          cachedToken = { token: resp.access_token, at: Date.now() };
          done(() => resolve(resp.access_token!));
        },
        error_callback: (err) => {
          const msg =
            err?.type === "popup_failed_to_open"
              ? "ログイン用ポップアップを開けませんでした。ブラウザのポップアップブロックを解除してください（ホーム画面のアプリから開いている場合は、一度SafariやChromeで開いて連携してください）。"
              : err?.type === "popup_closed"
                ? "ログインがキャンセルされました（ポップアップが閉じられました）。"
                : `Googleログインでエラーが発生しました（${err?.type ?? err?.message ?? "不明"}）。`;
          done(() => reject(new Error(msg)));
        },
      });
      client.requestAccessToken({ prompt: "" });
    } catch (e) {
      done(() => reject(e instanceof Error ? e : new Error("Googleログインを開始できませんでした。")));
    }
  });
}

export interface ShiftCandidate {
  date: string; // YYYY-MM-DD
  startMin: number;
  endMin: number;
  summary: string;
}

// シフト希望の締切イベント等を誤って取り込まないための既定除外ワード
export const DEFAULT_EXCLUDES = ["希望", "締切", "〆切", "提出", "面接", "説明会", "ミーティング", "MTG"];

const AUTOSYNC_KEY = "cashsync-autosync";

export function isAutoSyncOn(): boolean {
  try {
    return localStorage.getItem(AUTOSYNC_KEY) === "1";
  } catch {
    return false;
  }
}

export function setAutoSync(on: boolean) {
  try {
    if (on) localStorage.setItem(AUTOSYNC_KEY, "1");
    else localStorage.removeItem(AUTOSYNC_KEY);
  } catch {
    /* private mode 等 */
  }
}

interface GcalEvent {
  summary?: string;
  start?: { dateTime?: string; date?: string };
  end?: { dateTime?: string; date?: string };
}

/** 指定月の primary カレンダーからキーワード一致イベントをシフト候補に変換 */
export async function fetchShiftCandidates(
  token: string,
  month: string, // 'YYYY-MM'
  keywords: string[],
  excludes: string[] = DEFAULT_EXCLUDES,
): Promise<ShiftCandidate[]> {
  const [y, m] = month.split("-").map(Number);
  const timeMin = new Date(y, m - 1, 1).toISOString();
  const timeMax = new Date(y, m, 1).toISOString();
  const params = new URLSearchParams({
    timeMin,
    timeMax,
    singleEvents: "true",
    orderBy: "startTime",
    maxResults: "250",
  });
  const res = await fetch(
    `https://www.googleapis.com/calendar/v3/calendars/primary/events?${params}`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  if (!res.ok) {
    if (res.status === 401) cachedToken = null;
    throw new Error(`カレンダーの取得に失敗しました (${res.status})`);
  }
  const data = (await res.json()) as { items?: GcalEvent[] };
  const kws = keywords.map((k) => k.trim().toLowerCase()).filter(Boolean);
  const exs = excludes.map((k) => k.trim().toLowerCase()).filter(Boolean);
  const out: ShiftCandidate[] = [];
  for (const e of data.items ?? []) {
    const summary = e.summary ?? "";
    const lower = summary.toLowerCase();
    if (!kws.some((kw) => lower.includes(kw))) continue;
    // 「シフト希望 締切」等の関連イベントを除外（誤取り込み対策）
    if (exs.some((ex) => lower.includes(ex))) continue;
    // 終日イベントは時間が無いのでスキップ（前作と同じ挙動）
    if (!e.start?.dateTime || !e.end?.dateTime) continue;
    const s = new Date(e.start.dateTime);
    const en = new Date(e.end.dateTime);
    if (en <= s) continue;
    // 勤務時間として妥当な長さ（1〜12時間）以外は除外（リマインダー等の誤取り込み対策）
    const durH = (en.getTime() - s.getTime()) / 3600000;
    if (durH < 1 || durH > 12) continue;
    const date = `${s.getFullYear()}-${String(s.getMonth() + 1).padStart(2, "0")}-${String(s.getDate()).padStart(2, "0")}`;
    const startMin = s.getHours() * 60 + s.getMinutes();
    out.push({
      date,
      startMin,
      // 終了は実時間差から算出（日跨ぎイベントでも 1440+ 分として正しく扱える）
      endMin: startMin + Math.round((en.getTime() - s.getTime()) / 60000),
      summary,
    });
  }
  return out;
}

export interface SyncResult {
  added: number;
  updated: number;
  removed: number;
}

/**
 * 1ヶ月ぶんの自動同期：カレンダー読み取り→サーバーで差分適用。
 * 追加だけでなく、時間変更の反映・取り消された予定の削除も行う（手入力シフトには触らない）。
 */
export async function syncMonth(
  token: string,
  jobId: string,
  month: string,
  keywords: string[],
  excludes: string[],
): Promise<SyncResult> {
  const candidates = await fetchShiftCandidates(token, month, keywords, excludes);
  const res = await fetch("/api/shifts/sync", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jobId,
      month,
      candidates: candidates.map((c) => ({ date: c.date, startMin: c.startMin, endMin: c.endMin })),
    }),
  });
  const d = await res.json();
  if (!res.ok) throw new Error(d.error ?? "同期に失敗しました。");
  return { added: d.added, updated: d.updated, removed: d.removed };
}
