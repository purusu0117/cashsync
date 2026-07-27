"use client";

// B8: アプリロック（4桁パスコード）。
// サーバーデータはセッションクッキーで保護済みなので、これは「覗き見防止のUXロック」。
// パスコードは端末ローカル（localStorage）に salt つき SHA-256 ハッシュで保存し、
// サーバーには一切送らない。忘れた場合はログアウト→再ログインで解除できる（設定・ロック画面に明記）。

const STORE_KEY = "cashsync-applock"; // JSON { salt, hash }
const UNLOCKED_KEY = "cashsync-applock-unlocked"; // sessionStorage: このセッションで解除済みか
const HIDDEN_AT_KEY = "cashsync-applock-hidden-at"; // バックグラウンドへ回った時刻

// カメラ起動や通知確認などの一瞬の離脱で毎回ロックすると使い物にならないので、
// この秒数を超えてバックグラウンドにいた場合のみ再ロックする（覗き見防止には十分）
export const RELOCK_AFTER_MS = 30_000;

interface LockRecord {
  salt: string;
  hash: string;
}

function readRecord(): LockRecord | null {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return null;
    const rec = JSON.parse(raw) as LockRecord;
    return rec.salt && rec.hash ? rec : null;
  } catch {
    return null;
  }
}

async function digest(pin: string, salt: string): Promise<string> {
  const data = new TextEncoder().encode(`${salt}:${pin}`);
  const buf = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export function isLockEnabled(): boolean {
  return readRecord() !== null;
}

export async function setPasscode(pin: string): Promise<void> {
  const saltBytes = new Uint8Array(16);
  crypto.getRandomValues(saltBytes);
  const salt = Array.from(saltBytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  const hash = await digest(pin, salt);
  localStorage.setItem(STORE_KEY, JSON.stringify({ salt, hash }));
}

export async function verifyPasscode(pin: string): Promise<boolean> {
  const rec = readRecord();
  if (!rec) return true;
  return (await digest(pin, rec.salt)) === rec.hash;
}

/** ロック解除（ログアウト時・設定でOFFにした時） */
export function disableLock(): void {
  localStorage.removeItem(STORE_KEY);
  sessionStorage.removeItem(UNLOCKED_KEY);
  sessionStorage.removeItem(HIDDEN_AT_KEY);
}

/** 起動直後にロック画面を出すべきか */
export function shouldLockOnLaunch(): boolean {
  if (!isLockEnabled()) return false;
  return sessionStorage.getItem(UNLOCKED_KEY) !== "1";
}

export function markUnlocked(): void {
  sessionStorage.setItem(UNLOCKED_KEY, "1");
}

export function markHidden(): void {
  sessionStorage.setItem(HIDDEN_AT_KEY, String(Date.now()));
}

/** フォアグラウンド復帰時に再ロックすべきか（一定時間以上の離脱のみ） */
export function shouldRelockOnResume(): boolean {
  if (!isLockEnabled()) return false;
  const at = Number(sessionStorage.getItem(HIDDEN_AT_KEY) || 0);
  return at > 0 && Date.now() - at > RELOCK_AFTER_MS;
}

// --- 生体認証（ネイティブ＝Capacitor のときだけ）。Webはパスコードのみ ---
// @aparajita/capacitor-biometric-auth を動的 import（Webバンドルにネイティブ依存を混ぜない・
// 未対応環境では throw → false でパスコードにフォールバックする）。
import { isNativePlatform } from "./native";

async function biometricPlugin() {
  if (!isNativePlatform()) return null;
  try {
    const mod = await import("@aparajita/capacitor-biometric-auth");
    return mod.BiometricAuth;
  } catch {
    return null;
  }
}

/** 生体認証が使えるか（ネイティブ＋プラグインあり＋端末対応） */
export async function biometricAvailable(): Promise<boolean> {
  const p = await biometricPlugin();
  if (!p) return false;
  try {
    const r = await p.checkBiometry();
    return !!r.isAvailable;
  } catch {
    return false;
  }
}

/** Face ID / 指紋で解除を試みる。成功=true、失敗・非対応=false（パスコードへフォールバック） */
export async function tryBiometricUnlock(): Promise<boolean> {
  const p = await biometricPlugin();
  if (!p) return false;
  try {
    await p.authenticate({
      reason: "CashSyncのロックを解除",
      cancelTitle: "パスコードを使う",
      allowDeviceCredential: false,
    });
    return true;
  } catch {
    return false;
  }
}
