import Link from "next/link";

// iPhoneショートカット連携のヘルプ（認証不要の公開ページ・/legal と同様の簡素な静的ページ）。
// ショートカット本体は iCloud リンクで配布する前提の手順骨子。
export const metadata = { title: "ショートカット連携の使い方 | CashSync" };

const STEPS: { title: string; body: string }[] = [
  {
    title: "ショートカットを追加する",
    body: "配布されているiCloudリンク（CashSyncショートカット）をiPhoneで開き、「ショートカットを追加」をタップします。App Storeの「ショートカット」アプリが必要です。",
  },
  {
    title: "アプリをホーム画面に追加する",
    body: "SafariでCashSyncを開き、共有メニューから「ホーム画面に追加」しておくと、記録後にアプリへ戻る動きがスムーズになります。",
  },
  {
    title: "ホームの「スクショ」ボタンから起動する",
    body: "CashSyncのホームで「スクショ」をタップ→「ショートカットで開く」を選ぶと、連携キーは自動で渡されます（手動でキーを入力する必要はありません）。",
  },
  {
    title: "初回だけ許可を与える",
    body: "初回実行時に「写真へのアクセス」「CashSyncへの接続」の確認が出るので許可します。以降は、最新のスクショの読み取り→記録→スクショの削除確認までワンタップで進みます。",
  },
];

export default function ShortcutHelpPage() {
  return (
    <div className="mx-auto max-w-md min-h-dvh px-4 py-8">
      <p className="text-center text-xs text-ink-faint">CashSync ヘルプ</p>
      <div className="mt-4 rounded-3xl border border-rule bg-card p-6 shadow-sm">
        <h1 className="text-lg font-bold">iPhoneショートカット連携の使い方</h1>
        <p className="mt-2 text-xs leading-relaxed text-ink-faint">
          ショートカットを使うと、PayPay等の支払いスクショを「読み取り→記録→スクショ削除」までワンタップで処理できます。
        </p>
        <ol className="mt-4 space-y-4">
          {STEPS.map((s, i) => (
            <li key={i} className="flex gap-3">
              <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-ink text-sm font-bold tabular-nums">
                {i + 1}
              </span>
              <div className="min-w-0">
                <p className="text-sm font-medium">{s.title}</p>
                <p className="mt-0.5 text-xs leading-relaxed text-ink-faint">{s.body}</p>
              </div>
            </li>
          ))}
        </ol>
        <div className="mt-5 border-t border-rule pt-4">
          <p className="text-xs font-bold tracking-[0.04em]">うまく動かないとき</p>
          <ul className="mt-1 list-disc pl-4 text-xs leading-relaxed text-ink-faint">
            <li>設定画面の「連携キー」をコピーし直し、ショートカット側の入力を確認してください。</li>
            <li>ショートカットが見つからない場合は、iCloudリンクからもう一度追加してください。</li>
            <li>連携なしでも、ホームの「スクショ」→「写真から選ぶ」で同じ記録ができます。</li>
          </ul>
        </div>
      </div>
      <nav className="mt-6 flex items-center justify-center gap-4 text-xs text-ink-faint">
        <Link href="/settings" className="underline underline-offset-4">
          設定へ戻る
        </Link>
        <Link href="/" className="underline underline-offset-4">
          ホームへ
        </Link>
      </nav>
    </div>
  );
}
