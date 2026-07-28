"use client";

// B5: パスワード再設定ページ。メールのリンク（/reset-password?token=…）から開く。
// トークンはサーバー側で検証し、新パスワード（8文字以上）を設定する。
import Link from "next/link";
import { Suspense, useState } from "react";
import { useSearchParams } from "next/navigation";
import { NETWORK_ERROR_MESSAGE, netFetch } from "@/lib/cachedFetch";

function ResetPasswordForm() {
  const token = useSearchParams().get("token") ?? "";
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return; // 連打防止（多重送信ガード）
    if (password.length < 8) {
      setError("パスワードは8文字以上にしてください。");
      return;
    }
    if (password !== confirm) {
      setError("確認用のパスワードが一致しません。");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const res = await netFetch("/api/auth", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "reset", token, password }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "失敗しました。");
        return;
      }
      setDone(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : NETWORK_ERROR_MESSAGE);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto max-w-md min-h-dvh flex flex-col justify-center px-6 py-10">
      <div className="zig zig-t zig-b px-6 py-8 shadow-sm">
        <p className="dot text-center text-sm text-ink-faint">＊＊ パスワード再設定 ＊＊</p>
        <h1 className="dot text-center text-4xl mt-2">CashSync</h1>
        <div className="cutline my-5" />
        {!token ? (
          <div className="text-center">
            <p className="text-sm text-vermilion">リンクが正しくありません。</p>
            <p className="mt-2 text-xs text-ink-faint">
              メールに記載のリンクをもう一度開くか、再度お手続きください。
            </p>
            <Link
              href="/login"
              className="mt-5 block text-center text-xs text-ink-faint underline underline-offset-4"
            >
              ログイン画面へ
            </Link>
          </div>
        ) : done ? (
          <div className="text-center">
            <p className="dot text-sm text-sage">新しいパスワードを設定しました</p>
            <p className="mt-2 text-xs text-ink-faint">
              新しいパスワードでログインし直してください。
            </p>
            <Link
              href="/login"
              className="dot mt-5 block w-full rounded-md bg-vermilion py-3 text-center text-lg text-card shadow-[0_2px_0_var(--vermilion-deep)] active:translate-y-0.5 active:shadow-none"
            >
              ログインへ
            </Link>
          </div>
        ) : (
          <form onSubmit={submit} className="space-y-3">
            <label className="block">
              <span className="dot text-xs text-ink-faint">新しいパスワード</span>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="mt-1 w-full rounded-md border border-rule bg-paper px-3 py-2.5 text-base outline-none focus:border-ink"
                autoComplete="new-password"
              />
              <span className="mt-1 block text-[11px] text-ink-faint">8文字以上で設定してください</span>
            </label>
            <label className="block">
              <span className="dot text-xs text-ink-faint">新しいパスワード（確認）</span>
              <input
                type="password"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                className="mt-1 w-full rounded-md border border-rule bg-paper px-3 py-2.5 text-base outline-none focus:border-ink"
                autoComplete="new-password"
              />
            </label>
            {error && <p className="text-sm text-vermilion">{error}</p>}
            <button
              type="submit"
              disabled={busy}
              className="dot w-full rounded-md bg-vermilion py-3 text-lg text-card shadow-[0_2px_0_var(--vermilion-deep)] active:translate-y-0.5 active:shadow-none disabled:opacity-50"
            >
              {busy ? "・・・" : "パスワードを設定する"}
            </button>
          </form>
        )}
      </div>
    </div>
  );
}

export default function ResetPasswordPage() {
  // useSearchParams はビルド時プリレンダーで Suspense 境界が必要
  return (
    <Suspense fallback={null}>
      <ResetPasswordForm />
    </Suspense>
  );
}
