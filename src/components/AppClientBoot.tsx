"use client";

// アプリ起動時のクライアント処理をまとめる（layout に1つだけ置く）：
//  1) 自前計測: app_open を1回送る（fire-and-forget）
//  2) メール未確認なら、確認をうながすバナー＋確認メールの再送導線を出す
import { useEffect, useState } from "react";
import { netFetch } from "@/lib/cachedFetch";
import { track } from "@/lib/track";

export default function AppClientBoot() {
  const [unverified, setUnverified] = useState(false);
  const [resendState, setResendState] = useState<"idle" | "busy" | "sent">("idle");

  useEffect(() => {
    track("app_open");
    // 確認状態を取得（未確認ならバナー表示）。失敗時は何も出さない（無害）。
    netFetch("/api/auth")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (d && d.user && d.emailVerified === false) setUnverified(true);
      })
      .catch(() => {});
  }, []);

  async function resend() {
    if (resendState === "busy") return;
    setResendState("busy");
    try {
      await netFetch("/api/auth", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "resendVerification" }),
      });
      setResendState("sent");
    } catch {
      setResendState("idle");
    }
  }

  if (!unverified) return null;

  return (
    <div className="mb-3 rounded-md border border-vermilion/40 bg-vermilion/5 px-3 py-2.5 text-xs leading-relaxed text-ink">
      <p className="font-bold text-vermilion">メールアドレスの確認が必要です</p>
      <p className="mt-1 text-ink-faint">
        登録時にお送りした確認メールのリンクを押してください。確認が済むと、レシート読み取りなどが使えます。
      </p>
      {resendState === "sent" ? (
        <p className="mt-1.5 text-sage">確認メールを再送しました。メールをご確認ください。</p>
      ) : (
        <button
          type="button"
          onClick={resend}
          disabled={resendState === "busy"}
          className="mt-1.5 underline underline-offset-4 disabled:opacity-40"
        >
          {resendState === "busy" ? "送信中・・・" : "確認メールを再送する"}
        </button>
      )}
    </div>
  );
}
