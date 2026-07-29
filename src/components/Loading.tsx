// ローディング表示。
// 初回読み込み（キャッシュ未保存）時に、デフォルト値の画面ではなくこれを見せる。
export default function Loading({ label = "読み込み中・・・" }: { label?: string }) {
  return (
    <div className="mt-16 flex flex-col items-center gap-3 text-ink-faint">
      <div className="h-24 w-40 animate-pulse rounded-2xl bg-paper" />
      <p className="text-sm font-medium text-ink-faint">{label}</p>
    </div>
  );
}
