"use client";

// 週次振り返り：先週（月〜日）の支出をレシート風カードで。
// 本体は WeeklyReview（グラフ画面の「週」タブと共用・C9）。ホームのバナー動線用に残すページ。
import WeeklyReview from "@/components/WeeklyReview";

export default function WeeklyPage() {
  return (
    <div className="space-y-4">
      <h1 className="dot text-lg">先週の振り返り</h1>
      <WeeklyReview showStatsLink />
    </div>
  );
}
