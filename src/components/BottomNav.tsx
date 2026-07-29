"use client";

// 下タブ：シフトはカレンダータブへ統合したので、静的な5タブ（ホーム/履歴/カレンダー/グラフ/設定）。
// 週次振り返りはグラフ画面の「週/月」切替に統合済み（C9）なのでタブは持たない。
// 中央持ち上げ（primary）は廃止して等幅フラットに統一。
import Link from "next/link";
import { usePathname } from "next/navigation";

const TABS = [
  { href: "/", label: "ホーム", icon: HomeIcon },
  { href: "/history", label: "履歴", icon: ListIcon },
  { href: "/calendar", label: "カレンダー", icon: CalendarIcon },
  { href: "/stats", label: "グラフ", icon: ChartIcon },
  { href: "/settings", label: "設定", icon: GearIcon },
];

export default function BottomNav() {
  const pathname = usePathname();
  const tabs = TABS;
  return (
    <nav className="fixed bottom-0 inset-x-0 z-40 bg-card border-t border-rule pb-[env(safe-area-inset-bottom)]">
      <div className="mx-auto max-w-md flex items-stretch">
        {tabs.map((t) => {
          const active = t.href === "/" ? pathname === "/" : pathname.startsWith(t.href);
          return (
            <Link
              key={t.href}
              href={t.href}
              className={`flex-1 flex flex-col items-center gap-0.5 py-2.5 ${
                active ? "text-vermilion" : "text-ink-faint"
              }`}
            >
              <t.icon className="h-5 w-5" />
              <span className="text-[10px] font-medium whitespace-nowrap">{t.label}</span>
            </Link>
          );
        })}
      </div>
    </nav>
  );
}

type IconProps = { className?: string };

function HomeIcon({ className }: IconProps) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M3 11 12 3l9 8" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M5 10v10h5v-6h4v6h5V10" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
function ListIcon({ className }: IconProps) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M6 3h12v18l-2-1.5L14 21l-2-1.5L10 21l-2-1.5L6 21Z" strokeLinejoin="round" />
      <path d="M9 8h6M9 12h6" strokeLinecap="round" />
    </svg>
  );
}
function CalendarIcon({ className }: IconProps) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <rect x="3" y="5" width="18" height="16" rx="2" />
      <path d="M3 10h18M8 3v4M16 3v4" strokeLinecap="round" />
      <path d="M8 14h2m3 0h2m-7 4h2" strokeLinecap="round" />
    </svg>
  );
}
function ChartIcon({ className }: IconProps) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M4 20V9m5.5 11V4M15 20v-8m5 8V7" strokeLinecap="round" />
    </svg>
  );
}
function GearIcon({ className }: IconProps) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <circle cx="12" cy="12" r="3" />
      <path d="M12 2v3m0 14v3M2 12h3m14 0h3M4.9 4.9l2.1 2.1m10 10 2.1 2.1M19.1 4.9l-2.1 2.1m-10 10-2.1 2.1" strokeLinecap="round" />
    </svg>
  );
}
