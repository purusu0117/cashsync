// サーバー専用：iOSネイティブアプリへのプッシュ通知（APNs）。
//
// なぜ必要か: ネイティブアプリ（WKWebView）は Web Push を受け取れない。
// 「読み取りが終わりました」等をアプリを閉じた状態で届けるには APNs 経由で送る。
//
// 実装: Node組み込みの http2 で APNs の HTTP/2 API を直接叩く。
//   以前は @parse/node-apn を使っていたが、Vercelのサーバーレス環境で送信が
//   無言で失敗していた（実機で1件も届かず・Appleへは私の直叩きだと200で届く＝ライブラリ側の問題）。
//   2026-07-28 に生http2へ置き換え。認証はトークン方式(.p8)。
//
// 必要な環境変数:
//   APNS_KEY_BASE64 … APNs認証キー(.p8)を base64 にしたもの
//   APNS_KEY_ID     … そのキーのID（10桁）
//   APNS_TEAM_ID    … チームID（10桁）
//   APNS_BUNDLE_ID  … 省略時 com.daito.cashsync
//   APNS_PRODUCTION … "0" でサンドボックス。既定は本番（TestFlight/App Store配布は本番）
import crypto from "crypto";
import http2 from "http2";
import { db } from "./db";

function apnsHost(): string {
  return process.env.APNS_PRODUCTION !== "0"
    ? "https://api.push.apple.com"
    : "https://api.sandbox.push.apple.com";
}

function bundleId(): string {
  return process.env.APNS_BUNDLE_ID || "com.daito.cashsync";
}

// APNsのプロバイダトークン(JWT)。Appleは20分〜60分での再利用を要求するのでキャッシュする。
let cachedJwt: { token: string; at: number } | null = null;
function providerToken(): string | null {
  const keyB64 = process.env.APNS_KEY_BASE64;
  const keyId = process.env.APNS_KEY_ID;
  const teamId = process.env.APNS_TEAM_ID;
  if (!keyB64 || !keyId || !teamId) return null;
  const now = Math.floor(Date.now() / 1000);
  if (cachedJwt && now - cachedJwt.at < 2700) return cachedJwt.token; // 45分キャッシュ
  const key = Buffer.from(keyB64, "base64").toString("utf8");
  const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const header = enc({ alg: "ES256", kid: keyId });
  const payload = enc({ iss: teamId, iat: now });
  const signer = crypto.createSign("SHA256");
  signer.update(`${header}.${payload}`);
  const sig = signer.sign({ key, dsaEncoding: "ieee-p1363" }).toString("base64url");
  const token = `${header}.${payload}.${sig}`;
  cachedJwt = { token, at: now };
  return token;
}

export interface ApnsResult {
  token: string; // 先頭のみ（診断表示用）
  status: number;
  reason?: string;
}

/** 1回の接続で複数トークンへ送る。各トークンの APNs 応答(status/reason)を返す */
async function deliver(tokens: string[], title: string, body: string): Promise<ApnsResult[]> {
  const jwt = providerToken();
  if (!jwt || tokens.length === 0) return [];
  const payload = JSON.stringify({ aps: { alert: { title, body }, sound: "default" } });
  const topic = bundleId();
  const expiry = String(Math.floor(Date.now() / 1000) + 3600);
  return await new Promise<ApnsResult[]>((resolve) => {
    const client = http2.connect(apnsHost());
    const results: ApnsResult[] = [];
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      try {
        client.close();
      } catch {
        /* noop */
      }
      resolve(results);
    };
    // 接続自体が張れない場合（サーバーレスでの失敗はここに出る）
    client.on("error", () => finish());
    const timer = setTimeout(finish, 15_000); // 全体タイムアウト
    let pending = tokens.length;
    const one = () => {
      if (--pending <= 0) {
        clearTimeout(timer);
        finish();
      }
    };
    for (const token of tokens) {
      const req = client.request({
        ":method": "POST",
        ":path": `/3/device/${token}`,
        authorization: `bearer ${jwt}`,
        "apns-topic": topic,
        "apns-push-type": "alert",
        "apns-priority": "10",
        "apns-expiration": expiry,
      });
      let status = 0;
      let data = "";
      req.on("response", (h) => {
        status = Number(h[":status"]) || 0;
      });
      req.setEncoding("utf8");
      req.on("data", (d) => (data += d));
      req.on("end", () => {
        let reason: string | undefined;
        if (data) {
          try {
            reason = JSON.parse(data).reason;
          } catch {
            /* noop */
          }
        }
        results.push({ token: token.slice(0, 8), status, reason });
        one();
      });
      req.on("error", (e) => {
        results.push({ token: token.slice(0, 8), status: 0, reason: `req_error:${(e as Error).message}` });
        one();
      });
      req.end(payload);
    }
  });
}

async function iosTokens(userId: string): Promise<string[]> {
  const d = await db();
  const rows = await d.all<{ token: string }>(
    "SELECT token FROM push_devices WHERE user_id = ? AND platform = 'ios'",
    userId,
  );
  return rows.map((r) => r.token);
}

/** 無効になったトークンを掃除（410 Unregistered / BadDeviceToken） */
async function cleanupDead(fullTokens: string[], results: ApnsResult[]): Promise<void> {
  const d = await db();
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    const bad = r.status === 410 || r.reason === "BadDeviceToken" || r.reason === "Unregistered";
    if (bad && fullTokens[i]) {
      await d.run("DELETE FROM push_devices WHERE token = ?", fullTokens[i]).catch(() => {});
    }
  }
}

/**
 * iOSネイティブアプリへ通知を送る。届いた（APNsが200を返した）件数を返す。
 * 失敗はサーバーログに理由を出す（無言で消さない）。
 */
export async function sendApns(userId: string, title: string, body: string): Promise<number> {
  try {
    const tokens = await iosTokens(userId);
    if (tokens.length === 0) return 0;
    const results = await deliver(tokens, title, body);
    await cleanupDead(tokens, results);
    const ok = results.filter((r) => r.status === 200).length;
    if (ok < tokens.length) {
      console.error(
        "[apns] 送信失敗あり:",
        results.filter((r) => r.status !== 200).map((r) => `${r.status}:${r.reason ?? ""}`).join(", ") ||
          "(応答なし)",
      );
    }
    return ok;
  } catch (e) {
    console.error("[apns] 送信エラー:", e);
    return 0;
  }
}

/** 診断用：/api/push/test から使う。実際に送りつつ APNs の生の応答を返す */
export async function apnsDiagnostics(
  userId: string,
  title: string,
  body: string,
): Promise<{ configured: boolean; results: ApnsResult[] }> {
  const configured =
    !!process.env.APNS_KEY_BASE64 && !!process.env.APNS_KEY_ID && !!process.env.APNS_TEAM_ID;
  if (!configured) return { configured, results: [] };
  const tokens = await iosTokens(userId);
  const results = await deliver(tokens, title, body);
  await cleanupDead(tokens, results);
  return { configured, results };
}
