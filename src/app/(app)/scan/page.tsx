"use client";

// レシート撮影 → AI解析 → 確認シート → 保存（全自動保存はしない：人間が最終確定）
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { fmtYen, todayLocal } from "@/lib/format";
import { takePendingImage } from "@/lib/pendingImage";

interface Scan {
  kind: "expense" | "income";
  store: string;
  date: string;
  total: number;
  category: string;
  items: { name: string; price: number }[];
}
interface Category {
  id: string;
  name: string;
  icon: string;
}

export default function ScanPage() {
  const router = useRouter();
  const fileRef = useRef<HTMLInputElement>(null);
  const libRef = useRef<HTMLInputElement>(null);
  const [phase, setPhase] = useState<"idle" | "scanning" | "confirm" | "saving" | "done">("idle");
  const [fromLibrary, setFromLibrary] = useState(false);
  const [error, setError] = useState("");
  const [preview, setPreview] = useState("");
  const [scan, setScan] = useState<Scan | null>(null);
  const [categories, setCategories] = useState<Category[]>([]);
  const [categoryId, setCategoryId] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/categories")
      .then((r) => r.json())
      .then((d) => setCategories(d.categories ?? []));
    // 下タブ「撮る」やホームのボタンで既に画像が選ばれていたら、即解析を開始
    const consume = () => {
      const pending = takePendingImage();
      if (pending) scanFile(pending.file, pending.fromLibrary);
    };
    consume();
    // すでに /scan を開いた状態で「撮る」を押した場合はイベント経由で受け取る
    window.addEventListener("cashsync-scan-image", consume);
    return () => window.removeEventListener("cashsync-scan-image", consume);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function scanFile(file: File, lib = false) {
    setError("");
    setFromLibrary(lib);
    setPreview(URL.createObjectURL(file));
    setPhase("scanning");
    try {
      const form = new FormData();
      form.append("image", file);
      const res = await fetch("/api/scan-receipt", { method: "POST", body: form });
      const d = await res.json();
      // error:'limit'（無料枠超過）のときは message に日本語の案内が入る
      if (!res.ok) throw new Error(d.message ?? d.error ?? "解析に失敗しました。");
      setScan({ ...d.scan, date: d.scan.date || todayLocal() });
      setCategoryId(d.categoryId);
      setPhase("confirm");
    } catch (err) {
      setError(err instanceof Error ? err.message : "解析に失敗しました。");
      setPhase("idle");
    }
  }

  function onFile(e: React.ChangeEvent<HTMLInputElement>, lib: boolean) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (file) scanFile(file, lib);
  }

  async function save() {
    if (!scan) return;
    setPhase("saving");
    try {
      // 受け取り（収入）は incomes へ、支払いは receipts+expenses へ
      const res =
        scan.kind === "income"
          ? await fetch("/api/incomes", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                amount: scan.total,
                date: scan.date,
                memo: scan.store || "スクショ収入",
              }),
            })
          : await fetch("/api/receipts", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                store: scan.store,
                date: scan.date,
                total: scan.total,
                categoryId,
                items: scan.items,
              }),
            });
      const d = await res.json();
      if (!res.ok) throw new Error(d.error ?? "保存に失敗しました。");
      if (fromLibrary) {
        // スクショ由来のときは「元画像はもう不要」のリマインドを出してから帰る
        setPhase("done");
      } else {
        router.push("/");
        router.refresh();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "保存に失敗しました。");
      setPhase("confirm");
    }
  }

  return (
    <div className="space-y-4">
      <h1 className="dot text-lg">レシート・スクショを読み取る</h1>
      <input
        ref={fileRef}
        type="file"
        accept="image/*"
        capture="environment"
        onChange={(e) => onFile(e, false)}
        className="hidden"
      />
      <input
        ref={libRef}
        type="file"
        accept="image/*"
        onChange={(e) => onFile(e, true)}
        className="hidden"
      />

      {phase === "idle" && (
        <div className="space-y-3">
          <button
            onClick={() => fileRef.current?.click()}
            className="zig zig-t zig-b w-full px-6 py-10 text-center shadow-sm active:translate-y-0.5"
          >
            <span className="text-5xl">📷</span>
            <span className="dot mt-3 block text-lg">レシートを撮影</span>
            <span className="mt-1 block text-xs text-ink-faint">
              店名・金額・カテゴリはAIが読み取ります
            </span>
          </button>
          <button
            onClick={() => libRef.current?.click()}
            className="zig zig-t zig-b w-full px-6 py-6 text-center shadow-sm active:translate-y-0.5"
          >
            <span className="text-3xl">🖼️</span>
            <span className="dot mt-1 block text-base">スクショ・画像から読み取る</span>
            <span className="mt-1 block text-xs text-ink-faint">
              PayPayの支払い画面・ネット注文の確認画面などもOK
            </span>
          </button>
          {error && <p className="text-center text-sm text-vermilion">{error}</p>}
          <p className="text-center text-[11px] leading-relaxed text-ink-faint">
            読み取り結果は保存前に必ず確認できます。
          </p>
        </div>
      )}

      {phase === "scanning" && (
        <div className="space-y-4">
          {preview && (
            /* eslint-disable-next-line @next/next/no-img-element */
            <img src={preview} alt="レシート" className="mx-auto max-h-64 rounded-md border border-rule" />
          )}
          <div className="zig zig-t zig-b px-5 py-6 text-center shadow-sm">
            <p className="dot printing text-lg">＊＊＊ 解析中 ＊＊＊</p>
            <p className="mt-2 text-xs text-ink-faint">
              AIがレシートを読み取っています（数十秒かかることがあります）
            </p>
          </div>
        </div>
      )}

      {phase === "done" && (
        <div className="zig zig-t zig-b px-5 py-6 text-center shadow-sm">
          <p className="text-4xl">✅</p>
          <p className="dot mt-2 text-lg">記録しました</p>
          <div className="mx-auto mt-4 max-w-xs rounded-md border border-rule bg-paper px-4 py-3 text-left text-xs leading-relaxed">
            <p className="dot text-ink">🗑 元のスクショはもう不要です</p>
            <p className="mt-1 text-ink-faint">
              読み取った内容はアプリに保存済み。アプリから端末の写真は削除できない仕組み（ブラウザの制限）のため、お手数ですが写真アプリから削除してください。
            </p>
          </div>
          <button
            onClick={() => {
              router.push("/");
              router.refresh();
            }}
            className="dot mt-4 w-full rounded-md bg-vermilion py-3 text-base text-card shadow-[0_2px_0_var(--vermilion-deep)]"
          >
            ホームへ戻る
          </button>
        </div>
      )}

      {(phase === "confirm" || phase === "saving") && scan && (
        <div className="zig zig-t zig-b px-5 py-5 shadow-sm">
          <p className="dot text-center text-xs text-ink-faint">＊ 読み取り結果（修正できます）＊</p>
          <div className="mt-3 flex justify-center gap-1.5">
            <button
              onClick={() => setScan({ ...scan, kind: "expense" })}
              className={`rounded-full border px-4 py-1.5 text-sm ${
                scan.kind === "expense"
                  ? "border-vermilion bg-vermilion text-card"
                  : "border-rule bg-paper"
              }`}
            >
              支出
            </button>
            <button
              onClick={() => setScan({ ...scan, kind: "income" })}
              className={`rounded-full border px-4 py-1.5 text-sm ${
                scan.kind === "income" ? "border-sage bg-sage text-card" : "border-rule bg-paper"
              }`}
            >
              💰 収入
            </button>
          </div>
          <div className="mt-3 space-y-3">
            <label className="block">
              <span className="dot text-xs text-ink-faint">店名</span>
              <input
                value={scan.store}
                onChange={(e) => setScan({ ...scan, store: e.target.value })}
                className="mt-1 w-full rounded-md border border-rule bg-paper px-3 py-2 text-base outline-none focus:border-ink"
                placeholder="店名"
              />
            </label>
            <div className="flex gap-3">
              <label className="block flex-1">
                <span className="dot text-xs text-ink-faint">日付</span>
                <input
                  type="date"
                  value={scan.date}
                  onChange={(e) => setScan({ ...scan, date: e.target.value })}
                  className="mt-1 w-full rounded-md border border-rule bg-paper px-3 py-2 text-base outline-none focus:border-ink"
                />
              </label>
              <label className="block flex-1">
                <span className="dot text-xs text-ink-faint">合計</span>
                <input
                  type="number"
                  inputMode="numeric"
                  value={scan.total || ""}
                  onChange={(e) => setScan({ ...scan, total: Number(e.target.value) })}
                  className="dot mt-1 w-full rounded-md border border-rule bg-paper px-3 py-2 text-xl tabular-nums outline-none focus:border-ink"
                />
              </label>
            </div>
            {scan.kind === "expense" && (
            <div>
              <span className="dot text-xs text-ink-faint">カテゴリ</span>
              <div className="mt-1.5 flex flex-wrap gap-1.5">
                {categories.map((c) => (
                  <button
                    key={c.id}
                    onClick={() => setCategoryId(c.id)}
                    className={`rounded-full border px-3 py-1.5 text-sm ${
                      categoryId === c.id
                        ? "border-vermilion bg-vermilion text-card"
                        : "border-rule bg-paper text-ink"
                    }`}
                  >
                    {c.icon} {c.name}
                  </button>
                ))}
              </div>
            </div>
            )}
            {scan.kind === "expense" && scan.items.length > 0 && (
              <div>
                <p className="dot text-xs text-ink-faint">品目（明細として保存されます）</p>
                <ul className="mt-1">
                  {scan.items.map((it, i) => (
                    <li key={i} className="flex items-baseline py-0.5 text-sm">
                      <span className="truncate">{it.name}</span>
                      <span className="leader" />
                      <span className="dot tabular-nums">{fmtYen(it.price)}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
          {error && <p className="mt-2 text-sm text-vermilion">{error}</p>}
          <div className="mt-4 flex gap-2">
            <button
              onClick={() => {
                setScan(null);
                setPhase("idle");
              }}
              className="flex-1 rounded-md border border-rule py-3 text-sm text-ink-faint"
            >
              撮り直す
            </button>
            <button
              onClick={save}
              disabled={phase === "saving" || !scan.total}
              className={`dot flex-[2] rounded-md py-3 text-lg text-card active:translate-y-0.5 active:shadow-none disabled:opacity-50 ${
                scan.kind === "income"
                  ? "bg-sage shadow-[0_2px_0_#1f6b42]"
                  : "bg-vermilion shadow-[0_2px_0_var(--vermilion-deep)]"
              }`}
            >
              {phase === "saving"
                ? "保存中・・・"
                : `${fmtYen(scan.total)} を${scan.kind === "income" ? "収入として" : ""}記録`}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
