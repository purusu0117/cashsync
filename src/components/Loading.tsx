// レシート印字風のローディング表示。
// 初回読み込み（キャッシュ未保存）時に、デフォルト値の画面ではなくこれを見せる。
export default function Loading({ label = "読み込み中・・・" }: { label?: string }) {
  return (
    <div className="mt-16 flex flex-col items-center gap-3 text-ink-faint">
      <div className="zig zig-b h-24 w-40 printing" />
      <p className="dot text-sm">{label}</p>
    </div>
  );
}
