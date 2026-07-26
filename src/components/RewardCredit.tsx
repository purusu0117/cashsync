"use client";

// 無料枠超過（429 limit）時の「動画を見て+3回」ボタン。
// ネイティブアプリでのみ表示（Webでは null）。リワード動画の視聴完了後に
// /api/ai-credits へ POST し、当月のボーナス枠を+3する。
import { useEffect, useState } from "react";
import { isNativePlatform, showRewardedAd } from "@/lib/native";

export default function RewardCredit({
  kind,
  onGranted,
}: {
  kind: "scans" | "parses";
  onGranted?: () => void;
}) {
  // SSRとの不一致を避けるため、ネイティブ判定は初回マウント後に行う
  const [native, setNative] = useState(false);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");

  useEffect(() => {
    setNative(isNativePlatform());
  }, []);

  if (!native) return null;

  async function watch() {
    setBusy(true);
    setNote("");
    try {
      const rewarded = await showRewardedAd();
      if (!rewarded) {
        setNote("動画の視聴が完了しませんでした。最後まで見ると枠が追加されます。");
        return;
      }
      const res = await fetch("/api/ai-credits", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind }),
      });
      const d = await res.json();
      if (!res.ok) {
        setNote(d.message ?? "枠の追加に失敗しました。");
        return;
      }
      onGranted?.();
      setNote(`AIの利用枠を +${d.added}回 追加しました。もう一度お試しください。`);
    } catch {
      setNote("動画の表示に失敗しました。時間をおいてお試しください。");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-1.5">
      <button
        onClick={watch}
        disabled={busy}
        className="dot w-full rounded-md border border-vermilion py-2.5 text-sm text-vermilion active:translate-y-0.5 disabled:opacity-50"
      >
        {busy ? "動画を再生中・・・" : "🎬 動画を見て AI利用枠を +3回"}
      </button>
      {note && <p className="text-center text-[11px] text-ink-faint">{note}</p>}
    </div>
  );
}
