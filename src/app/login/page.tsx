"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { NETWORK_ERROR_MESSAGE, clearApiCache, netFetch } from "@/lib/cachedFetch";
import { track } from "@/lib/track";

export default function LoginPage() {
  const router = useRouter();
  const [mode, setMode] = useState<"login" | "register" | "forgot">("login");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  // B5: リセットメール受付後の案内（存在しないメールでも同じ表示＝列挙攻撃対策）
  const [forgotSent, setForgotSent] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return; // 連打防止
    // C7: 新規登録は名前必須（ホーム挨拶の「　さん」表示を防ぐ）
    if (mode === "register" && !name.trim()) {
      setError("お名前を入力してください。");
      return;
    }
    // A7: 新規登録は8文字以上（既存ユーザーのログインはチェックしない）
    if (mode === "register" && password.length < 8) {
      setError("パスワードは8文字以上にしてください。");
      return;
    }
    setBusy(true);
    setError("");
    // B5: パスワード再設定メールの受付（成否にかかわらず同じ完了画面を出す）
    if (mode === "forgot") {
      try {
        const res = await netFetch("/api/auth", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "forgot", email }),
        });
        const data = await res.json();
        if (!res.ok) {
          setError(data.error ?? "失敗しました。");
          return;
        }
        setForgotSent(true);
      } catch (err) {
        setError(err instanceof Error ? err.message : NETWORK_ERROR_MESSAGE);
      } finally {
        setBusy(false);
      }
      return;
    }
    try {
      const res = await netFetch("/api/auth", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: mode, name, email, password }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "失敗しました。");
        setBusy(false);
        return;
      }
      // 自前計測：新規登録の成功だけ記録（ログインは対象外）
      if (mode === "register") track("signup");
      // 前のユーザーのキャッシュが残らないよう、遷移前に全消し
      clearApiCache();
      router.replace("/");
      router.refresh();
      // 成功時は busy を戻さない：遷移完了（このページのアンマウント）まで
      // 「ログイン中・・・」のまま維持して、失敗したように見えるのを防ぐ
    } catch (err) {
      setError(err instanceof Error ? err.message : NETWORK_ERROR_MESSAGE);
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto max-w-md min-h-dvh flex flex-col justify-center px-6 py-10">
      <div className="zig zig-t zig-b px-6 py-8 shadow-sm">
        <p className="dot text-center text-sm text-ink-faint">＊＊ ようこそ ＊＊</p>
        <h1 className="dot text-center text-4xl mt-2">CashSync</h1>
        <p className="text-center text-xs text-ink-faint mt-2">
          レシートを撮るだけ、入力3秒の家計簿
        </p>
        <div className="cutline my-5" />
        {mode === "forgot" && forgotSent ? (
          /* B5: 受付完了。メールの有無にかかわらず常にこの画面（アカウント列挙をさせない） */
          <div className="text-center">
            <p className="dot text-sm">メールを送信しました</p>
            <p className="mt-2 text-xs leading-relaxed text-ink-faint">
              {email} 宛にパスワード再設定のリンクを送りました（有効期限：1時間）。
              届かない場合は、メールアドレスの間違いや迷惑メールフォルダをご確認ください。
            </p>
            <button
              type="button"
              onClick={() => {
                setMode("login");
                setForgotSent(false);
              }}
              className="mt-5 w-full text-center text-xs text-ink-faint underline underline-offset-4"
            >
              ログインに戻る
            </button>
          </div>
        ) : (
        <>
        {mode === "forgot" && (
          <p className="mb-3 text-xs leading-relaxed text-ink-faint">
            登録済みのメールアドレスを入力してください。パスワード再設定のリンクをお送りします。
          </p>
        )}
        <form onSubmit={submit} className="space-y-3">
          {mode === "register" && (
            <label className="block">
              <span className="dot text-xs text-ink-faint">名前</span>
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                className="mt-1 w-full rounded-md border border-rule bg-paper px-3 py-2.5 text-base outline-none focus:border-ink"
                placeholder="タロー"
                autoComplete="name"
              />
            </label>
          )}
          <label className="block">
            <span className="dot text-xs text-ink-faint">メールアドレス</span>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="mt-1 w-full rounded-md border border-rule bg-paper px-3 py-2.5 text-base outline-none focus:border-ink"
              placeholder="you@example.com"
              autoComplete="email"
            />
          </label>
          {mode !== "forgot" && (
            <label className="block">
              <span className="dot text-xs text-ink-faint">パスワード</span>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="mt-1 w-full rounded-md border border-rule bg-paper px-3 py-2.5 text-base outline-none focus:border-ink"
                autoComplete={mode === "login" ? "current-password" : "new-password"}
              />
              {mode === "register" && (
                <span className="mt-1 block text-[11px] text-ink-faint">8文字以上で設定してください</span>
              )}
            </label>
          )}
          {error && <p className="text-sm text-vermilion">{error}</p>}
          <button
            type="submit"
            disabled={busy}
            className="dot w-full rounded-md bg-vermilion py-3 text-lg text-card shadow-[0_2px_0_var(--vermilion-deep)] active:translate-y-0.5 active:shadow-none disabled:opacity-50"
          >
            {busy
              ? mode === "login"
                ? "ログイン中・・・"
                : mode === "register"
                  ? "アカウント作成中・・・"
                  : "・・・"
              : mode === "login"
                ? "ログイン"
                : mode === "register"
                  ? "はじめる"
                  : "再設定メールを送る"}
          </button>
        </form>
        {mode === "login" && (
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              setMode("forgot");
              setError("");
            }}
            className="mt-3 w-full text-center text-xs text-ink-faint underline underline-offset-4 disabled:opacity-40"
          >
            パスワードをお忘れですか？
          </button>
        )}
        <button
          type="button"
          disabled={busy}
          onClick={() => {
            setMode(mode === "login" ? "register" : "login");
            setError("");
          }}
          className="mt-4 w-full text-center text-xs text-ink-faint underline underline-offset-4 disabled:opacity-40"
        >
          {mode === "login" ? "アカウントを作る" : "ログインに戻る"}
        </button>
        </>
        )}
      </div>
      <p className="mt-6 flex justify-center gap-4 text-[11px] text-ink-faint">
        <Link href="/legal/terms" className="underline underline-offset-4">
          利用規約
        </Link>
        <Link href="/legal/privacy" className="underline underline-offset-4">
          プライバシーポリシー
        </Link>
      </p>
    </div>
  );
}
