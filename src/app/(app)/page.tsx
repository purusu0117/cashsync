"use client";

// ホーム：今日使えるお金（予算信号機）＋月末予測＋貯金目標＋ノーマネーデー＋入力方法3種。
// カレンダー自動同期がONなら、開いたときに裏で今月・来月のシフトを差分同期する。
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { CameraIcon, CategoryIcon, PencilIcon, ScreenshotIcon } from "@/components/Icons";
import Loading from "@/components/Loading";
import { cachedFetch } from "@/lib/cachedFetch";
import { apiCall, apiJson } from "@/lib/clientApi";
import {
  DEFAULT_EXCLUDES,
  getCalendarToken,
  isAutoSyncOn,
  syncMonth,
} from "@/lib/calendarImport";
import { fmtDateJa, fmtYen, todayLocal } from "@/lib/format";
import { setPendingImage } from "@/lib/pendingImage";

interface Summary {
  user: { name: string };
  month: string;
  summary: {
    incomeTotal: number;
    expenseTotal: number;
    shift: { total: number; shiftCount: number };
  };
  savingsGoal: number;
  allowance: number; // 今日あと使える額（今日の予算 − 今日の支出。マイナス＝超過）
  // 日次予算の内訳（旧キャッシュには無いので optional）
  budget?: {
    todayBudget: number;
    spentToday: number;
    remainingToday: number;
    spentBeforeToday: number;
    daysRemaining: number;
  };
  daysRemaining: number;
  noMoney: { count: number; streak: number };
  forecast: { forecast: number; avgDaily: number };
  yesterday: { date: string; recorded: boolean };
  recent: {
    id: string;
    date: string;
    amount: number;
    memo: string;
    category: string | null;
    icon: string | null;
  }[];
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
  const [reviewMonth, setReviewMonth] = useState<string | null>(null); // 月初の振り返り案内
  const [weeklyKey, setWeeklyKey] = useState<string | null>(null); // 週次振り返り案内（週の前半だけ）
  const [isIOS, setIsIOS] = useState(false);
  const [presets, setPresets] = useState<Preset[]>([]);
  // かんたん入力のトースト：記録直後は「元に戻す」つき、エラー時はメッセージのみ
  const [toast, setToast] = useState<{ msg: string; undoId?: string } | null>(null);
  const [presetBusy, setPresetBusy] = useState(false);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const syncedRef = useRef(false);
  const camRef = useRef<HTMLInputElement>(null);
  const libRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    try {
      // キャッシュファースト：前回のデータを即表示→裏で最新に差し替え（タブ切替のフラッシュ対策）
      await cachedFetch<Summary>("/api/summary", (d) => {
        setData(d);
        // つけ忘れ赦免：昨日の記録が1件も無ければ、細いカードで確認（完璧主義による離脱対策）
        const yd = d.yesterday?.date ?? yesterdayLocal();
        const dismissed = localStorage.getItem(`cashsync-amnesty-${yd}`);
        setAmnesty(!d.yesterday?.recorded && !dismissed && yd.startsWith(d.month) ? yd : null);
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : "読み込みに失敗しました。");
    }
    // かんたん入力ボタン（0件なら非表示なので、失敗してもホームは止めない）
    cachedFetch<{ presets?: Preset[] }>("/api/presets", (d) => setPresets(d.presets ?? [])).catch(
      () => {},
    );
  }, []);

  function showToast(msg: string, undoId?: string) {
    if (toastTimer.current) clearTimeout(toastTimer.current);
    setToast({ msg, undoId });
    // Undoつきは考える時間を長めに（8秒）、通常メッセージは4秒
    toastTimer.current = setTimeout(() => setToast(null), undoId ? 8000 : 4000);
  }

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
      showToast(`記録しました ${fmtYen(p.amount)}`, d.id);
      load();
    } catch (e) {
      showToast(e instanceof Error ? e.message : "記録に失敗しました。");
    } finally {
      setPresetBusy(false);
    }
  }

  // 「元に戻す」：直前のかんたん入力を削除
  async function undoPreset(expenseId: string) {
    if (toastTimer.current) clearTimeout(toastTimer.current);
    setToast(null);
    try {
      await apiCall(`/api/expenses?id=${expenseId}`, { method: "DELETE" });
      showToast("記録を取り消しました");
      load();
    } catch (e) {
      showToast(e instanceof Error ? e.message : "取り消しに失敗しました。");
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
    setIsIOS(/iPad|iPhone|iPod/.test(navigator.userAgent));
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

  // 間違えて記録した支出をその場で削除（確認つき）
  async function removeExpense(e: Summary["recent"][number]) {
    if (!confirm(`「${e.memo || e.category || "支出"} ${fmtYen(e.amount)}」を削除しますか？`)) return;
    await fetch(`/api/expenses?id=${e.id}`, { method: "DELETE" });
    load();
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

  if (error && !data) return <p className="mt-10 text-center text-sm text-vermilion">{error}</p>;
  if (!data) return <Loading />;

  const { summary, forecast, savingsGoal, noMoney } = data;
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
  const goalPct =
    savingsGoal > 0 ? Math.max(0, Math.min(100, Math.round((forecast.forecast / savingsGoal) * 100))) : 0;

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

      {/* 月初：先月の振り返りレポート案内 */}
      {reviewMonth && (
        <div className="flex items-center gap-2 rounded-md border border-rule bg-card px-3 py-2 text-xs">
          <span className="min-w-0 flex-1">先月の振り返りレポートができます</span>
          <Link
            href={`/stats?m=${reviewMonth}`}
            onClick={() => localStorage.setItem(`cashsync-review-note-${reviewMonth}`, "1")}
            className="dot shrink-0 rounded border border-ink px-2 py-1"
          >
            見る
          </Link>
          <button
            onClick={() => {
              localStorage.setItem(`cashsync-review-note-${reviewMonth}`, "1");
              setReviewMonth(null);
            }}
            className="shrink-0 text-ink-faint"
            aria-label="閉じる"
          >
            ✕
          </button>
        </div>
      )}

      {/* 週次振り返り案内（月〜水） */}
      {weeklyKey && (
        <div className="flex items-center gap-2 rounded-md border border-rule bg-card px-3 py-2 text-xs">
          <span className="min-w-0 flex-1">先週の振り返りができました</span>
          <Link
            href="/weekly"
            onClick={() => localStorage.setItem(`cashsync-weekly-note-${weeklyKey}`, "1")}
            className="dot shrink-0 rounded border border-ink px-2 py-1"
          >
            見る
          </Link>
          <button
            onClick={() => {
              localStorage.setItem(`cashsync-weekly-note-${weeklyKey}`, "1");
              setWeeklyKey(null);
            }}
            className="shrink-0 text-ink-faint"
            aria-label="閉じる"
          >
            ✕
          </button>
        </div>
      )}

      {/* つけ忘れ赦免カード */}
      {amnesty && (
        <div className="flex items-center gap-2 rounded-md border border-rule bg-card px-3 py-2 text-xs">
          <span className="min-w-0 flex-1">昨日（{fmtDateJa(amnesty)}）の記録がありません</span>
          <button onClick={dismissAmnesty} className="dot shrink-0 rounded border border-sage px-2 py-1 text-sage">
            0円だった
          </button>
          <Link
            href={`/add?date=${amnesty}`}
            onClick={dismissAmnesty}
            className="dot shrink-0 rounded border border-ink px-2 py-1"
          >
            入力する
          </Link>
        </div>
      )}

      {/* メインレシート：この画面の主役は1枚だけ（店名ヘッダ→金額→予測→内訳→バーコード） */}
      <section className="zig zig-t zig-b px-5 pt-5 pb-4 shadow-sm">
        <p className="dot text-center text-sm tracking-[0.42em]">CASHSYNC</p>
        <p className="mt-1 text-center text-[11px] text-ink-faint">
          {fmtDateJa(todayLocal())} ・ {data.user.name} さん
        </p>

        <div className="cutline my-3.5" />

        <p className="dot text-center text-sm tracking-[0.18em] text-ink-faint">＊ 今日あと使える ＊</p>
        <p className={`dot mt-3 text-center text-[64px] leading-none tabular-nums ${signalColor}`}>
          {fmtYen(data.allowance).replace("¥-", "-¥")}
        </p>
        {data.budget && (
          <p className="mt-2 text-center text-xs text-ink-faint">
            今日の予算 {fmtYen(data.budget.todayBudget)} − 今日使った {fmtYen(data.budget.spentToday)}
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

        <div className="cutline my-4" />

        {/* 月末予測 ＋ 判子（黒字/注意/赤字）：署名要素はここに1つだけ */}
        <div className="relative pr-16">
          <div className="flex items-baseline text-sm">
            <span className="text-ink-faint">このペースだと月末</span>
            <span className="leader" />
            <span className={`dot text-xl tabular-nums ${signalColor}`}>
              {forecast.forecast >= 0 ? "+" : ""}
              {fmtYen(forecast.forecast).replace("¥-", "-¥")}
            </span>
          </div>
          <p className={`mt-0.5 text-[11px] ${signal === "red" ? "text-vermilion" : "text-ink-faint"}`}>
            {signal === "green" && "貯金目標を達成するペースです"}
            {signal === "red" && `1日あと${fmtYen(recoverPerDay)}減らせば黒字`}
            {signal === "yellow" && "黒字だが目標まであと少し"}
          </p>
          <span
            className={`stamp dot absolute right-0 top-1/2 -translate-y-1/2 px-2 py-1 text-sm ${signalColor}`}
            style={{ borderColor: "currentColor" }}
          >
            {signal === "green" ? "黒字" : signal === "yellow" ? "注意" : "赤字"}
          </span>
        </div>

        {/* 貯金目標の進捗 */}
        {savingsGoal > 0 && (
          <div className="mt-3">
            <div className="flex items-baseline justify-between text-xs text-ink-faint">
              <span>貯金目標 {fmtYen(savingsGoal)}</span>
              <span className="dot tabular-nums">{goalPct}%</span>
            </div>
            <div className="mt-1 h-2 rounded-full bg-paper">
              <div
                className={`h-full rounded-full ${signal === "red" ? "bg-vermilion" : signal === "yellow" ? "bg-caution" : "bg-sage"}`}
                style={{ width: `${goalPct}%` }}
              />
            </div>
          </div>
        )}

        <div className="cutline my-4" />
        <div className="flex items-baseline justify-between text-sm">
          <span className="text-ink-faint">収入</span>
          <span className="leader" />
          <span className="dot text-base tabular-nums text-sage">{fmtYen(summary.incomeTotal)}</span>
        </div>
        {summary.shift.shiftCount > 0 && (
          <p className="mt-0.5 text-right text-[11px] text-ink-faint">
            うちバイト見込み {fmtYen(summary.shift.total)}（{summary.shift.shiftCount}回）
          </p>
        )}
        <div className="mt-2 flex items-baseline justify-between text-sm">
          <span className="text-ink-faint">支出</span>
          <span className="leader" />
          <span className="dot text-base tabular-nums text-vermilion">
            {fmtYen(summary.expenseTotal)}
          </span>
        </div>
        <div className="mt-2 flex items-baseline justify-between text-xs text-ink-faint">
          <span>
            <span className="mu">無</span> ノーマネーデー
          </span>
          <span className="leader" />
          <span className="dot tabular-nums">
            今月{noMoney.count}日{noMoney.streak >= 2 && `・${noMoney.streak}日連続`}
          </span>
        </div>

        <div className="barcode mt-4" />
        <p className="dot mt-1 text-center text-[10px] tracking-[0.3em] text-ink-faint">
          {data.month.replace("-", "")}
        </p>
      </section>

      {/* 支出の入力：3つの入口を1段のボタン列に圧縮（最近の支出を1画面に入れるため） */}
      <section>
        <h2 className="dot text-sm tracking-[0.14em]">支出を記録する</h2>
        <div className="mt-2 grid grid-cols-3 gap-2">
          <button
            onClick={() => camRef.current?.click()}
            className="rounded-sm border border-rule bg-card px-2 py-3 text-center shadow-sm active:translate-y-0.5"
          >
            <CameraIcon className="mx-auto h-6 w-6" />
            <span className="dot mt-1 block text-[13px]">撮る</span>
          </button>
          <button
            onClick={() => (isIOS ? runShortcut() : libRef.current?.click())}
            className="rounded-sm border border-rule bg-card px-2 py-3 text-center shadow-sm active:translate-y-0.5"
          >
            <ScreenshotIcon className="mx-auto h-6 w-6" />
            <span className="dot mt-1 block text-[13px]">スクショ</span>
          </button>
          <Link
            href="/add"
            className="rounded-sm border border-rule bg-card px-2 py-3 text-center shadow-sm active:translate-y-0.5"
          >
            <PencilIcon className="mx-auto h-6 w-6" />
            <span className="dot mt-1 block text-[13px]">手入力</span>
          </Link>
        </div>
        <p className="mt-1.5 text-center text-[11px] text-ink-faint">
          レシートは撮るだけで自動入力・手入力は話すのもOK
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
                <span className="dot block text-[13px] tabular-nums">{fmtYen(p.amount)}</span>
              </button>
            ))}
          </div>
        )}
      </section>

      {/* 直近の支出：カードにせず、地の上にそのまま印字（主役はメインレシート1枚） */}
      <section>
        <div className="flex items-baseline justify-between">
          <h2 className="dot text-sm tracking-[0.14em]">最近の支出</h2>
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
          {data.recent.map((e) => (
            <li key={e.id} className="flex items-baseline gap-1 border-b border-rule/70 py-2 text-sm">
              {e.category && (
                <CategoryIcon icon={e.icon} className="h-4 w-4 shrink-0 self-center text-ink-faint" />
              )}
              <span className="truncate">{e.memo || e.category || "支出"}</span>
              <span className="ml-1.5 shrink-0 text-[10px] text-ink-faint">{e.category}</span>
              <span className="leader" />
              <span className="dot text-[15px] tabular-nums">{fmtYen(e.amount)}</span>
              <button
                onClick={() => removeExpense(e)}
                className="shrink-0 px-1 text-xs text-ink-faint"
                aria-label="削除"
              >
                ✕
              </button>
            </li>
          ))}
        </ul>
      </section>

      {/* かんたん入力のトースト（記録直後は「元に戻す」つき） */}
      {toast && (
        <div className="fixed bottom-24 left-1/2 z-50 flex w-[calc(100%-3rem)] max-w-sm -translate-x-1/2 items-center gap-2 rounded-md bg-ink px-4 py-3 text-sm text-card shadow-lg">
          <span className="min-w-0 flex-1">{toast.msg}</span>
          {toast.undoId && (
            <button
              onClick={() => undoPreset(toast.undoId!)}
              className="dot shrink-0 rounded border border-card/70 px-2.5 py-1 text-xs"
            >
              元に戻す
            </button>
          )}
        </div>
      )}
    </div>
  );
}
