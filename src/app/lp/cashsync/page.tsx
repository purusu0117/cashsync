import type { Metadata } from "next";
import Link from "next/link";

// CashSync 製品詳細ページ（Sync Apps LP 配下の1アプリページ）。
// 親＝ /lp（Sync Apps ハブ）。アプリが増えるたび /lp/<app> を足していく。
// アプリ本体と同じ「感熱紙レシート」の世界観。TestFlightベータへの導線を主役に。
const TESTFLIGHT = "https://testflight.apple.com/join/mqJwAB7w";

export const metadata: Metadata = {
  title: "CashSync ｜ スクショを撮るだけの家計簿",
  description:
    "レシートやQR決済のスクショを撮るだけ。店名・カテゴリ・品目・金額をAIが自動入力。入力3秒の家計簿アプリ。iOSベータテスター募集中。",
  openGraph: {
    title: "CashSync ｜ スクショを撮るだけの家計簿",
    description:
      "レシート・QR決済のスクショを撮るだけで、店名・カテゴリ・品目・金額をAIが自動入力。入力3秒の家計簿。iOSベータ募集中。",
    siteName: "Sync Apps",
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "CashSync ｜ スクショを撮るだけの家計簿",
    description:
      "レシート・QR決済のスクショを撮るだけで、店名・カテゴリ・品目・金額をAIが自動入力。入力3秒の家計簿。iOSベータ募集中。",
  },
};

function Dot({ children }: { children: React.ReactNode }) {
  return <span style={{ fontFamily: "var(--font-dot)" }}>{children}</span>;
}

export default function CashSyncPage() {
  return (
    <main className="mx-auto min-h-full max-w-[560px] px-5 pb-16 pt-6 text-ink">
      {/* Sync Apps ハブへ戻る */}
      <Link
        href="/lp"
        className="inline-flex items-center gap-1 text-xs text-ink-faint underline underline-offset-4"
      >
        ← <Dot>Sync Apps</Dot>
      </Link>

      {/* ヘッダー */}
      <header className="mt-6 text-center">
        <p className="text-xs tracking-[0.3em] text-ink-faint">
          <Dot>CASH SYNC</Dot>
        </p>
        <h1 className="mt-3 text-3xl font-bold leading-tight tracking-[0.02em]">
          スクショを撮るだけの
          <br />
          <span className="text-vermilion">家計簿</span>
        </h1>
        <p className="mt-4 text-sm leading-relaxed text-ink-faint">
          レシートも、QR決済の支払い画面も。
          <br />
          撮るだけで<strong className="text-ink">店名・カテゴリ・品目・金額</strong>を
          <br />
          AIが自動で入力します。入力3秒。
        </p>
        <a
          href={TESTFLIGHT}
          className="mt-6 inline-block w-full rounded-2xl bg-vermilion px-6 py-4 text-base font-bold text-card shadow-sm active:translate-y-0.5"
        >
          iOSベータに参加する（無料）
        </a>
        <p className="mt-2 text-[11px] text-ink-faint">
          ※ TestFlightアプリで開きます。iPhone対応。
        </p>
      </header>

      {/* レシート風カード：ビフォー→アフター */}
      <section className="mt-10 rounded-2xl border border-rule bg-card px-5 py-6 shadow-sm">
        <p className="text-center text-[11px] tracking-[0.2em] text-ink-faint">
          <Dot>―― RECEIPT ――</Dot>
        </p>
        <ul className="mt-4 space-y-2 text-sm">
          <li className="flex items-baseline">
            <span className="text-ink-faint">今までの家計簿</span>
            <span className="mx-2 flex-1 self-end border-b border-dashed border-rule" />
            <span className="font-bold text-ink-faint">手入力でめんどう</span>
          </li>
          <li className="flex items-baseline">
            <span>スクショを撮る</span>
            <span className="mx-2 flex-1 self-end border-b border-dashed border-rule" />
            <span className="font-bold text-sage">3秒で記録</span>
          </li>
          <li className="flex items-baseline">
            <span>カテゴリ・品目</span>
            <span className="mx-2 flex-1 self-end border-b border-dashed border-rule" />
            <span className="font-bold text-sage">自動で分類</span>
          </li>
          <li className="flex items-baseline">
            <span>元のスクショ</span>
            <span className="mx-2 flex-1 self-end border-b border-dashed border-rule" />
            <span className="font-bold text-sage">アプリ内で削除</span>
          </li>
        </ul>
      </section>

      {/* 主要機能 */}
      <section className="mt-10 space-y-4">
        <h2 className="text-center text-lg font-bold">
          <Dot>できること</Dot>
        </h2>
        {[
          {
            t: "撮るだけで全部入力",
            d: "レシートを撮ると、店名・日付・合計・カテゴリ・品目までAIが読み取って自動入力。あなたは確認して保存するだけ。",
          },
          {
            t: "QR決済の画面もOK",
            d: "QR決済やネット注文の支払い/確認画面のスクショから、支出・収入も自動で判別して記録します。",
          },
          {
            t: "スクショはアプリ内で削除",
            d: "読み取ったあと、元のスクリーンショットをアプリからそのまま削除。写真フォルダが散らかりません。",
          },
          {
            t: "グラフ・カレンダー・バイト給料計算",
            d: "支出の可視化、カレンダー表示、シフトからの給料計算まで。家計をまるっと管理できます。",
          },
        ].map((f) => (
          <div key={f.t} className="rounded-2xl border border-rule bg-card px-5 py-4 shadow-sm">
            <p className="flex items-center gap-2 font-bold">
              <span className="inline-block h-2 w-2 shrink-0 rounded-full bg-vermilion" />
              {f.t}
            </p>
            <p className="mt-1.5 text-sm leading-relaxed text-ink-faint">{f.d}</p>
          </div>
        ))}
      </section>

      {/* CTA 再掲 */}
      <section className="mt-12 rounded-2xl border border-vermilion bg-card px-6 py-8 text-center shadow-sm">
        <p className="text-lg font-bold">いま、ベータテスター募集中</p>
        <p className="mt-2 text-sm leading-relaxed text-ink-faint">
          正式リリース前のアプリを、ひと足先に無料で使えます。
          <br />
          感想やご要望も大歓迎です。
        </p>
        <a
          href={TESTFLIGHT}
          className="mt-5 inline-block w-full rounded-2xl bg-vermilion px-6 py-4 text-base font-bold text-card shadow-sm active:translate-y-0.5"
        >
          TestFlightで参加する
        </a>
      </section>

      <footer className="mt-10 text-center text-[11px] leading-relaxed text-ink-faint">
        <p>
          <Link href="/lp" className="underline underline-offset-2">
            <Dot>← Sync Apps のトップへ</Dot>
          </Link>
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
