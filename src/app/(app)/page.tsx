"use client";

// ホーム：今日使えるお金（予算信号機）＋月末予測＋貯金目標＋ノーマネーデー＋入力方法3種。
// カレンダー自動同期がONなら、開いたときに裏で今月・来月のシフトを差分同期する。
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import Loading from "@/components/Loading";
import { cachedFetch } from "@/lib/cachedFetch";
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
  allowance: number;
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
  }, []);

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

      <header className="flex items-baseline justify-between">
        <p className="dot text-sm text-ink-faint">{fmtDateJa(todayLocal())}</p>
        <p className="text-xs text-ink-faint">
          {noMoney.streak >= 2 && <span className="mr-2">🈚{noMoney.streak}日連続</span>}
          {data.user.name} さん
        </p>
      </header>

      {/* 月初：先月の振り返りレポート案内 */}
      {reviewMonth && (
        <div className="flex items-center gap-2 rounded-md border border-rule bg-card px-3 py-2 text-xs">
          <span className="min-w-0 flex-1">🧾 先月の振り返りレポートができます</span>
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
          <span className="min-w-0 flex-1">🧾 先週の振り返りができました</span>
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
            0円だった🈚
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

      {/* ヒーロー：レシート片（予算信号機） */}
      <section className="zig zig-t zig-b px-5 pt-6 pb-5 shadow-sm">
        <p className="dot text-center text-sm text-ink-faint">＊ 今日使えるお金 ＊</p>
        <p className={`dot text-center text-6xl mt-2 tabular-nums ${signalColor}`}>
          {fmtYen(Math.max(0, data.allowance))}
        </p>
        <p className="mt-1 text-center text-[11px] text-ink-faint">
          残り{data.daysRemaining}日{savingsGoal > 0 && " ・ 貯金目標を先取りした残り"}から計算
        </p>

        {/* 月末予測（黒字チェッカー） */}
        <p className={`mt-2 text-center text-sm ${signalColor}`}>
          このペースだと月末{" "}
          <span className="dot tabular-nums">
            {forecast.forecast >= 0 ? "+" : ""}
            {fmtYen(forecast.forecast).replace("¥-", "-¥")}
          </span>
          {signal === "green" && " 🎉"}
          {signal === "red" && ` ⚠ 1日あと${fmtYen(recoverPerDay)}減らせば黒字`}
          {signal === "yellow" && " （目標まであと少し）"}
        </p>

        {/* 貯金目標の進捗 */}
        {savingsGoal > 0 && (
          <div className="mt-3">
            <div className="flex items-baseline justify-between text-[11px] text-ink-faint">
              <span>💰 貯金目標 {fmtYen(savingsGoal)}</span>
              <span className="dot">{goalPct}%</span>
            </div>
            <div className="mt-1 h-1.5 rounded-full bg-paper">
              <div
                className={`h-full rounded-full ${signal === "red" ? "bg-vermilion" : signal === "yellow" ? "bg-caution" : "bg-sage"}`}
                style={{ width: `${goalPct}%` }}
              />
            </div>
          </div>
        )}

        <div className="cutline my-4" />
        <div className="flex justify-between text-sm">
          <span className="text-ink-faint">収入</span>
          <span className="leader" />
          <span className="dot tabular-nums text-sage">{fmtYen(summary.incomeTotal)}</span>
        </div>
        <div className="mt-1.5 flex justify-between text-sm">
          <span className="text-ink-faint">支出</span>
          <span className="leader" />
          <span className="dot tabular-nums text-vermilion">{fmtYen(summary.expenseTotal)}</span>
        </div>
        <div className="mt-1.5 flex justify-between text-[11px] text-ink-faint">
          <span>🈚 ノーマネーデー</span>
          <span className="leader" />
          <span className="dot tabular-nums">今月{noMoney.count}日</span>
        </div>
        {summary.shift.shiftCount > 0 && (
          <p className="mt-2 text-right text-[11px] text-ink-faint">
            うちバイト見込み {fmtYen(summary.shift.total)}（{summary.shift.shiftCount}回）
          </p>
        )}
      </section>

      {/* 支出の入力方法（3つを明確に） */}
      <section>
        <h2 className="dot text-xs text-ink-faint">支出を記録する</h2>
        <div className="mt-2 grid grid-cols-2 gap-2">
          <button
            onClick={() => camRef.current?.click()}
            className="zig zig-t zig-b px-3 py-4 text-center shadow-sm active:translate-y-0.5"
          >
            <span className="text-3xl">📷</span>
            <span className="dot mt-1 block text-sm">レシートを撮る</span>
            <span className="block text-[10px] text-ink-faint">撮るだけで自動入力</span>
          </button>
          <button
            onClick={() => (isIOS ? runShortcut() : libRef.current?.click())}
            className="zig zig-t zig-b px-3 py-4 text-center shadow-sm active:translate-y-0.5"
          >
            <span className="text-3xl">🖼️</span>
            <span className="dot mt-1 block text-sm">スクショから</span>
            <span className="block text-[10px] text-ink-faint">
              {isIOS ? "記録後に自動削除・1回10枚まで" : "PayPay・通販画面もOK"}
            </span>
          </button>
        </div>
        <Link
          href="/add"
          className="zig zig-t zig-b mt-2 block px-4 py-4 text-center shadow-sm active:translate-y-0.5"
        >
          <span className="text-2xl">✏️</span>
          <span className="dot ml-2 align-middle text-base">自分で入力する</span>
          <span className="mt-0.5 block text-[10px] text-ink-faint">
            金額を打つ／🎤話す（「昨日セブンで650円」）のどちらでも
          </span>
        </Link>
      </section>

      {/* 直近の支出 */}
      <section className="zig zig-t zig-b px-5 py-4 shadow-sm">
        <div className="flex items-center justify-between">
          <h2 className="dot text-xs text-ink-faint">最近の支出</h2>
          <Link href="/history" className="text-[11px] text-ink-faint underline underline-offset-2">
            すべて見る
          </Link>
        </div>
        <ul className="mt-2">
          {data.recent.length === 0 && (
            <li className="py-4 text-center text-xs text-ink-faint">
              まだ記録がありません。上の📷からレシートを撮ってみましょう。
            </li>
          )}
          {data.recent.map((e) => (
            <li key={e.id} className="flex items-baseline gap-1 py-1.5 text-sm">
              <span>{e.icon}</span>
              <span className="truncate">{e.memo || e.category || "支出"}</span>
              <span className="leader" />
              <span className="dot tabular-nums">{fmtYen(e.amount)}</span>
              <button
                onClick={() => removeExpense(e)}
                className="shrink-0 px-1 text-xs text-vermilion"
                aria-label="削除"
              >
                ✕
              </button>
            </li>
          ))}
        </ul>
        <div className="barcode mt-4" />
        <p className="dot mt-1 text-center text-[10px] tracking-[0.3em] text-ink-faint">
          {data.month.replace("-", "")}
        </p>
      </section>
    </div>
  );
}
