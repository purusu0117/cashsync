"use client";

// ホーム：今日使えるお金（予算信号機）＋月末予測＋貯金目標＋ノーマネーデー＋入力方法3種。
// カレンダー自動同期がONなら、開いたときに裏で今月・来月のシフトを差分同期する。
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { CameraIcon, CategoryIcon, PencilIcon, ScreenshotIcon } from "@/components/Icons";
import Loading from "@/components/Loading";
import { Toast, useToast } from "@/components/Toast";
import { cachedFetch } from "@/lib/cachedFetch";
import { apiCall, apiJson } from "@/lib/clientApi";
import {
  DEFAULT_EXCLUDES,
  getCalendarToken,
  isAutoSyncOn,
  syncMonth,
} from "@/lib/calendarImport";
import { fmtDateJa, fmtYen, todayLocal } from "@/lib/format";
import { isNativePlatform, updateWidgetBudget } from "@/lib/native";
import { setPendingImage } from "@/lib/pendingImage";

interface Summary {
  user: { name: string };
  month: string;
  // B9: 集計期間（締め日基準。開始日1なら実カレンダー月と同じ。旧キャッシュには無いので optional）
  range?: { start: string; end: string };
  summary: {
    incomeTotal: number;
    expenseTotal: number;
    shift: { total: number; shiftCount: number };
  };
  savingsGoal: number;
  allowance: number; // 今日あと使える額（今日の予算 − 今日の変動支出。マイナス＝超過）
  // 日次予算の内訳（旧キャッシュには無いので optional）
  budget?: {
    todayBudget: number;
    spentToday: number;
    remainingToday: number;
    spentBeforeToday: number;
    daysRemaining: number;
    fixedTotal?: number; // 今月の固定費（定期計上・分割）。先取り済み
    monthRemaining?: number; // 日割り前の土台。マイナス＝今月使える残りなし
  };
  daysRemaining: number;
  nextPayday?: { date: string; amount: number; daysUntil: number } | null;
  noMoney: { count: number; streak: number };
  forecast: { forecast: number; avgDaily: number };
  yesterday: { date: string; recorded: boolean };
  recent: {
    id: string;
    date: string;
    amount: number;
    memo: string;
    source?: string;
    category_id?: string | null;
    receipt_id?: string | null;
    category: string | null;
    icon: string | null;
  }[];
  // ホームの円グラフ用：カテゴリ別の当月支出（金額降順・旧キャッシュには無いので optional）
  categoryBreakdown?: { name: string | null; icon: string | null; total: number }[];
  // 働き方（収入タイプ）。hourly=時給/シフト, salary=月給, daily=日給。セットアップ導線の最適化に使う
  workStyle?: string;
  // B3: 初回セットアップカード用の登録状況（旧キャッシュには無いので optional）
  counts?: {
    jobs: number;
    recurringExpense: number;
    recurringIncome: number; // 社会人向け：毎月の給料を定期収入で登録しているか
    expensesAll: number;
  };
}

interface Preset {
  id: string;
  label: string;
  amount: number;
  category_id: string | null;
  category: string | null;
  icon: string | null;
}

function yesterdayLocal(): string {
  const n = new Date();
  n.setDate(n.getDate() - 1);
  return `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, "0")}-${String(n.getDate()).padStart(2, "0")}`;
}

export default function HomePage() {
  const router = useRouter();
  const [data, setData] = useState<Summary | null>(null);
  const [error, setError] = useState("");
  const [amnesty, setAmnesty] = useState<string | null>(null); // つけ忘れ確認対象の日付
  // C5: アプリを閉じている間に完了した読み取り（未確認のもの）
  const [pendingScans, setPendingScans] = useState<{ id: string; scan?: { total?: number } }[]>([]);
  const [reviewMonth, setReviewMonth] = useState<string | null>(null); // 月初の振り返り案内
  const [weeklyKey, setWeeklyKey] = useState<string | null>(null); // 週次振り返り案内（週の前半だけ）
  const [isIOS, setIsIOS] = useState(false);
  const [presets, setPresets] = useState<Preset[]>([]);
  // 完了フィードバック（A6）：記録・削除の直後は「元に戻す」つき、エラー時はメッセージのみ
  const { toast, show, hide } = useToast();
  const [presetBusy, setPresetBusy] = useState(false);
  // C7: 最近の支出の✕は即削除せず、行内で「削除しますか？」を確認してから消す
  const [confirmId, setConfirmId] = useState<string | null>(null);
  // B6: iOSスクショボタンの初回タップ時の選択ダイアログ（ショートカット未設定ユーザー対策）
  const [shortcutDialog, setShortcutDialog] = useState(false);
  const [shortcutDefault, setShortcutDefault] = useState(false);
  // B3: 初回セットアップカード（新規登録直後のデータ0件ユーザーだけに表示）
  const [showSetup, setShowSetup] = useState(false);
  const syncedRef = useRef(false);
  // ネイティブ：ウィジェットへ送った残額の signature（変化時だけ再送＝iOSのリロード budget を節約）
  const widgetSigRef = useRef("");
  const camRef = useRef<HTMLInputElement>(null);
  const libRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    try {
      // キャッシュファースト：前回のデータを即表示→裏で最新に差し替え（タブ切替のフラッシュ対策）
      await cachedFetch<Summary>("/api/summary", (d) => {
        setData(d);
        // ネイティブ：最新の「今日あと使える額」をウィジェットへ即反映する。
        // 記録するとホームが再取得→ここで新しい数字をウィジェットへ渡すので、体感の反映が速くなる。
        // 変化したときだけ送る（iOSのウィジェット更新は1日の回数に上限があるため無駄打ちしない）。
        if (isNativePlatform()) {
          const sig = `${d.allowance}|${d.budget?.todayBudget ?? ""}|${d.budget?.spentToday ?? ""}|${d.nextPayday?.date ?? ""}|${d.nextPayday?.amount ?? ""}`;
          if (sig !== widgetSigRef.current) {
            widgetSigRef.current = sig;
            updateWidgetBudget({
              remainingToday: d.allowance,
              todayBudget: d.budget?.todayBudget ?? d.allowance,
              spentToday: d.budget?.spentToday ?? 0,
              nextPaydayDate: d.nextPayday?.date ?? null,
              nextPaydayAmount: d.nextPayday?.amount ?? 0,
            });
          }
        }
        // つけ忘れ赦免：昨日の記録が1件も無ければ、細いカードで確認（完璧主義による離脱対策）
        // B3: まだ1件も記録していない新規ユーザーには「昨日の記録がありません」を出さない
        const yd = d.yesterday?.date ?? yesterdayLocal();
        const dismissed = localStorage.getItem(`cashsync-amnesty-${yd}`);
        const hasExp = (d.counts?.expensesAll ?? 1) > 0;
        // B9: 「今月内か」は集計期間（range）で判定。range の無い旧キャッシュは従来判定
        const ydInMonth = d.range
          ? yd >= d.range.start && yd <= d.range.end
          : yd.startsWith(d.month);
        setAmnesty(hasExp && !d.yesterday?.recorded && !dismissed && ydInMonth ? yd : null);
        // B3: 初回セットアップカードの表示判定。
        //  - localStorage 未設定＋データ0件 → カード開始（"active"）
        //  - localStorage 未設定＋データあり → 既存ユーザーなので出さない（"done"）
        //  - 4ステップ完了 or 「閉じる」→ "done" で以後表示しない
        if (d.counts) {
          const c = d.counts;
          // 収入源はシフト(バイト)でも定期収入(社会人の月給)でもOK＝どちらかあれば「収入登録済み」
          const incomeSet = c.jobs > 0 || (c.recurringIncome ?? 0) > 0;
          const stepsDone =
            incomeSet && c.recurringExpense > 0 && (d.savingsGoal ?? 0) > 0 && c.expensesAll > 0;
          const ls = localStorage.getItem("cashsync-setup");
          if (ls === "done" || stepsDone) {
            if (ls === "active") localStorage.setItem("cashsync-setup", "done");
            setShowSetup(false);
          } else if (ls === "active") {
            setShowSetup(true);
          } else {
            const hasData =
              incomeSet ||
              c.recurringExpense > 0 ||
              c.expensesAll > 0 ||
              (d.savingsGoal ?? 0) > 0;
            localStorage.setItem("cashsync-setup", hasData ? "done" : "active");
            setShowSetup(!hasData);
          }
        }
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : "読み込みに失敗しました。");
    }
    // かんたん入力ボタン（0件なら非表示なので、失敗してもホームは止めない）
    cachedFetch<{ presets?: Preset[] }>("/api/presets", (d) => setPresets(d.presets ?? [])).catch(
      () => {},
    );
  }, []);

  // かんたん入力：確認なしで即記録（date=今日）。間違えたらトーストの「元に戻す」で削除。
  // 同じボタンを1日に2回押すのは正当（例：Suicaチャージ2回）なので重複ガードはかけない。
  async function recordPreset(p: Preset) {
    if (presetBusy) return; // 連打による意図しない多重記録だけ防ぐ
    setPresetBusy(true);
    try {
      const d = await apiCall<{ id: string }>(
        "/api/expenses",
        apiJson({
          amount: p.amount,
          memo: p.label,
          categoryId: p.category_id,
          source: "quick",
        }),
      );
      show(`記録しました ${fmtYen(p.amount)}`, () => undoPreset(d.id));
      load();
    } catch (e) {
      show(e instanceof Error ? e.message : "記録に失敗しました。");
    } finally {
      setPresetBusy(false);
    }
  }

  // 「元に戻す」：直前のかんたん入力を削除
  async function undoPreset(expenseId: string) {
    try {
      await apiCall(`/api/expenses?id=${expenseId}`, { method: "DELETE" });
      show("記録を取り消しました");
      load();
    } catch (e) {
      show(e instanceof Error ? e.message : "取り消しに失敗しました。");
    }
  }

  // カレンダー自動同期（ホームを開くたび・裏で静かに）
  const autoSync = useCallback(async () => {
    if (syncedRef.current || !isAutoSyncOn()) return;
    syncedRef.current = true;
    try {
      const jobs = (await fetch("/api/jobs").then((r) => r.json())).jobs as {
        id: string;
        calendar_keywords: string;
        calendar_exclude: string;
      }[];
      const job = jobs?.find((j) => j.calendar_keywords?.trim());
      if (!job) return;
      const token = await getCalendarToken();
      const now = todayLocal().slice(0, 7);
      const [yy, mm] = now.split("-").map(Number);
      const next = `${new Date(yy, mm, 1).getFullYear()}-${String(new Date(yy, mm, 1).getMonth() + 1).padStart(2, "0")}`;
      let changed = 0;
      for (const m of [now, next]) {
        const r = await syncMonth(
          token,
          job.id,
          m,
          job.calendar_keywords.split(/[,、\s]+/).filter(Boolean),
          (job.calendar_exclude || DEFAULT_EXCLUDES.join(",")).split(/[,、\s]+/).filter(Boolean),
        );
        changed += r.added + r.updated + r.removed;
      }
      if (changed > 0) load();
    } catch {
      /* サイレント失敗：シフト画面の連携設定から再認証できる */
    }
  }, [load]);

  // 表示の古さ（ラグ）対策は二段構え：
  //  1) アプリが前面に戻った瞬間に再取得（visibilitychange / pageshow / focus）
  //  2) 画面を開いたままでも20秒ごとに自動再取得
  //     ※ショートカットの記録はアプリに戻った「後」に完了することがあり、
  //       復帰イベントだけでは取りこぼすため
  useEffect(() => {
    const refresh = () => {
      if (document.visibilityState === "visible") load();
    };
    document.addEventListener("visibilitychange", refresh);
    window.addEventListener("pageshow", refresh);
    window.addEventListener("focus", refresh);
    const timer = setInterval(refresh, 20_000);
    return () => {
      document.removeEventListener("visibilitychange", refresh);
      window.removeEventListener("pageshow", refresh);
      window.removeEventListener("focus", refresh);
      clearInterval(timer);
    };
  }, [load]);

  useEffect(() => {
    load();
    autoSync();
    // C5: アプリを閉じている間に完了した読み取りを拾う（未確認なら案内カードを出す）
    fetch("/api/scan-jobs")
      .then((r) => (r.ok ? r.json() : { jobs: [] }))
      .then((d) => setPendingScans(d.jobs ?? []))
      .catch(() => {});
    // ショートカット導線は「Web/PWA版のiOS」だけ。
    // ネイティブアプリ（App Store版）は PhotoKit で直接スクショを削除できるので、
    // ショートカットを経由する必要がない（大翔指摘 2026-07-27）。
    setIsIOS(/iPad|iPhone|iPod/.test(navigator.userAgent) && !isNativePlatform());
    // 月初（1〜7日）は先月の振り返りレポートを案内
    const n = new Date();
    if (n.getDate() <= 7) {
      const pm = new Date(n.getFullYear(), n.getMonth() - 1, 1);
      const pmStr = `${pm.getFullYear()}-${String(pm.getMonth() + 1).padStart(2, "0")}`;
      if (!localStorage.getItem(`cashsync-review-note-${pmStr}`)) setReviewMonth(pmStr);
    }
    // 週の前半（月〜水）は先週の振り返りを案内
    const dow = (n.getDay() + 6) % 7; // 月曜=0
    if (dow <= 2) {
      const monday = new Date(n.getFullYear(), n.getMonth(), n.getDate() - dow);
      const wk = `${monday.getFullYear()}-${String(monday.getMonth() + 1).padStart(2, "0")}-${String(monday.getDate()).padStart(2, "0")}`;
      if (!localStorage.getItem(`cashsync-weekly-note-${wk}`)) setWeeklyKey(wk);
    }
  }, [load, autoSync]);

  // R5: 手入力(/add)・カメラ読取(/scan)からの保存後の成功トースト。
  // ?saved=<金額>（&undo=<expenseId>）で戻ってくるので、かんたん入力と同じ様式で出す。
  useEffect(() => {
    const sp = new URLSearchParams(window.location.search);
    const saved = sp.get("saved");
    if (!saved) return;
    const amt = Number(saved);
    const undoId = sp.get("undo");
    // 再読み込み・戻る操作でトーストが再表示されないよう、URLからパラメータを消す
    window.history.replaceState(null, "", "/");
    if (Number.isFinite(amt) && amt > 0) {
      show(`記録しました ${fmtYen(amt)}`, undoId ? () => undoPreset(undoId) : undefined);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 画像を選んだら /scan に渡して即解析
  function onImage(e: React.ChangeEvent<HTMLInputElement>, fromLibrary: boolean) {
    const f = e.target.files?.[0];
    e.target.value = "";
    if (!f) return;
    setPendingImage(f, fromLibrary);
    router.push("/scan");
  }

  function dismissAmnesty() {
    if (amnesty) localStorage.setItem(`cashsync-amnesty-${amnesty}`, "1");
    setAmnesty(null);
  }

  // C7: 行内確認→削除。削除後は8秒間「元に戻す」で復元できる
  async function removeExpense(e: Summary["recent"][number]) {
    setConfirmId(null);
    try {
      await apiCall(`/api/expenses?id=${e.id}`, { method: "DELETE" });
      load();
      show("支出を削除しました", async () => {
        try {
          await apiCall(
            "/api/expenses",
            apiJson({
              amount: e.amount,
              date: e.date,
              memo: e.memo,
              categoryId: e.category_id ?? null,
              source: e.source ?? "manual",
              receiptId: e.receipt_id ?? null,
            }),
          );
          load();
          show("元に戻しました");
        } catch (err) {
          show(err instanceof Error ? err.message : "元に戻せませんでした。");
        }
      });
    } catch (err) {
      show(err instanceof Error ? err.message : "削除に失敗しました。");
    }
  }

  // B6: スクショボタン。iOSはショートカット連携が本命だが、未設定ユーザーは
  // 初回タップで「ショートカットで開く／写真から選ぶ」を選べるようにする。
  function onScreenshotTap() {
    if (!isIOS) {
      libRef.current?.click();
      return;
    }
    if (localStorage.getItem("cashsync-ios-shortcut") === "1") {
      runShortcut();
      return;
    }
    setShortcutDialog(true);
  }

  // iOSショートカット「CashSync」を、自分のトークンを持たせて起動する。
  // トークンはショートカット側で「ショートカットの入力」として受け取れるので、
  // 事前のトークン設定・ファイル保存が一切不要になる（配布も楽になる）。
  async function runShortcut() {
    try {
      const d = await fetch("/api/profile").then((r) => r.json());
      if (!d.apiToken) return;
      location.href = `shortcuts://run-shortcut?name=CashSync&input=text&text=${encodeURIComponent(d.apiToken)}`;
    } catch {
      /* 失敗時は何もしない */
    }
  }

  // C1: 初回読み込み失敗は赤文言だけの行き止まりにせず、その場で再試行できるようにする
  if (error && !data)
    return (
      <div className="mt-16 text-center">
        <p className="text-sm font-bold tracking-[0.04em] text-vermilion">読み込めませんでした</p>
        <p className="mt-1 text-xs text-ink-faint">{error}</p>
        <button
          onClick={() => {
            setError("");
            load();
          }}
          className="mt-4 rounded-md border border-ink px-6 py-2.5 text-sm font-bold active:translate-y-0.5"
        >
          もう一度試す
        </button>
      </div>
    );
  if (!data) return <Loading />;

  const { summary, forecast, savingsGoal, noMoney } = data;
  // B3: 支出0件の間は「ノーマネーデー◯日連続」「黒字判子」等の虚偽の称賛を出さない
  // （counts が無い旧キャッシュは従来どおり表示）
  const hasExpenses = (data.counts?.expensesAll ?? 1) > 0;
  // B2: 今日の予算の土台（今月収入 − 貯金目標 − 固定費 − 昨日までの変動支出）がマイナス＝今月使える残りなし
  const budgetExhausted = (data.budget?.monthRemaining ?? 0) < 0;
  // 予算信号機（Zaim方式）：赤=このままだと赤字 / 黄=黒字だが貯金目標に届かない / 緑=目標達成ペース
  const signal =
    data.allowance < 0 || forecast.forecast < 0
      ? "red"
      : savingsGoal > 0 && forecast.forecast < savingsGoal
        ? "yellow"
        : "green";
  const signalColor =
    signal === "red" ? "text-vermilion" : signal === "yellow" ? "text-caution" : "text-sage";
  const recoverPerDay =
    forecast.forecast < 0 ? Math.ceil(-forecast.forecast / data.daysRemaining) : 0;
  // B9: 締め日を変えている場合だけ「7/25〜8/24の集計」を小さく表示（開始日1なら出さない）
  const customRange = data.range && !data.range.start.endsWith("-01") ? data.range : null;
  const fmtMD = (d: string) => `${Number(d.slice(5, 7))}/${Number(d.slice(8, 10))}`;
  const goalPct =
    savingsGoal > 0 ? Math.max(0, Math.min(100, Math.round((forecast.forecast / savingsGoal) * 100))) : 0;
  // C3: 収入源（バイト or 定期収入）が未登録なら、冷たい ¥0 ではなく登録導線を出す
  const noIncomeSource = data.counts
    ? data.counts.jobs === 0 && (data.counts.recurringIncome ?? 0) === 0
    : false;
  // C4: 桁数に応じて金額の文字サイズを縮小し、64pxの桁あふれ（横スクロール）を防ぐ
  const allowanceStr = fmtYen(data.allowance);
  const allowanceSize =
    allowanceStr.length > 9 ? "text-[26px]" : allowanceStr.length > 7 ? "text-[32px]" : "text-[38px]";

  // 今日あと使えるゲージ：今日の予算に対する「残り」の割合（0〜1）。予算未設定なら満タン表示。
  const gaugePct =
    (data.budget?.todayBudget ?? 0) > 0
      ? Math.max(0, Math.min(1, data.allowance / data.budget!.todayBudget))
      : 1;
  // ゲージ・判子の色（信号機）を SVG stroke 用の実カラーに解決
  const signalHex =
    signal === "red" ? "var(--vermilion)" : signal === "yellow" ? "var(--caution)" : "var(--sage)";
  // カテゴリ円グラフ：上位5＋その他。感熱紙パレットに馴染む固定色。
  const CAT_COLORS = ["#2f8f5b", "#e8442e", "#c98a2e", "#5b7fb0", "#8a6ea8", "#9a9384"];
  const catRaw = (data.categoryBreakdown ?? []).filter((c) => c.total > 0);
  const catTotal = catRaw.reduce((s, c) => s + c.total, 0);
  const catTop = catRaw.slice(0, 5);
  const catOtherTotal = catRaw.slice(5).reduce((s, c) => s + c.total, 0);
  const donutSegs = [
    ...catTop.map((c, i) => ({
      name: c.name ?? "未分類",
      icon: c.icon,
      total: c.total,
      color: CAT_COLORS[i],
    })),
    ...(catOtherTotal > 0
      ? [{ name: "その他", icon: null as string | null, total: catOtherTotal, color: CAT_COLORS[5] }]
      : []),
  ];
  let donutAcc = 0;
  const donutArcs = donutSegs.map((s) => {
    const pct = catTotal > 0 ? (s.total / catTotal) * 100 : 0;
    const arc = { ...s, pct, offset: 25 - donutAcc };
    donutAcc += pct;
    return arc;
  });

  return (
    <div className="space-y-5">
      <input
        ref={camRef}
        type="file"
        accept="image/*"
        capture="environment"
        onChange={(e) => onImage(e, false)}
        className="hidden"
      />
      <input
        ref={libRef}
        type="file"
        accept="image/*"
        onChange={(e) => onImage(e, true)}
        className="hidden"
      />

      {/* B3: 初回セットアップカード（レシート世界観・番号付きステップ） */}
      {showSetup && data.counts && (
        <section className="rounded-2xl border border-rule bg-card px-5 pb-4 pt-4 shadow-sm">
          <div className="flex items-baseline justify-between">
            <p className="text-sm font-bold tracking-[0.04em]">はじめかた</p>
            <button
              onClick={() => {
                localStorage.setItem("cashsync-setup", "done");
                setShowSetup(false);
              }}
              className="text-[11px] text-ink-faint underline underline-offset-2"
            >
              閉じる
            </button>
          </div>
          <p className="mt-1 text-[11px] text-ink-faint">
            4つのステップで「今日あと使える」が動き出します
          </p>
          <ol className="mt-3 space-y-2.5 border-t border-rule pt-3">
            {(
              [
                {
                  // 収入源はバイト（シフト）でも給料（定期収入）でもOK。どちらか登録すれば完了
                  label: "収入を登録（バイト or 給料）",
                  done: data.counts.jobs > 0 || (data.counts.recurringIncome ?? 0) > 0,
                  href: null,
                  actions: [
                    { label: "シフト", href: "/settings#jobs" },
                    { label: "給料", href: "/settings#recurring" },
                  ],
                },
                {
                  label: "家賃などの固定費を登録",
                  done: data.counts.recurringExpense > 0,
                  href: "/settings#recurring",
                },
                { label: "貯金目標を決める", done: savingsGoal > 0, href: "/settings#goal" },
                { label: "最初の記録をしてみる", done: data.counts.expensesAll > 0, href: null },
              ] as {
                label: string;
                done: boolean;
                href: string | null;
                actions?: { label: string; href: string }[];
              }[]
            ).map((s, i) => (
              <li key={s.label} className="flex items-center gap-2.5 text-sm">
                <span
                  className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full border text-[13px] font-bold tabular-nums ${
                    s.done ? "border-sage text-sage" : "border-ink"
                  }`}
                >
                  {i + 1}
                </span>
                <span className={`min-w-0 flex-1 ${s.done ? "text-ink-faint line-through" : ""}`}>
                  {s.label}
                </span>
                {s.done ? (
                  <span className="shrink-0 rounded-md border border-sage px-1.5 py-0.5 text-xs font-bold text-sage">
                    済
                  </span>
                ) : s.actions ? (
                  <span className="flex shrink-0 gap-1.5">
                    {s.actions.map((a) => (
                      <Link
                        key={a.href}
                        href={a.href}
                        className="rounded border border-ink px-2 py-1 text-xs font-bold active:translate-y-0.5"
                      >
                        {a.label}
                      </Link>
                    ))}
                  </span>
                ) : s.href ? (
                  <Link
                    href={s.href}
                    className="shrink-0 rounded border border-ink px-2 py-1 text-xs font-bold active:translate-y-0.5"
                  >
                    設定へ
                  </Link>
                ) : (
                  <span className="flex shrink-0 gap-1.5">
                    <button
                      onClick={() => camRef.current?.click()}
                      className="rounded border border-ink px-2 py-1 text-xs font-bold active:translate-y-0.5"
                    >
                      撮る
                    </button>
                    <Link
                      href="/add"
                      className="rounded border border-ink px-2 py-1 text-xs font-bold active:translate-y-0.5"
                    >
                      手入力
                    </Link>
                  </span>
                )}
              </li>
            ))}
          </ol>
        </section>
      )}

      {/* 月初：先月の振り返りレポート案内（B3: 記録が1件もない間は出さない） */}
      {reviewMonth && hasExpenses && (
        <div className="flex items-center gap-2 rounded-md border border-rule bg-card px-3 py-2 text-xs">
          <span className="min-w-0 flex-1">先月の振り返りレポートができます</span>
          <Link
            href={`/stats?m=${reviewMonth}`}
            onClick={() => localStorage.setItem(`cashsync-review-note-${reviewMonth}`, "1")}
            className="shrink-0 rounded border border-ink px-2 py-1 font-bold"
          >
            見る
          </Link>
          <button
            onClick={() => {
              localStorage.setItem(`cashsync-review-note-${reviewMonth}`, "1");
              setReviewMonth(null);
            }}
            className="shrink-0 -my-1 -mr-1 px-2.5 py-1.5 text-ink-faint"
            aria-label="閉じる"
          >
            ✕
          </button>
        </div>
      )}

      {/* 週次振り返り案内（月〜水）。B3: 記録が1件もない間は出さない */}
      {weeklyKey && hasExpenses && (
        <div className="flex items-center gap-2 rounded-md border border-rule bg-card px-3 py-2 text-xs">
          <span className="min-w-0 flex-1">先週の振り返りができました</span>
          <Link
            href="/weekly"
            onClick={() => localStorage.setItem(`cashsync-weekly-note-${weeklyKey}`, "1")}
            className="shrink-0 rounded border border-ink px-2 py-1 font-bold"
          >
            見る
          </Link>
          <button
            onClick={() => {
              localStorage.setItem(`cashsync-weekly-note-${weeklyKey}`, "1");
              setWeeklyKey(null);
            }}
            className="shrink-0 -my-1 -mr-1 px-2.5 py-1.5 text-ink-faint"
            aria-label="閉じる"
          >
            ✕
          </button>
        </div>
      )}

      {/* つけ忘れ赦免カード */}
      {/* C5: 閉じている間に終わった読み取りの受け取り口。ここが無いと結果が迷子になる */}
      {pendingScans.length > 0 && (
        <div className="flex items-center gap-2 rounded-md border border-sage bg-card px-3 py-2 text-xs">
          <span className="min-w-0 flex-1">
            読み取りが終わった記録が{pendingScans.length}件あります
            {pendingScans[0]?.scan?.total ? `（${fmtYen(pendingScans[0].scan.total)}〜）` : ""}
          </span>
          <Link href="/scan?job=1" className="shrink-0 rounded border border-sage px-2 py-1 font-bold text-sage">
            確認する
          </Link>
        </div>
      )}

      {amnesty && (
        <div className="flex items-center gap-2 rounded-md border border-rule bg-card px-3 py-2 text-xs">
          <span className="min-w-0 flex-1">昨日（{fmtDateJa(amnesty)}）の記録がありません</span>
          <button onClick={dismissAmnesty} className="shrink-0 rounded border border-sage px-2 py-1 font-bold text-sage">
            0円だった
          </button>
          <Link
            href={`/add?date=${amnesty}`}
            onClick={dismissAmnesty}
            className="shrink-0 rounded border border-ink px-2 py-1 font-bold"
          >
            入力する
          </Link>
        </div>
      )}

      {/* ヒーロー：今日あと使える（アーク・ゲージ＝信号機カラー） */}
      <section className="rounded-3xl border border-rule bg-card px-5 pb-4 pt-5 shadow-sm">
        <p className="text-center text-[11px] tracking-[0.14em] text-ink-faint">
          {fmtDateJa(todayLocal())} ・ {data.user.name} さん
        </p>
        {customRange && (
          <p className="mt-0.5 text-center text-[10px] text-ink-faint">
            {fmtMD(customRange.start)}〜{fmtMD(customRange.end)}の集計（{Number(data.month.slice(5))}月）
          </p>
        )}
        {noIncomeSource ? (
          <>
            <p className="mt-3 text-center text-sm font-bold tracking-[0.04em] text-ink-faint">今日あと使える</p>
            <p className="mt-4 text-center text-2xl font-bold leading-snug">
              まず収入を登録すると
              <br />
              ここに金額が出ます
            </p>
            <div className="mt-4 flex justify-center gap-2">
              <Link href="/settings#jobs" className="rounded border border-ink px-3 py-1.5 text-sm font-bold active:translate-y-0.5">
                シフトで登録
              </Link>
              <Link href="/settings#recurring" className="rounded border border-ink px-3 py-1.5 text-sm font-bold active:translate-y-0.5">
                給料で登録
              </Link>
            </div>
          </>
        ) : budgetExhausted ? (
          <>
            <p className="mt-3 text-center text-sm font-bold tracking-[0.04em] text-ink-faint">今日あと使える</p>
            <p className="mt-4 text-center text-2xl font-bold leading-snug text-vermilion">
              今月使える残りが
              <br />
              ありません
            </p>
            {data.nextPayday && (
              <p className="mt-2 text-center text-xs text-ink-faint">
                次の給料日 {fmtDateJa(data.nextPayday.date)}{" "}
                {data.nextPayday.daysUntil === 0 ? "（今日）" : `まであと${data.nextPayday.daysUntil}日`}
              </p>
            )}
            <p className="mt-1 text-center text-[11px] text-ink-faint">
              固定費と使った分が今月の収入{savingsGoal > 0 && "（貯金目標を先取り後）"}を上回っています
            </p>
          </>
        ) : (
          <>
            <p className="mt-1 text-center text-[11px] font-medium tracking-[0.12em] text-ink-faint">今日あと使える</p>
            <div className="relative mx-auto mt-1 h-[128px] w-[230px]">
              <svg width="230" height="132" viewBox="0 0 230 132" className="block">
                <path d="M20 120 A95 95 0 0 1 210 120" fill="none" stroke="var(--rule)" strokeWidth="16" strokeLinecap="round" />
                <path
                  d="M20 120 A95 95 0 0 1 210 120"
                  fill="none"
                  stroke={signalHex}
                  strokeWidth="16"
                  strokeLinecap="round"
                  pathLength={298}
                  strokeDasharray={`${gaugePct * 298} 298`}
                />
              </svg>
              <div className="absolute inset-x-0 top-[62px] text-center">
                <p className={`font-black leading-none tracking-tight tabular-nums ${allowanceSize} ${signalColor}`}>
                  {allowanceStr}
                </p>
              </div>
            </div>
            {data.budget && (
              <p className="text-center text-[11px] text-ink-faint">
                今日の予算 {fmtYen(data.budget.todayBudget)} − 使った {fmtYen(data.budget.spentToday)}
              </p>
            )}
            {data.allowance < 0 ? (
              <p className="mt-1 text-center text-[11px] text-vermilion">
                今日は{fmtYen(-data.allowance)}超過（明日の予算が自動で減ります）
              </p>
            ) : (
              <p className="mt-1 text-center text-[11px] text-ink-faint">
                残り{data.daysRemaining}日{savingsGoal > 0 && " ・ 貯金目標を先取り"}で計算
              </p>
            )}
          </>
        )}
      </section>

      {/* 月末予測 ＋ 貯金目標 */}
      <div className="grid grid-cols-2 gap-3">
        <div className="rounded-2xl border border-rule bg-card p-4 shadow-sm">
          <p className="text-[11px] font-medium text-ink-faint">月末の予測</p>
          <p className={`mt-1 text-2xl font-black tabular-nums ${hasExpenses && !noIncomeSource ? signalColor : ""}`}>
            {noIncomeSource ? "未定" : `${forecast.forecast >= 0 ? "+" : ""}${fmtYen(forecast.forecast)}`}
          </p>
          <p className="mt-1 text-[10px] leading-tight text-ink-faint">
            {noIncomeSource
              ? "収入を登録すると出ます"
              : !hasExpenses
                ? "記録すると動き出します"
                : signal === "green"
                  ? "貯金目標を達成ペース"
                  : signal === "red"
                    ? forecast.forecast < 0
                      ? `1日あと${fmtYen(recoverPerDay)}で黒字`
                      : "月は黒字ペース"
                    : "黒字だが目標まであと少し"}
          </p>
        </div>
        <div className="rounded-2xl border border-rule bg-card p-4 shadow-sm">
          <p className="text-[11px] font-medium text-ink-faint">貯金目標</p>
          {savingsGoal > 0 ? (
            <>
              <p className="mt-1 text-2xl font-black tabular-nums">
                {goalPct}
                <span className="text-sm font-bold">%</span>
              </p>
              <div className="mt-2 h-1.5 rounded-full bg-paper">
                <div
                  className={`h-full rounded-full ${signal === "red" ? "bg-vermilion" : signal === "yellow" ? "bg-caution" : "bg-sage"}`}
                  style={{ width: `${goalPct}%` }}
                />
              </div>
              <p className="mt-1 text-[10px] text-ink-faint">{fmtYen(savingsGoal)} まで</p>
            </>
          ) : (
            <Link href="/settings#goal" className="mt-2 inline-block rounded border border-ink px-2 py-1 text-xs font-bold active:translate-y-0.5">
              目標を決める
            </Link>
          )}
        </div>
      </div>

      {/* 収入・次の給料日・ノーマネーデー */}
      {!noIncomeSource && (
        <div className="space-y-1.5 rounded-2xl border border-rule bg-card px-4 py-3 shadow-sm">
          <div className="flex items-baseline text-sm">
            <span className="text-xs text-ink-faint">収入</span>
            <span className="leader" />
            <span className="font-bold tabular-nums text-sage">{fmtYen(summary.incomeTotal)}</span>
          </div>
          {summary.shift.shiftCount > 0 && (
            <p className="text-right text-[10px] text-ink-faint">
              うちバイト見込み {fmtYen(summary.shift.total)}（{summary.shift.shiftCount}回）
              <Link href="/calendar" className="ml-1 underline underline-offset-2">
                シフトで確認
              </Link>
            </p>
          )}
          {data.nextPayday && (
            <div className="flex items-baseline text-sm">
              <span className="text-xs text-ink-faint">次の給料日</span>
              <span className="leader" />
              <span className="font-bold tabular-nums text-sage">
                {fmtDateJa(data.nextPayday.date)}
                {data.nextPayday.amount > 0 && ` +${fmtYen(data.nextPayday.amount)}`}
                <span className="ml-1 text-[10px] text-ink-faint">
                  {data.nextPayday.daysUntil === 0 ? "（今日）" : `あと${data.nextPayday.daysUntil}日`}
                </span>
              </span>
            </div>
          )}
          {hasExpenses && (
            <div className="flex items-baseline text-xs text-ink-faint">
              <span>
                <span>無</span> ノーマネーデー
              </span>
              <span className="leader" />
              <span className="font-semibold tabular-nums">
                今月{noMoney.count}日{noMoney.streak >= 2 && `・${noMoney.streak}日連続`}
              </span>
            </div>
          )}
        </div>
      )}

      {/* カテゴリ円グラフ（今月の支出） */}
      <section>
        <div className="flex items-baseline justify-between px-1">
          <h2 className="text-sm font-bold tracking-[0.04em]">今月の支出</h2>
          <span className="text-base font-bold tabular-nums text-vermilion">{fmtYen(summary.expenseTotal)}</span>
        </div>
        {catTotal > 0 ? (
          <div className="mt-2 flex items-center gap-4 rounded-2xl border border-rule bg-card p-4 shadow-sm">
            <div className="relative h-28 w-28 shrink-0">
              <svg viewBox="0 0 42 42" className="h-28 w-28">
                <circle cx="21" cy="21" r="15.9" fill="none" stroke="var(--paper)" strokeWidth="6" />
                {donutArcs.map((a, i) => (
                  <circle
                    key={i}
                    cx="21"
                    cy="21"
                    r="15.9"
                    fill="none"
                    stroke={a.color}
                    strokeWidth="6"
                    strokeDasharray={`${a.pct} ${100 - a.pct}`}
                    strokeDashoffset={a.offset}
                  />
                ))}
              </svg>
              <div className="absolute inset-0 flex flex-col items-center justify-center">
                <span className="text-[10px] text-ink-faint">支出</span>
                <span className="text-[15px] font-bold tabular-nums">{fmtYen(catTotal)}</span>
              </div>
            </div>
            <ul className="flex-1 space-y-1.5">
              {donutArcs.map((a, i) => (
                <li key={i} className="flex items-center gap-2 text-[13px]">
                  <span className="h-2.5 w-2.5 shrink-0 rounded-sm" style={{ background: a.color }} />
                  <span className="flex-1 truncate">{a.name}</span>
                  <span className="font-semibold tabular-nums text-ink-faint">{Math.round(a.pct)}%</span>
                </li>
              ))}
            </ul>
          </div>
        ) : (
          <p className="mt-2 rounded-2xl border border-rule bg-card px-4 py-6 text-center text-xs text-ink-faint shadow-sm">
            記録すると、カテゴリ別の内訳が円グラフで出ます
          </p>
        )}
      </section>

      {/* 支出の入力：3つの入口（撮る/スクショ/手入力）をカードで並べる */}
      <section>
        <h2 className="text-sm font-bold tracking-[0.04em]">支出を記録する</h2>
        <div className="mt-2 grid grid-cols-3 gap-3">
          <button
            onClick={() => camRef.current?.click()}
            className="rounded-2xl border border-rule bg-card px-2 py-4 text-center shadow-sm active:translate-y-0.5"
          >
            <span className="mx-auto flex h-11 w-11 items-center justify-center rounded-2xl bg-paper text-ink">
              <CameraIcon className="h-6 w-6" />
            </span>
            <span className="mt-1.5 block text-[13px] font-bold">撮る</span>
            <span className="block text-[10px] text-ink-faint">レシート</span>
          </button>
          <button
            onClick={onScreenshotTap}
            className="rounded-2xl border border-rule bg-card px-2 py-4 text-center shadow-sm active:translate-y-0.5"
          >
            <span className="mx-auto flex h-11 w-11 items-center justify-center rounded-2xl bg-paper text-ink">
              <ScreenshotIcon className="h-6 w-6" />
            </span>
            <span className="mt-1.5 block text-[13px] font-bold">スクショ</span>
            <span className="block text-[10px] text-ink-faint">決済画面</span>
          </button>
          <Link
            href="/add"
            className="rounded-2xl border border-rule bg-card px-2 py-4 text-center shadow-sm active:translate-y-0.5"
          >
            <span className="mx-auto flex h-11 w-11 items-center justify-center rounded-2xl bg-paper text-ink">
              <PencilIcon className="h-6 w-6" />
            </span>
            <span className="mt-1.5 block text-[13px] font-bold">手入力</span>
            <span className="block text-[10px] text-ink-faint">話してもOK</span>
          </Link>
        </div>
        <p className="mt-2 text-center text-[11px] text-ink-faint">
          レシートも決済スクショも、撮るだけで自動入力
        </p>

        {/* かんたん入力ボタン：設定で登録した定型支出を1タップで即記録（0件なら非表示） */}
        {presets.length > 0 && (
          <div className="mt-3 grid grid-cols-3 gap-2">
            {presets.map((p) => (
              <button
                key={p.id}
                onClick={() => recordPreset(p)}
                disabled={presetBusy}
                className="rounded-sm border border-rule bg-card px-1.5 py-2.5 text-center shadow-sm active:translate-y-0.5 disabled:opacity-50"
              >
                <CategoryIcon icon={p.icon} className="mx-auto h-5 w-5 text-ink-faint" />
                <span className="mt-1 block truncate text-xs">{p.label}</span>
                <span className="block text-[13px] font-bold tabular-nums">{fmtYen(p.amount)}</span>
              </button>
            ))}
          </div>
        )}
      </section>

      {/* 最近の支出：アイコンチップ付きの行 */}
      <section>
        <div className="flex items-baseline justify-between px-1">
          <h2 className="text-sm font-bold tracking-[0.04em]">最近の支出</h2>
          <Link href="/history" className="text-[11px] text-ink-faint underline underline-offset-2">
            すべて見る
          </Link>
        </div>
        <ul className="mt-1">
          {data.recent.length === 0 && (
            <li className="py-4 text-center text-xs text-ink-faint">
              まだ記録がありません。上の「撮る」から始めましょう。
            </li>
          )}
          {data.recent.map((e) =>
            confirmId === e.id ? (
              /* C7: 誤タップ対策。✕の直後にその場で確認してから削除する */
              <li key={e.id} className="flex items-center gap-2 border-b border-rule/70 py-2.5 text-sm">
                <span className="min-w-0 flex-1 truncate text-xs">
                  「{e.memo || e.category || "支出"} {fmtYen(e.amount)}」を削除しますか？
                </span>
                <button
                  onClick={() => removeExpense(e)}
                  className="shrink-0 rounded border border-vermilion px-2 py-1 text-xs font-bold text-vermilion"
                >
                  削除する
                </button>
                <button
                  onClick={() => setConfirmId(null)}
                  className="shrink-0 rounded border border-rule px-2 py-1 text-xs text-ink-faint"
                >
                  やめる
                </button>
              </li>
            ) : (
              <li key={e.id} className="flex items-center gap-3 border-b border-rule/70 py-2.5">
                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-paper text-ink-faint">
                  <CategoryIcon icon={e.icon} className="h-5 w-5" />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm">{e.memo || e.category || "支出"}</p>
                  {e.category && <p className="text-[11px] text-ink-faint">{e.category}</p>}
                </div>
                <span className="shrink-0 text-[15px] font-bold tabular-nums">{fmtYen(e.amount)}</span>
                <button
                  onClick={() => setConfirmId(e.id)}
                  className="-my-1.5 shrink-0 px-2 py-1.5 text-xs text-ink-faint"
                  aria-label="削除"
                >
                  ✕
                </button>
              </li>
            ),
          )}
        </ul>
      </section>

      {/* B6: スクショ入力の選択ダイアログ（iOS・初回のみ） */}
      {shortcutDialog && (
        <div
          className="fixed inset-0 z-50 flex items-end bg-ink/40"
          onClick={() => setShortcutDialog(false)}
        >
          <div
            className="rounded-2xl bg-card mx-auto w-full max-w-md px-5 pb-8 pt-5"
            onClick={(e) => e.stopPropagation()}
          >
            <p className="text-center text-xs text-ink-faint">スクショから記録</p>
            <p className="mt-2 text-xs leading-relaxed text-ink-faint">
              ショートカット連携を設定すると、スクショの読み取りから記録・スクショ削除までワンタップになります。設定がまだの場合は「写真から選ぶ」でも記録できます。
            </p>
            <div className="mt-3 space-y-2">
              <button
                onClick={() => {
                  if (shortcutDefault) localStorage.setItem("cashsync-ios-shortcut", "1");
                  setShortcutDialog(false);
                  runShortcut();
                }}
                className="w-full rounded-xl bg-vermilion py-3 text-base font-bold text-card shadow-[0_2px_0_var(--vermilion-deep)] active:translate-y-0.5 active:shadow-none"
              >
                ショートカットで開く（設定済みの方）
              </button>
              <button
                onClick={() => {
                  setShortcutDialog(false);
                  libRef.current?.click();
                }}
                className="w-full rounded-md border border-rule bg-paper py-3 text-sm"
              >
                写真から選ぶ
              </button>
            </div>
            <label className="mt-3 flex items-center gap-2 text-xs text-ink">
              <input
                type="checkbox"
                checked={shortcutDefault}
                onChange={(e) => setShortcutDefault(e.target.checked)}
                className="h-4 w-4 accent-vermilion"
              />
              次からショートカットで開く（この確認を出さない）
            </label>
            <Link
              href="/settings"
              onClick={() => setShortcutDialog(false)}
              className="mt-3 block w-full text-center text-[11px] text-ink-faint underline underline-offset-2"
            >
              ショートカット連携の設定について（設定画面）
            </Link>
          </div>
        </div>
      )}

      {/* 完了フィードバックのトースト（記録・削除直後は「元に戻す」つき） */}
      <Toast toast={toast} hide={hide} />
    </div>
  );
}
