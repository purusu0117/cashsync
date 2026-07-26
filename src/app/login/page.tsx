"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { clearApiCache } from "@/lib/cachedFetch";

export default function LoginPage() {
  const router = useRouter();
  const [mode, setMode] = useState<"login" | "register">("login");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return; // 連打防止
    setBusy(true);
    setError("");
    try {
      const res = await fetch("/api/auth", {
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
      // 前のユーザーのキャッシュが残らないよう、遷移前に全消し
      clearApiCache();
      router.replace("/");
      router.refresh();
      // 成功時は busy を戻さない：遷移完了（このページのアンマウント）まで
      // 「ログイン中・・・」のまま維持して、失敗したように見えるのを防ぐ
    } catch {
      setError("通信に失敗しました。");
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
          <label className="block">
            <span className="dot text-xs text-ink-faint">パスワード</span>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="mt-1 w-full rounded-md border border-rule bg-paper px-3 py-2.5 text-base outline-none focus:border-ink"
              autoComplete={mode === "login" ? "current-password" : "new-password"}
            />
          </label>
          {error && <p className="text-sm text-vermilion">{error}</p>}
          <button
            type="submit"
            disabled={busy}
            className="dot w-full rounded-md bg-vermilion py-3 text-lg text-card shadow-[0_2px_0_var(--vermilion-deep)] active:translate-y-0.5 active:shadow-none disabled:opacity-50"
          >
            {busy
              ? mode === "login"
                ? "ログイン中・・・"
                : "アカウント作成中・・・"
              : mode === "login"
                ? "ログイン"
                : "はじめる"}
          </button>
        </form>
        <button
          type="button"
          disabled={busy}
          onClick={() => setMode(mode === "login" ? "register" : "login")}
          className="mt-4 w-full text-center text-xs text-ink-faint underline underline-offset-4 disabled:opacity-40"
        >
          {mode === "login" ? "アカウントを作る" : "ログインに戻る"}
        </button>
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
