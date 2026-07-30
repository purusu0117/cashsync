"use client";

// レシート撮影 → AI解析 → 確認シート → 保存（全自動保存はしない：人間が最終確定）
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import {
  CameraIcon,
  CategoryIcon,
  CheckCircleIcon,
  CoinIcon,
  ImageIcon,
  PinIcon,
  TrashIcon,
} from "@/components/Icons";
import RewardCredit from "@/components/RewardCredit";
import { cachedFetch } from "@/lib/cachedFetch";
import { netFetch } from "@/lib/clientApi";
import { fmtDateJa, fmtYen, todayLocal } from "@/lib/format";
import { capGlobal, deletePhotos, isNativePlatform, listRecentScreenshots } from "@/lib/native";
import { parseReceiptText } from "@/lib/localReceipt";
import { takePendingImage } from "@/lib/pendingImage";
import { track } from "@/lib/track";

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

/** 端末内OCR経路の重複判定用に画像内容のsha256を返す（サーバーに画像は送らない）。 */
// 反映確認用の版マーカー。Web修正を出すたびに更新する。実機のスキャン画面下部に表示され、
// 「端末が最新Webを読んでいるか」を一目で確認できる（古い文字列＝キャッシュ未更新）。
const SCAN_ENGINE_VER = "T25-0730l";

async function sha256Hex(input: string): Promise<string> {
  try {
    const h = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
    return Array.from(new Uint8Array(h))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  } catch {
    return "";
  }
}

/** Promise に上限時間を付ける（超えたら reject）。端末内OCRが固まらないための安全網。 */
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error("timeout")), ms)),
  ]);
}

/**
 * File を長辺 maxDim 以内の JPEG dataURL に縮小して返す。
 * iOS WebView では createImageBitmap(File) が返らず固まることがあった（画像がOCRに届かない主因）。
 * そこで object URL＋<img> で確実にデコードする（PNG/JPEG/HEIC いずれもiOSのimgは表示可）。
 * imgのload自体にも上限時間を付け、返らなければ即エラーにする（無限待ちにしない）。
 */
async function downscaleFile(file: File, maxDim: number, quality: number): Promise<string> {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const im = new Image();
      const t = setTimeout(() => reject(new Error("img load timeout")), 8000);
      im.onload = () => { clearTimeout(t); resolve(im); };
      im.onerror = () => { clearTimeout(t); reject(new Error("img load error")); };
      im.src = url;
    });
    const iw = img.naturalWidth || img.width;
    const ih = img.naturalHeight || img.height;
    const scale = Math.min(1, maxDim / Math.max(iw, ih, 1));
    const w = Math.max(1, Math.round(iw * scale));
    const h = Math.max(1, Math.round(ih * scale));
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("no 2d context");
    ctx.drawImage(img, 0, 0, w, h);
    return canvas.toDataURL("image/jpeg", quality);
  } finally {
    URL.revokeObjectURL(url);
  }
}

export default function ScanPage() {
  const router = useRouter();
  const fileRef = useRef<HTMLInputElement>(null);
  const libRef = useRef<HTMLInputElement>(null);
  const [phase, setPhase] = useState<
    "idle" | "scanning" | "failed" | "confirm" | "saving" | "done"
  >("idle");
  const [elapsed, setElapsed] = useState(0); // C5: 解析中の経過秒数
  const [fromLibrary, setFromLibrary] = useState(false);
  const [error, setError] = useState("");
  const [preview, setPreview] = useState("");
  const [scan, setScan] = useState<Scan | null>(null);
  const [imageHash, setImageHash] = useState(""); // 読み取った画像のsha256（保存時に渡す）
  const [jobId, setJobId] = useState(""); // C5: 読み取りジョブのID（保存/破棄時に消す）
  const [categories, setCategories] = useState<Category[]>([]);
  const [categoryId, setCategoryId] = useState<string | null>(null);
  // 確認シートに最初に表示した提案（AI or 学習値）。保存時にサーバーへ渡し、
  // ユーザーがここから変更していたら「この店の正しいカテゴリ」として学習される。
  const [suggestedCategoryId, setSuggestedCategoryId] = useState<string | null>(null);
  const [learned, setLearned] = useState(false); // 過去の修正から学習したカテゴリを適用中か
  // 保存時にサーバーが409（同一日付×金額×店名の既存記録あり）を返したら true。
  // 「本当に同じものを2回買った」ケースを救済するため、確認のうえ allowDuplicate: true で再送信できる。
  const [dupConfirm, setDupConfirm] = useState(false);
  // 無料枠超過（429 limit）のとき、ネイティブでは「動画を見て+3回」を出す
  const [limitHit, setLimitHit] = useState(false);
  // ネイティブ判定はSSRとの不一致を避けるためマウント後に行う
  const [native, setNative] = useState(false);
  // スクショ由来のとき、元ファイルの更新時刻（端末内のスクショ特定に使う）
  const [sourceTakenAt, setSourceTakenAt] = useState(0);
  const [cleanState, setCleanState] = useState<
    "idle" | "busy" | "done" | "cancelled" | "notfound" | "error"
  >("idle");
  // レシート内分割：1枚のレシートを品目ごとに複数カテゴリへ按分して保存するモード。
  // 既定はOFF（従来どおり1件保存）。ONのときだけ splitRows を使って複数 expense を作る。
  const [splitMode, setSplitMode] = useState(false);
  const [splitRows, setSplitRows] = useState<
    { name: string; amount: number; categoryId: string | null }[]
  >([]);

  const [onDevice, setOnDevice] = useState(false); // 端末内OCR搭載ビルド（build26+）＝AI/通信なし
  const [scanDbg, setScanDbg] = useState(""); // 端末内OCRの実挙動診断（失敗時に画面表示して原因を可視化）
  const [recheck, setRecheck] = useState(false); // 検算不一致（金額の読み取りミス疑い）で撮り直しを促す
  // 実機(Apple Vision)が実際に吐いた生OCRテキスト。確認画面に折りたたみ表示し、
  // 解析がずれたときにこの生テキストをそのまま開発側へ渡してパーサーを実機データに合わせる。
  const [rawOcr, setRawOcr] = useState("");
  useEffect(() => {
    setNative(isNativePlatform());
    setOnDevice(isNativePlatform());
  }, []);

  // B12: 今月のAI読み取り残量（無料プランのみ数値。無制限プランは非表示）
  const [scansLeft, setScansLeft] = useState<number | null>(null);

  useEffect(() => {
    fetch("/api/categories")
      .then((r) => r.json())
      .then((d) => setCategories(d.categories ?? []));
    cachedFetch<{ aiUsage?: { scans: { used: number; limit: number | null } } }>(
      "/api/profile",
      (d) => {
        const s = d.aiUsage?.scans;
        setScansLeft(s && s.limit !== null ? Math.max(0, s.limit - s.used) : null);
      },
    ).catch(() => {});
    // C5: ホームの「読み取りが終わった記録があります」から来た場合は、その結果を開く
    if (new URLSearchParams(window.location.search).get("job") === "1") {
      fetch("/api/scan-jobs")
        .then((r) => (r.ok ? r.json() : { jobs: [] }))
        .then((d) => {
          const job = d.jobs?.[0];
          if (!job?.scan) return;
          setJobId(job.id);
          setScan({ ...job.scan, date: job.scan.date || todayLocal() });
          setImageHash(job.imageHash ?? "");
          setCategoryId(job.categoryId ?? null);
          setSuggestedCategoryId(job.categoryId ?? null);
          setLearned(!!job.learned);
          setPhase("confirm");
        })
        .catch(() => {});
    }
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

  // C5: 解析中は経過秒数を出す（待たされている感の軽減＋固まっていない安心感）
  // ※リセット（0に戻す）は scanFile 側で行い、ここではカウントだけする
  useEffect(() => {
    if (phase !== "scanning") return;
    const t = setInterval(() => setElapsed((s) => s + 1), 1000);
    return () => clearInterval(t);
  }, [phase]);

  async function scanFile(file: File, lib = false) {
    setError("");
    setDupConfirm(false);
    setRecheck(false); // 新しい読み取りのたびに検算フラグを戻す
    setRawOcr(""); // 新しい読み取りのたびに前回の生OCRテキストを消す
    setSplitMode(false); // 新しい読み取りのたびに分割モードは初期化
    setSplitRows([]);
    setLimitHit(false);
    setFromLibrary(lib);
    setSourceTakenAt(lib ? file.lastModified : 0);
    setCleanState("idle");
    setPreview(URL.createObjectURL(file));
    setElapsed(0);
    setPhase("scanning");
    // 端末内OCR(Apple Vision)のみ。全体に15秒のハード上限を付け、絶対に無限「解析中」にしない。
    // 15秒で必ず結果 or「認識できません(撮り直し/手入力)」に落ちる。サーバー(AI)へは一切行かない。
    if (isNativePlatform()) {
      const es = (e: unknown) => (e instanceof Error ? e.message : String(e));
      const diag = { msg: "" };
      try {
        const s = await withTimeout(
          (async () => {
            let small: string;
            const t0 = Date.now();
            try {
              small = await downscaleFile(file, 1280, 0.7);
            } catch (e) {
              diag.msg = `画像の縮小に失敗（${file.type || "型不明"}）: ${es(e)}`;
              throw e;
            }
            const kb = Math.round(small.length / 1024);
            diag.msg = `縮小OK ${Date.now() - t0}ms ${kb}KB → プラグイン取得中`;
            // プラグイン取得は「同期のみ」。await/動的importを一切使わない（それらが iOS WebView で
            // 返らず固まるのが真因だった）。window.Capacitor から直接 registerPlugin で掴む。
            const capg = capGlobal();
            let plugin = capg?.Plugins?.["VisionOcr"] as
              | { recognize?: (o: { image: string }) => Promise<{ text?: string }> }
              | undefined;
            let acq = plugin ? "inj" : "";
            if ((!plugin || typeof plugin.recognize !== "function") && typeof capg?.registerPlugin === "function") {
              try {
                plugin = capg.registerPlugin("VisionOcr");
                acq = "reg";
              } catch (e) {
                acq = `regErr:${es(e)}`;
              }
            }
            if (!plugin || typeof plugin.recognize !== "function") {
              diag.msg = `プラグイン取得不可(${kb}KB) Cap=${!!capg} Plugins=${!!capg?.Plugins} regFn=${typeof capg?.registerPlugin} inj=${!!capg?.Plugins?.["VisionOcr"]} acq=${acq}`;
              return null;
            }
            // recognize を「成功/エラー/12秒無応答」で確実に切り分けて診断に残す。
            diag.msg = `縮小OK ${kb}KB → recognize呼出→応答待ち`;
            const tR = Date.now();
            const recognize = plugin.recognize!;
            const outcome = await Promise.race([
              recognize({ image: small })
                .then((r) => ({ kind: "ok" as const, text: r?.text ?? "" }))
                .catch((e) => ({ kind: "err" as const, msg: es(e) })),
              new Promise<{ kind: "to" }>((res) => setTimeout(() => res({ kind: "to" }), 12000)),
            ]);
            if (outcome.kind === "to") {
              diag.msg = `recognize 12秒無応答（Vision内部で停止）画像${kb}KB`;
              return null;
            }
            if (outcome.kind === "err") {
              diag.msg = `recognize エラー(${Date.now() - tR}ms): ${outcome.msg}`;
              return null;
            }
            const text = outcome.text;
            setRawOcr(text); // 実機Visionの生出力を確認画面に出せるよう保持（解析ズレ時の調整用）
            diag.msg = text.length
              ? `OCR ${text.length}字 (${Date.now() - tR}ms) 先頭「${text.replace(/\n/g, " ").slice(0, 30)}」`
              : `OCR=空文字 (${Date.now() - tR}ms) 画像${kb}KB`;
            return text.length ? parseReceiptText(text, categories.map((c) => c.name), todayLocal()) : null;
          })(),
          15000,
        );
        // 検算で合計が明細と矛盾（数字の読み取りミスの疑い）→ 確認画面に進めず撮り直しへ誘導。
        if (s && s.needsRecheck) {
          setRecheck(true);
          diag.msg = `明細の合計と読み取った金額(¥${s.total})が一致しません`;
          setScanDbg(diag.msg);
          setPhase("failed");
          return;
        }
        if (s && (s.total > 0 || (s.store ?? "").trim())) {
          track("scan_used");
          const catId = categories.find((c) => c.name === s.category)?.id ?? null;
          setScan({ ...s, date: s.date || todayLocal() });
          const dataUrl = await new Promise<string>((resolve) => {
            const r = new FileReader();
            r.onload = () => resolve(String(r.result));
            r.onerror = () => resolve("");
            r.readAsDataURL(file);
          });
          setImageHash(await sha256Hex(dataUrl));
          setCategoryId(catId);
          setSuggestedCategoryId(catId);
          setLearned(false);
          setPhase("confirm");
          return;
        }
        if (s) diag.msg += " / 解析: 合計・店名を取れず";
        if (!diag.msg) diag.msg = "15秒でタイムアウト（Visionが返らない）";
      } catch (e) {
        if (!diag.msg) diag.msg = `例外: ${es(e)}`;
      }
      setScanDbg(diag.msg);
      setPhase("failed"); // 無限「解析中」にしない。サーバー(AI)にも行かない。
      return;
    }
    try {
      // C5: 解析はサーバー側のジョブとして走らせる（アプリを閉じても中断しない）。
      // ここでは jobId を受け取り、開いている間だけ結果をポーリングする。
      const form = new FormData();
      form.append("image", file);
      const res = await netFetch("/api/scan-jobs", { method: "POST", body: form });
      const d = await res.json();
      // error:'limit'（無料枠超過）のときは message に日本語の案内が入る
      if (!res.ok) {
        if (d.error === "limit") setLimitHit(true);
        if (d.duplicate) {
          // 同じ画像を既に記録済み。AIを使わずに即返ってくる
          setError(d.message);
          setPhase("idle");
          return;
        }
        throw new Error(d.message ?? d.error ?? "解析に失敗しました。");
      }
      setJobId(d.jobId);
      await pollJob(d.jobId);
    } catch (err) {
      setError(err instanceof Error ? err.message : "解析に失敗しました。");
      setPhase("idle");
    }
  }

  /** ジョブの完了を待って確認シートを出す（最大3分。画面を離れたら中断してよい＝サーバーは走り続ける） */
  async function pollJob(id: string) {
    for (let i = 0; i < 90; i++) {
      await new Promise((r) => setTimeout(r, 2000));
      const res = await netFetch(`/api/scan-jobs?id=${encodeURIComponent(id)}`);
      if (!res.ok) continue;
      const d = await res.json();
      if (d.status === "running") continue;
      if (d.status === "failed") {
        setPhase("failed");
        return;
      }
      // A4: 金額も店名も読み取れなかった＝レシートとして認識できていない
      if (!d.scan?.total && !(d.scan?.store ?? "").trim()) {
        setPhase("failed");
        return;
      }
      track("scan_used"); // 自前計測：レシートAI読み取りの利用（解析成功）
      setScan({ ...d.scan, date: d.scan.date || todayLocal() });
      setImageHash(d.imageHash ?? ""); // 保存時に渡して「同じ画像の二度読み」を記録に残す
      setCategoryId(d.categoryId);
      setSuggestedCategoryId(d.categoryId);
      setLearned(!!d.learned);
      setPhase("confirm");
      return;
    }
    // ここまで来たらサーバー側がまだ処理中。閉じても結果は残ると案内する
    setError("読み取りに時間がかかっています。この画面を閉じても大丈夫です（終わったら通知でお知らせします）。");
    setPhase("idle");
  }

  // ネイティブ時のみ：読み取り元のスクショを端末から削除する（OSの確認ダイアログが出る）。
  // ファイル選択ではメディアIDが取れないため、更新時刻が最も近いスクショ（±2分）を対象にする。
  async function cleanSourceScreenshot() {
    setCleanState("busy");
    try {
      const shots = await listRecentScreenshots(50);
      let best: { id: string; takenAt: number } | null = null;
      let bestDiff = Infinity;
      for (const s of shots) {
        const diff = Math.abs(s.takenAt - sourceTakenAt);
        if (diff < bestDiff) {
          best = s;
          bestDiff = diff;
        }
      }
      if (!best || bestDiff > 120_000) {
        setCleanState("notfound");
        return;
      }
      const res = await deletePhotos([best.id]);
      setCleanState(res.deleted > 0 ? "done" : "cancelled");
    } catch {
      setCleanState("error");
    }
  }

  function onFile(e: React.ChangeEvent<HTMLInputElement>, lib: boolean) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (file) scanFile(file, lib);
  }

  // 「品目ごとにカテゴリを分ける」をON：AIが読んだ品目があればそれを初期行にする。
  // 品目が無い/読めないときは手動で分けられるよう、空の2行（合計を1行目に仮置き）を用意する。
  function enableSplit() {
    if (!scan) return;
    const rows =
      scan.items.length > 0
        ? scan.items.map((it) => ({
            name: it.name,
            amount: Math.round(it.price) || 0,
            categoryId,
          }))
        : [
            { name: "", amount: scan.total, categoryId },
            { name: "", amount: 0, categoryId: null },
          ];
    setSplitRows(rows);
    setSplitMode(true);
  }

  const splitAssigned = splitRows.reduce(
    (s, r) => s + (Number.isFinite(r.amount) && r.amount > 0 ? Math.round(r.amount) : 0),
    0,
  );
  // 未割当（レシート合計に満たない分）。保存時は「その他」に寄せて合計を一致させる
  const splitRemainder = (scan?.total ?? 0) - splitAssigned;
  const splitReady = splitRows.filter((r) => r.amount > 0).length >= 2;
  // 実際に保存される合計：未割当は「その他」に寄せてレシート合計に一致／過割当は割当額そのまま。
  const splitSavedTotal = Math.max(scan?.total ?? 0, splitAssigned);

  async function save(allowDuplicate = false) {
    if (!scan) return;
    setError("");
    setPhase("saving");
    try {
      // 受け取り（収入）は incomes へ、支払いは receipts+expenses へ
      const res =
        scan.kind === "income"
          ? await netFetch("/api/incomes", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                amount: scan.total,
                date: scan.date,
                memo: scan.store || "スクショ収入",
                dedupe: true, // 同じスクショの二重読み取り防止（手入力には影響しない）
                allowDuplicate, // 「本当に別の支払い」と確認済みの再送信のみ true
                imageHash,
              }),
            })
          : await netFetch("/api/receipts", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                store: scan.store,
                date: scan.date,
                total: scan.total,
                categoryId,
                suggestedCategoryId, // 提案から変更されていたらサーバーが店名→カテゴリを学習する
                items: scan.items,
                // 分割モードON時のみ：カテゴリ単位でまとめて複数 expense を作る。
                // 未割当（レシート合計に満たない分）はサーバーで「その他」に寄せて合計一致、
                // 過割当（合計を超える分）は入力した割当額のまま保存される（receiptSplit の実挙動）。
                splits:
                  splitMode && splitReady
                    ? splitRows.map((r) => ({ categoryId: r.categoryId, amount: r.amount }))
                    : undefined,
                allowDuplicate, // 「本当に別の支払い」と確認済みの再送信のみ true
                imageHash,
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
      // C5: 記録できたので読み取りジョブは用済み（ホームの「確認して」カードにも出さない）
      if (jobId) {
        await netFetch(`/api/scan-jobs?id=${encodeURIComponent(jobId)}`, { method: "DELETE" }).catch(
          () => {},
        );
        setJobId("");
      }
      if (fromLibrary) {
        // スクショ由来のときは「元画像はもう不要」のリマインドを出してから帰る
        setPhase("done");
      } else {
        // R5: カメラ読取（非ライブラリ）もホームで成功トーストを出す
        router.push(`/?saved=${scan.total}`);
        router.refresh();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "保存に失敗しました。");
      setPhase("confirm");
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-baseline justify-between gap-2">
        <h1 className="text-lg font-bold tracking-[0.04em]">レシート・スクショを読み取る</h1>
        {/* 端末内OCR（build26+）は無制限・無料なので残量表示は出さない */}
        {!onDevice && scansLeft !== null && (
          <span
            className={`shrink-0 text-[11px] tabular-nums ${
              scansLeft <= 5 ? "text-caution" : "text-ink-faint"
            }`}
          >
            今月あと{scansLeft}回
          </span>
        )}
      </div>
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
            className="w-full rounded-2xl border border-rule bg-card px-6 py-10 text-center shadow-sm active:translate-y-0.5"
          >
            <CameraIcon className="mx-auto h-12 w-12" />
            <span className="mt-3 block text-lg font-bold">レシートを撮影</span>
            <span className="mt-1 block text-xs text-ink-faint">
              {onDevice
                ? "店名・金額・カテゴリを自動で読み取ります"
                : "店名・金額・カテゴリはAIが読み取ります"}
            </span>
          </button>
          <button
            onClick={() => libRef.current?.click()}
            className="w-full rounded-2xl border border-rule bg-card px-6 py-6 text-center shadow-sm active:translate-y-0.5"
          >
            <ImageIcon className="mx-auto h-8 w-8" />
            <span className="mt-1 block text-base font-bold">スクショ・画像から読み取る</span>
            <span className="mt-1 block text-xs text-ink-faint">
              PayPayの支払い画面・ネット注文の確認画面などもOK
            </span>
          </button>
          {error && <p className="text-center text-sm text-vermilion">{error}</p>}
          {limitHit && (
            <RewardCredit
              kind="scans"
              onGranted={() => {
                setError("");
                setLimitHit(false);
              }}
            />
          )}
          <p className="text-center text-[11px] leading-relaxed text-ink-faint">
            読み取り結果は保存前に必ず確認できます。
          </p>
          {/* 反映確認用の版マーカー（この文字列が古ければ端末が古いWebを読んでいる＝キャッシュ未更新）。 */}
          <p className="text-center text-[10px] text-ink-faint">エンジン {SCAN_ENGINE_VER}</p>
        </div>
      )}

      {phase === "scanning" && (
        <div className="space-y-4">
          {preview && (
            /* eslint-disable-next-line @next/next/no-img-element */
            <img src={preview} alt="レシート" className="mx-auto max-h-64 rounded-xl border border-rule" />
          )}
          <div className="rounded-2xl border border-rule bg-card px-5 py-6 text-center shadow-sm">
            <p className="text-lg font-bold">解析中</p>
            {!onDevice && (
              <p className="mt-2 text-xs text-ink-faint">
                {elapsed > 30
                  ? "混雑していて少し時間がかかっています。もう少しお待ちください"
                  : "AIが読み取り中です（通常10〜30秒・混雑時は少しかかります）"}
              </p>
            )}
            {/* C5: サーバー処理は閉じても続くと明示（端末内OCR時は一瞬で終わるので不要） */}
            {!onDevice && (
              <p className="mt-1 text-xs text-sage">
                このまま閉じても大丈夫です。終わったら通知でお知らせします
              </p>
            )}
            <p className="mt-3 text-sm tabular-nums text-ink-faint">{elapsed}秒経過</p>
          </div>
        </div>
      )}

      {/* A4: 金額も店名も読み取れなかった（空フォームを出さず撮り直しを案内） */}
      {phase === "failed" && (
        <div className="rounded-2xl border border-rule bg-card px-5 py-6 text-center shadow-sm">
          <p className="text-lg font-bold text-vermilion">
            {recheck ? "金額を正しく読み取れませんでした" : "レシートを認識できませんでした"}
          </p>
          <p className="mt-2 text-xs leading-relaxed text-ink-faint">
            {recheck
              ? "明細の合計と金額が一致しません（数字の読み取りミスの可能性）。数字がはっきり写るように、明るい場所で撮り直してください。"
              : "明るい場所で全体が写るように撮り直してください"}
          </p>
          {/* 端末内OCRの実挙動診断（原因可視化用）。この文字列を開発者に伝えれば原因が特定できる。 */}
          {onDevice && scanDbg && (
            <p className="mt-3 break-all rounded-lg bg-paper px-3 py-2 text-left text-[11px] leading-relaxed text-ink-faint">
              診断 [{SCAN_ENGINE_VER}]: {scanDbg}
            </p>
          )}
          {/* 認識はできたが解析で落ちた場合の生テキスト（開発側の調整用）。 */}
          {onDevice && rawOcr && (
            <details className="mt-2 rounded-lg bg-paper px-3 py-2 text-left">
              <summary className="cursor-pointer text-[11px] text-ink-faint">認識テキストを表示</summary>
              <pre className="mt-2 max-h-60 overflow-auto whitespace-pre-wrap break-all text-[11px] leading-relaxed text-ink">
{rawOcr}
              </pre>
            </details>
          )}
          <button
            onClick={() => (fromLibrary ? libRef : fileRef).current?.click()}
            className="mt-4 w-full rounded-xl bg-vermilion py-3 text-base font-bold text-card shadow-sm active:translate-y-0.5 active:shadow-none"
          >
            {fromLibrary ? "画像を選び直す" : "撮り直す"}
          </button>
          <button
            onClick={() => setPhase("idle")}
            className="mt-3 w-full text-center text-xs text-ink-faint underline underline-offset-2"
          >
            別の方法で読み取る
          </button>
        </div>
      )}

      {phase === "done" && (
        <div className="rounded-2xl border border-rule bg-card px-5 py-6 text-center shadow-sm">
          <CheckCircleIcon className="mx-auto h-10 w-10 text-sage" />
          <p className="mt-2 text-lg font-bold">記録しました</p>
          <div className="mx-auto mt-4 max-w-xs rounded-xl border border-rule bg-paper px-4 py-3 text-left text-xs leading-relaxed">
            <p className="flex items-center gap-1 font-bold text-ink">
              <TrashIcon className="h-4 w-4 shrink-0" /> 元のスクショはもう不要です
            </p>
            {native ? (
              <>
                <p className="mt-1 text-ink-faint">
                  読み取った内容はアプリに保存済み。下のボタンで端末からスクショを削除できます（OSの確認が出ます）。
                </p>
                {(cleanState === "idle" || cleanState === "busy") && (
                  <button
                    onClick={cleanSourceScreenshot}
                    disabled={cleanState === "busy"}
                    className="mt-2 w-full rounded-xl border border-ink py-2.5 text-sm font-semibold active:translate-y-0.5 disabled:opacity-50"
                  >
                    {cleanState === "busy" ? "削除の確認中・・・" : "端末からこのスクショを削除"}
                  </button>
                )}
                {cleanState === "done" && <p className="mt-2 text-sage">✓ 端末から削除しました。</p>}
                {cleanState === "cancelled" && (
                  <p className="mt-2 text-ink-faint">削除をキャンセルしました。</p>
                )}
                {cleanState === "notfound" && (
                  <p className="mt-2 text-ink-faint">
                    対象のスクショを特定できませんでした。お手数ですが写真アプリから削除してください。
                  </p>
                )}
                {cleanState === "error" && (
                  <p className="mt-2 text-vermilion">
                    削除に失敗しました。写真アプリから削除してください。
                  </p>
                )}
              </>
            ) : (
              <p className="mt-1 text-ink-faint">
                読み取った内容はアプリに保存済み。アプリから端末の写真は削除できない仕組み（ブラウザの制限）のため、お手数ですが写真アプリから削除してください。
              </p>
            )}
          </div>
          <button
            onClick={() => {
              router.push("/");
              router.refresh();
            }}
            className="mt-4 w-full rounded-xl bg-vermilion py-3 text-base font-bold text-card shadow-sm active:translate-y-0.5 active:shadow-none"
          >
            ホームへ戻る
          </button>
        </div>
      )}

      {(phase === "confirm" || phase === "saving") && scan && (
        <div className="rounded-2xl border border-rule bg-card px-5 py-5 shadow-sm">
          <p className="text-center text-xs text-ink-faint">読み取り結果（修正できます）</p>
          {/* 実機Visionの生OCRテキスト。解析がずれたときにこれを開いてスクショで送ってもらえば、
              端末が実際に読んだ文字列にパーサーを合わせられる（開発側の調整用・普段は閉じている）。 */}
          {onDevice && rawOcr && (
            <details className="mt-2 rounded-lg bg-paper px-3 py-2 text-left">
              <summary className="cursor-pointer text-[11px] text-ink-faint">
                認識テキストを表示（解析がずれたとき用） [{SCAN_ENGINE_VER}]
              </summary>
              <pre className="mt-2 max-h-60 overflow-auto whitespace-pre-wrap break-all text-[11px] leading-relaxed text-ink">
{rawOcr}
              </pre>
            </details>
          )}
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
              className={`flex items-center gap-1 rounded-full border px-4 py-1.5 text-sm ${
                scan.kind === "income" ? "border-sage bg-sage text-card" : "border-rule bg-paper"
              }`}
            >
              <CoinIcon className="h-4 w-4" /> 収入
            </button>
          </div>
          <div className="mt-3 space-y-3">
            <label className="block">
              <span className="text-xs text-ink-faint">店名</span>
              <input
                value={scan.store}
                onChange={(e) => setScan({ ...scan, store: e.target.value })}
                className="mt-1 w-full rounded-xl border border-rule bg-paper px-3 py-2 text-base outline-none focus:border-ink"
                placeholder="店名"
              />
            </label>
            <div className="flex gap-3">
              <label className="block min-w-0 flex-1">
                <span className="text-xs text-ink-faint">日付</span>
                <input
                  type="date"
                  value={scan.date}
                  onChange={(e) => setScan({ ...scan, date: e.target.value })}
                  className="mt-1 w-full rounded-xl border border-rule bg-paper px-3 py-2 text-base outline-none focus:border-ink"
                />
              </label>
              <label className="block min-w-0 flex-1">
                <span className="text-xs text-ink-faint">合計</span>
                <input
                  type="number"
                  inputMode="numeric"
                  value={scan.total || ""}
                  onChange={(e) => setScan({ ...scan, total: Number(e.target.value) })}
                  className="mt-1 w-full rounded-xl border border-rule bg-paper px-3 py-2 text-xl font-bold tabular-nums outline-none focus:border-ink"
                />
              </label>
            </div>
            {scan.kind === "expense" && !splitMode && (
            <div>
              <span className="text-xs text-ink-faint">カテゴリ</span>
              {learned && (
                <span
                  className="ml-1.5 inline-flex items-center gap-0.5 rounded-full border border-rule bg-paper px-1.5 py-0.5 align-middle text-[10px] text-ink-faint"
                  title="この店で以前あなたが選んだカテゴリを適用しています"
                >
                  <PinIcon className="h-3 w-3" />
                  学習済み
                </span>
              )}
              <div className="mt-1.5 flex flex-wrap gap-1.5">
                {categories.map((c) => (
                  <button
                    key={c.id}
                    onClick={() => setCategoryId(c.id)}
                    className={`flex items-center gap-1 rounded-full border px-3 py-1.5 text-sm ${
                      categoryId === c.id
                        ? "border-vermilion bg-vermilion text-card"
                        : "border-rule bg-paper text-ink"
                    }`}
                  >
                    <CategoryIcon icon={c.icon} className="h-4 w-4" /> {c.name}
                  </button>
                ))}
              </div>
            </div>
            )}
            {scan.kind === "expense" && !splitMode && scan.items.length > 0 && (
              <div>
                <p className="text-xs text-ink-faint">品目（明細として保存されます）</p>
                <ul className="mt-1">
                  {scan.items.map((it, i) => (
                    <li key={i} className="flex items-baseline py-0.5 text-sm">
                      <span className="truncate">{it.name}</span>
                      <span className="leader" />
                      <span className="font-bold tabular-nums">{fmtYen(it.price)}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {/* レシート内分割：食費＋日用品など1枚を複数カテゴリに按分して保存する */}
            {scan.kind === "expense" && !splitMode && (
              <button
                onClick={enableSplit}
                className="w-full rounded-xl border border-dashed border-rule py-2.5 text-sm text-ink-faint active:translate-y-0.5"
              >
                ＋ 品目ごとにカテゴリを分ける
              </button>
            )}
            {scan.kind === "expense" && splitMode && (
              <div>
                <div className="flex items-baseline justify-between">
                  <span className="text-xs text-ink-faint">品目ごとにカテゴリを分ける</span>
                  <button
                    onClick={() => setSplitMode(false)}
                    className="text-[11px] text-ink-faint underline underline-offset-2"
                  >
                    分割をやめる
                  </button>
                </div>
                <ul className="mt-2 space-y-2">
                  {splitRows.map((r, i) => (
                    <li key={i} className="rounded-xl border border-rule bg-paper px-2.5 py-2">
                      <div className="flex items-center gap-2">
                        <input
                          value={r.name}
                          onChange={(e) =>
                            setSplitRows((rows) =>
                              rows.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)),
                            )
                          }
                          placeholder="品目名（任意）"
                          className="min-w-0 flex-1 border-b border-rule bg-transparent px-0.5 py-1 text-sm outline-none focus:border-ink"
                        />
                        <input
                          type="number"
                          inputMode="numeric"
                          value={r.amount || ""}
                          onChange={(e) =>
                            setSplitRows((rows) =>
                              rows.map((x, j) =>
                                j === i ? { ...x, amount: Number(e.target.value) } : x,
                              ),
                            )
                          }
                          placeholder="0"
                          className="w-20 shrink-0 border-b border-rule bg-transparent px-0.5 py-1 text-right text-base font-bold tabular-nums outline-none focus:border-ink"
                        />
                        <span className="shrink-0 text-xs text-ink-faint">円</span>
                        <button
                          onClick={() => setSplitRows((rows) => rows.filter((_, j) => j !== i))}
                          className="shrink-0 text-ink-faint"
                          aria-label="この行を削除"
                        >
                          <TrashIcon className="h-4 w-4" />
                        </button>
                      </div>
                      <div className="mt-1.5 flex flex-wrap gap-1">
                        {categories.map((c) => (
                          <button
                            key={c.id}
                            onClick={() =>
                              setSplitRows((rows) =>
                                rows.map((x, j) => (j === i ? { ...x, categoryId: c.id } : x)),
                              )
                            }
                            className={`flex items-center gap-1 rounded-full border px-2 py-1 text-xs ${
                              r.categoryId === c.id
                                ? "border-vermilion bg-vermilion text-card"
                                : "border-rule bg-card text-ink"
                            }`}
                          >
                            <CategoryIcon icon={c.icon} className="h-3 w-3" /> {c.name}
                          </button>
                        ))}
                      </div>
                    </li>
                  ))}
                </ul>
                <button
                  onClick={() =>
                    setSplitRows((rows) => [...rows, { name: "", amount: 0, categoryId }])
                  }
                  className="mt-2 w-full rounded-xl border border-dashed border-rule py-2 text-xs text-ink-faint active:translate-y-0.5"
                >
                  ＋ 行を追加
                </button>
                {/* 割当状況：合計はレシート合計に一致するのが基本。未割当は保存時に「その他」に寄る */}
                <div className="mt-2 flex items-baseline text-xs">
                  <span className="text-ink-faint">割当合計</span>
                  <span className="leader" />
                  <span className="font-bold tabular-nums">
                    {fmtYen(splitAssigned)} / {fmtYen(scan.total)}
                  </span>
                </div>
                {splitRemainder > 0 && (
                  <p className="mt-1 text-[11px] text-caution">
                    未割当 {fmtYen(splitRemainder)} は「その他」として記録されます
                  </p>
                )}
                {splitRemainder < 0 && (
                  <p className="mt-1 text-[11px] text-vermilion">
                    割当がレシート合計を {fmtYen(-splitRemainder)} 超えています。割当額の {fmtYen(splitAssigned)} で記録します
                  </p>
                )}
                {!splitReady && (
                  <p className="mt-1 text-[11px] text-ink-faint">
                    金額のある行が2つ以上必要です（1つのときは通常保存になります）
                  </p>
                )}
              </div>
            )}
          </div>
          {error && <p className="mt-2 text-sm text-vermilion">{error}</p>}
          {dupConfirm ? (
            // 重複検知：エラーで突き放さず「本当に別の支払いか」を確認してから記録できるようにする
            <div className="mt-4 rounded-xl border border-vermilion bg-paper px-4 py-3">
              <p className="text-sm leading-relaxed text-ink">
                同じ内容（{fmtDateJa(scan.date)}・{fmtYen(scan.total)}・{scan.store || "店名なし"}
                ）を今日すでに記録しています。本当に別の{scan.kind === "income" ? "受け取り" : "支払い"}
                ですか？
              </p>
              <div className="mt-3 flex gap-2">
                <button
                  onClick={() => setDupConfirm(false)}
                  disabled={phase === "saving"}
                  className="flex-1 rounded-xl border border-rule py-3 text-sm text-ink-faint"
                >
                  やめる
                </button>
                <button
                  onClick={() => save(true)}
                  disabled={phase === "saving"}
                  className="flex-[2] rounded-xl bg-vermilion py-3 text-sm font-bold text-card shadow-sm active:translate-y-0.5 active:shadow-none disabled:opacity-50"
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
              className="flex-1 rounded-xl border border-rule py-3 text-sm text-ink-faint"
            >
              撮り直す
            </button>
            <button
              onClick={() => save()}
              disabled={phase === "saving" || !scan.total}
              className={`flex-[2] rounded-xl py-3 text-lg font-bold text-card shadow-sm active:translate-y-0.5 active:shadow-none disabled:opacity-50 ${
                scan.kind === "income" ? "bg-sage" : "bg-vermilion"
              }`}
            >
              {phase === "saving"
                ? "保存中・・・"
                : splitMode && splitReady && scan.kind === "expense"
                  ? `${fmtYen(splitSavedTotal)} を分けて記録`
                  : `${fmtYen(scan.total)} を${scan.kind === "income" ? "収入として" : ""}記録`}
            </button>
          </div>
          )}
        </div>
      )}
    </div>
  );
}
