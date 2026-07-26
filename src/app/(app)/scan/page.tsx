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
  // 確認シートに最初に表示した提案（AI or 学習値）。保存時にサーバーへ渡し、
  // ユーザーがここから変更していたら「この店の正しいカテゴリ」として学習される。
  const [suggestedCategoryId, setSuggestedCategoryId] = useState<string | null>(null);
  const [learned, setLearned] = useState(false); // 過去の修正から学習したカテゴリを適用中か
  // 保存時にサーバーが409（同一日付×金額×店名の既存記録あり）を返したら true。
  // 「本当に同じものを2回買った」ケースを救済するため、確認のうえ allowDuplicate: true で再送信できる。
  const [dupConfirm, setDupConfirm] = useState(false);

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
    setDupConfirm(false);
    setFromLibrary(lib);
    setPreview(URL.createObjectURL(file));
    setPhase("scanning");
    try {
      const form = new FormData();
      form.append("image", file);
      const res = await fetch("/api/scan-receipt", { method: "POST", body: form });
      const d = await res.json();
      if (!res.ok) throw new Error(d.error ?? "解析に失敗しました。");
      setScan({ ...d.scan, date: d.scan.date || todayLocal() });
      setCategoryId(d.categoryId);
      setSuggestedCategoryId(d.categoryId);
      setLearned(!!d.learned);
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

  async function save(allowDuplicate = false) {
    if (!scan) return;
    setError("");
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
                dedupe: true, // 同じスクショの二重読み取り防止（手入力には影響しない）
                allowDuplicate, // 「本当に別の支払い」と確認済みの再送信のみ true
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
                suggestedCategoryId, // 提案から変更されていたらサーバーが店名→カテゴリを学習する
                items: scan.items,
                allowDuplicate, // 「本当に別の支払い」と確認済みの再送信のみ true
              }),
            });
      const d = await res.json();
      if (res.status === 409 && !allowDuplicate) {
        // 同じ内容の記録が既にある → エラーではなく「本当に別の支払い？」の確認に切り替える
        setDupConfirm(true);
        setPhase("confirm");
        return;
      }
      if (!res.ok) throw new Error(d.error ?? "保存に失敗しました。");
      setDupConfirm(false);
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
              <label className="block min-w-0 flex-1">
                <span className="dot text-xs text-ink-faint">日付</span>
                <input
                  type="date"
                  value={scan.date}
                  onChange={(e) => setScan({ ...scan, date: e.target.value })}
                  className="mt-1 w-full rounded-md border border-rule bg-paper px-3 py-2 text-base outline-none focus:border-ink"
                />
              </label>
              <label className="block min-w-0 flex-1">
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
              {learned && (
                <span
                  className="ml-1.5 rounded-full border border-rule bg-paper px-1.5 py-0.5 text-[10px] text-ink-faint"
                  title="この店で以前あなたが選んだカテゴリを適用しています"
                >
                  📌学習済み
                </span>
              )}
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
          {dupConfirm ? (
            // 重複検知：エラーで突き放さず「本当に別の支払いか」を確認してから記録できるようにする
            <div className="mt-4 rounded-md border border-vermilion bg-paper px-4 py-3">
              <p className="text-sm leading-relaxed text-ink">
                ⚠️ 同じ内容（{scan.date}・{fmtYen(scan.total)}・{scan.store || "店名なし"}
                ）を今日すでに記録しています。本当に別の{scan.kind === "income" ? "受け取り" : "支払い"}
                ですか？
              </p>
              <div className="mt-3 flex gap-2">
                <button
                  onClick={() => setDupConfirm(false)}
                  disabled={phase === "saving"}
                  className="flex-1 rounded-md border border-rule py-3 text-sm text-ink-faint"
                >
                  やめる
                </button>
                <button
                  onClick={() => save(true)}
                  disabled={phase === "saving"}
                  className="dot flex-[2] rounded-md bg-vermilion py-3 text-sm text-card shadow-[0_2px_0_var(--vermilion-deep)] active:translate-y-0.5 active:shadow-none disabled:opacity-50"
                >
                  {phase === "saving" ? "保存中・・・" : `別の${scan.kind === "income" ? "受け取り" : "支払い"}なので記録する`}
                </button>
              </div>
            </div>
          ) : (
          <div className="mt-4 flex gap-2">
            <button
              onClick={() => {
                setScan(null);
                setDupConfirm(false);
                setPhase("idle");
              }}
              className="flex-1 rounded-md border border-rule py-3 text-sm text-ink-faint"
            >
              撮り直す
            </button>
            <button
              onClick={() => save()}
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
          )}
        </div>
      )}
    </div>
  );
}
