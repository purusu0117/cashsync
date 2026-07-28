"use client";

// 不正対策①: メール確認ページ。確認メールのリンク（/verify?token=…）から開く。
// トークンをサーバーで検証して users.email_verified=1 にする。reset-password と同じ作法。
import Link from "next/link";
import { Suspense, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { NETWORK_ERROR_MESSAGE, netFetch } from "@/lib/cachedFetch";

function VerifyInner() {
  const token = useSearchParams().get("token") ?? "";
  const [state, setState] = useState<"checking" | "done" | "error">(token ? "checking" : "error");
  const [error, setError] = useState("");

  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await netFetch("/api/auth", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "verify", token }),
        });
        const data = await res.json();
        if (cancelled) return;
        if (!res.ok) {
          setError(data.error ?? "確認に失敗しました。");
          setState("error");
          return;
        }
        setState("done");
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : NETWORK_ERROR_MESSAGE);
        setState("error");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [token]);

  return (
    <div className="mx-auto max-w-md min-h-dvh flex flex-col justify-center px-6 py-10">
      <div className="zig zig-t zig-b px-6 py-8 shadow-sm text-center">
        <p className="dot text-sm text-ink-faint">＊＊ メール確認 ＊＊</p>
        <h1 className="dot text-4xl mt-2">CashSync</h1>
        <div className="cutline my-5" />
        {state === "checking" && <p className="dot text-sm text-ink-faint">確認しています・・・</p>}
        {state === "done" && (
          <>
            <p className="dot text-sm text-sage">メールアドレスを確認しました</p>
            <p className="mt-2 text-xs text-ink-faint">
              すべての機能がご利用いただけます。アプリに戻ってお使いください。
            </p>
            <Link
              href="/"
              className="dot mt-5 block w-full rounded-md bg-vermilion py-3 text-lg text-card shadow-[0_2px_0_var(--vermilion-deep)] active:translate-y-0.5 active:shadow-none"
            >
              ホームへ
            </Link>
          </>
        )}
        {state === "error" && (
          <>
            <p className="text-sm text-vermilion">{error || "リンクが正しくありません。"}</p>
            <p className="mt-2 text-xs text-ink-faint">
              有効期限（24時間）が切れている場合は、アプリの案内から確認メールを再送してください。
            </p>
            <Link
              href="/"
              className="mt-5 block text-center text-xs text-ink-faint underline underline-offset-4"
            >
              ホームへ
            </Link>
          </>
        )}
      </div>
    </div>
  );
}

export default function VerifyPage() {
  return (
    <Suspense fallback={null}>
      <VerifyInner />
    </Suspense>
  );
}
