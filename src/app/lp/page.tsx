import type { Metadata } from "next";
import Link from "next/link";

// Sync Apps ハブ（母艦LP）。個人開発の思い＋公開アプリの一覧。
// アプリが増えるたびここに1枚カードを足し、詳細は /lp/<app> に置く。
export const metadata: Metadata = {
  title: "Sync Apps ｜ 日常の“ちょっと面倒”を自動化する",
  description:
    "個人開発で、毎日の小さな手間を減らすアプリを作っています。第一弾は、撮るだけの家計簿「CashSync」。",
  openGraph: {
    title: "Sync Apps ｜ 日常の“ちょっと面倒”を自動化する",
    description:
      "個人開発で、毎日の小さな手間を減らすアプリを作っています。第一弾は、撮るだけの家計簿「CashSync」。",
    siteName: "Sync Apps",
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "Sync Apps ｜ 日常の“ちょっと面倒”を自動化する",
    description:
      "個人開発で、毎日の小さな手間を減らすアプリを作っています。第一弾は、撮るだけの家計簿「CashSync」。",
  },
};

function Dot({ children }: { children: React.ReactNode }) {
  return <span style={{ fontFamily: "var(--font-dot)" }}>{children}</span>;
}

export default function SyncAppsHome() {
  return (
    <main className="mx-auto min-h-full max-w-[560px] px-5 pb-16 pt-12 text-ink">
      {/* ヘッダー：ブランド＋ミッション */}
      <header className="text-center">
        <p className="text-xs tracking-[0.34em] text-ink-faint">
          <Dot>SYNC APPS</Dot>
        </p>
        <h1 className="mt-4 text-[28px] font-bold leading-snug tracking-[0.02em]">
          日常の“ちょっと面倒”を、
          <br />
          <span className="text-vermilion">自動化する。</span>
        </h1>
        <p className="mx-auto mt-5 max-w-[380px] text-sm leading-relaxed text-ink-faint">
          個人開発で、毎日の小さな手間を減らすアプリを作っています。
          家計簿の入力、レシートの整理——地味な手間ほど、
          しくみで消す価値がある。そう思って、ひとつずつ形にしています。
        </p>
      </header>

      {/* 公開アプリ */}
      <section className="mt-12">
        <p className="text-center text-[11px] tracking-[0.28em] text-ink-faint">
          <Dot>―― APPS ――</Dot>
        </p>

        {/* CashSync カード → 詳細へ */}
        <Link
          href="/lp/cashsync"
          className="mt-5 block rounded-3xl border border-rule bg-card p-5 shadow-sm transition active:translate-y-0.5"
        >
          <div className="flex items-center gap-4">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src="/icons/icon-512.png"
              alt="CashSync"
              className="h-16 w-16 shrink-0 rounded-2xl border border-rule"
            />
            <div className="min-w-0">
              <p className="text-lg font-bold leading-none">CashSync</p>
              <p className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-ink-faint">
                <span className="rounded-full bg-paper px-2 py-0.5">家計簿</span>
                <span className="rounded-full bg-sage/10 px-2 py-0.5 font-bold text-sage">
                  App Store で配信中
                </span>
              </p>
            </div>
          </div>
          <p className="mt-4 text-sm leading-relaxed text-ink-faint">
            レシートやQR決済のスクショを撮るだけ。店名・カテゴリ・品目・金額まで
            AIが自動で記録する、入力3秒の家計簿。
          </p>
          <p className="mt-4 flex items-center justify-end gap-1 text-sm font-bold text-vermilion">
            詳細を見る <span aria-hidden>→</span>
          </p>
        </Link>

        {/* 制作中（増やしていく余白） */}
        <div className="mt-4 rounded-3xl border border-dashed border-rule px-5 py-6 text-center">
          <p className="text-sm font-bold text-ink-faint">次のアプリ、制作中</p>
          <p className="mt-1 text-[12px] leading-relaxed text-ink-faint">
            「あったらいいな」を、これからも少しずつ。
          </p>
        </div>
      </section>

      <footer className="mt-12 text-center text-[11px] leading-relaxed text-ink-faint">
        <p>
          <Dot>Sync Apps ｜ 個人開発</Dot>
        </p>
        <p className="mt-2 flex flex-wrap items-center justify-center gap-x-3 gap-y-1">
          <a href="/legal/support" className="underline underline-offset-2">サポート・FAQ</a>
          <a href="/legal/privacy" className="underline underline-offset-2">プライバシー</a>
          <a href="/legal/terms" className="underline underline-offset-2">利用規約</a>
        </p>
        <p className="mt-2">© 2026 Sync Apps</p>
      </footer>
    </main>
  );
}
