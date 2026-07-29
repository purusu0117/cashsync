import Link from "next/link";
import { LEGAL } from "@/lib/legal";

// 法務ページ共通レイアウト：認証不要の公開ページ（App Store審査のクローラも閲覧する）
// (app) グループの外にあるため currentUser チェックは通らない
export default function LegalLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="mx-auto max-w-md min-h-dvh px-4 py-8">
      <p className="text-center text-xs text-ink-faint">{LEGAL.serviceName}</p>
      <div className="mt-4 rounded-3xl border border-rule bg-card p-6 shadow-sm">{children}</div>
      <nav className="mt-6 flex items-center justify-center gap-4 text-xs text-ink-faint">
        <Link href="/legal/privacy" className="underline underline-offset-4">
          プライバシーポリシー
        </Link>
        <Link href="/legal/terms" className="underline underline-offset-4">
          利用規約
        </Link>
        <Link href="/login" className="underline underline-offset-4">
          アプリへ戻る
        </Link>
      </nav>
    </div>
  );
}
