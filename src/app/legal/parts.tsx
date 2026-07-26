// 法務ページ用の小さな組版部品（レシート世界観・読みやすさ優先）
export function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="cutline mt-5 pt-4 first:mt-0 first:border-t-0 first:pt-0">
      <h2 className="dot text-sm">{title}</h2>
      <div className="mt-1.5 space-y-2 text-[13px] leading-relaxed">{children}</div>
    </section>
  );
}

export function Ul({ children }: { children: React.ReactNode }) {
  return <ul className="list-disc space-y-1 pl-5">{children}</ul>;
}

export function Faint({ children }: { children: React.ReactNode }) {
  return <p className="text-[11px] text-ink-faint">{children}</p>;
}
