"use client";

// B8: アプリロック画面（4桁パスコード・レシート世界観）。
// 起動時と、一定時間バックグラウンドにいた後の復帰時に全画面で覆う。
// ネイティブ（Capacitor）では生体認証（Face ID等）を先に試し、失敗/非対応ならパスコード入力へ。
// パスコードを忘れた場合の逃げ道：ログアウト→再ログインでロック解除（データは消えない）。
import { useCallback, useEffect, useRef, useState } from "react";
import {
  biometricAvailable,
  markHidden,
  markUnlocked,
  shouldLockOnLaunch,
  shouldRelockOnResume,
  tryBiometricUnlock,
  verifyPasscode,
  disableLock,
} from "@/lib/appLock";
import { clearApiCache } from "@/lib/cachedFetch";

const KEYS = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "", "0", "del"] as const;

export default function AppLock() {
  const [locked, setLocked] = useState(false);
  const [pin, setPin] = useState("");
  const [error, setError] = useState(false);
  const [bioReady, setBioReady] = useState(false);
  const bioTriedRef = useRef(false);

  const unlock = useCallback(() => {
    markUnlocked();
    setLocked(false);
    setPin("");
    setError(false);
    bioTriedRef.current = false;
  }, []);

  // 生体認証（ネイティブのみ）。ロック表示のたびに1回だけ自動で試す
  const tryBio = useCallback(async () => {
    if (bioTriedRef.current) return;
    bioTriedRef.current = true;
    if (await tryBiometricUnlock()) unlock();
  }, [unlock]);

  useEffect(() => {
    // 起動時判定は次のティックで行う（effect内の同期setStateによるカスケード描画を避ける）
    const t = setTimeout(() => {
      if (shouldLockOnLaunch()) setLocked(true);
    }, 0);
    const onVisibility = () => {
      if (document.visibilityState === "hidden") {
        markHidden();
        return;
      }
      if (shouldRelockOnResume()) {
        bioTriedRef.current = false;
        setLocked(true);
      }
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      clearTimeout(t);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, []);

  useEffect(() => {
    if (!locked) return;
    biometricAvailable().then((ok) => {
      setBioReady(ok);
      if (ok) tryBio();
    });
  }, [locked, tryBio]);

  async function press(key: (typeof KEYS)[number]) {
    if (!key) return;
    setError(false);
    if (key === "del") {
      setPin((p) => p.slice(0, -1));
      return;
    }
    const next = (pin + key).slice(0, 4);
    setPin(next);
    if (next.length === 4) {
      if (await verifyPasscode(next)) {
        unlock();
      } else {
        setError(true);
        setPin("");
      }
    }
  }

  // 逃げ道：パスコードを忘れたらログアウトで解除（再ログインすればデータはそのまま）
  async function logoutEscape() {
    try {
      await fetch("/api/auth", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "logout" }),
      });
    } catch {
      /* 通信断でもローカルのロックは解除してログイン画面へ */
    }
    disableLock();
    clearApiCache();
    location.href = "/login";
  }

  if (!locked) return null;

  return (
    <div className="fixed inset-0 z-[100] flex flex-col items-center justify-center bg-paper px-6">
      <div className="w-full max-w-xs text-center">
        <p className="dot text-sm tracking-[0.42em]">CASHSYNC</p>
        <p className="dot mt-3 text-xs text-ink-faint">＊ ロック中 ＊</p>
        <p className="mt-2 text-xs text-ink-faint">パスコードを入力してください</p>

        {/* 入力ドット */}
        <div className="mt-5 flex justify-center gap-4">
          {[0, 1, 2, 3].map((i) => (
            <span
              key={i}
              className={`h-3.5 w-3.5 rounded-full border ${
                i < pin.length ? "border-ink bg-ink" : "border-rule bg-transparent"
              }`}
            />
          ))}
        </div>
        <p className={`mt-2 h-4 text-xs text-vermilion ${error ? "" : "invisible"}`}>
          パスコードが違います
        </p>

        {/* テンキー */}
        <div className="mx-auto mt-3 grid w-full grid-cols-3 gap-2">
          {KEYS.map((k, i) =>
            k === "" ? (
              <span key={`sp${i}`} />
            ) : (
              <button
                key={k}
                onClick={() => press(k)}
                aria-label={k === "del" ? "1文字消す" : k}
                className="dot rounded-md border border-rule bg-card py-3.5 text-xl shadow-sm active:translate-y-0.5"
              >
                {k === "del" ? "←" : k}
              </button>
            ),
          )}
        </div>

        {bioReady && (
          <button
            onClick={() => {
              bioTriedRef.current = false;
              tryBio();
            }}
            className="dot mt-4 w-full rounded-md border border-ink py-2.5 text-sm active:translate-y-0.5"
          >
            生体認証で解除
          </button>
        )}

        <div className="cutline mt-5 pt-4">
          <p className="text-[11px] leading-relaxed text-ink-faint">
            パスコードを忘れた場合は、ログアウトして再ログインするとロックが解除されます（記録は消えません）。
          </p>
          <button
            onClick={logoutEscape}
            className="mt-2 text-xs text-ink-faint underline underline-offset-4"
          >
            ログアウトして解除する
          </button>
        </div>
      </div>
    </div>
  );
}
