"use client";

// 設定：プラン（プレミアム課金）／バイト先（時給）／定期支出・収入／カテゴリ／ログアウト
import Link from "next/link";
import { type ReactNode, useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { CardIcon, CategoryIcon, CoinIcon } from "@/components/Icons";
import Loading from "@/components/Loading";
import {
  CategoryEditSheet,
  JobEditSheet,
  PresetEditSheet,
} from "@/components/SettingsEditSheets";
import { CATEGORY_ICON_KEYS, DEFAULT_CATEGORY_ICON } from "@/lib/categoryIcons";
import { cachedFetch, clearApiCache } from "@/lib/cachedFetch";
import { apiCall, apiJson } from "@/lib/clientApi";
import { fmtYen } from "@/lib/format";
import { isNativePlatform } from "@/lib/native";
import { isPurchasesAvailable, purchasePremium, restorePremium } from "@/lib/purchases";

interface Job {
  id: string;
  name: string;
  weekday_rate: number;
  weekend_holiday_rate: number;
  transport_per_shift: number;
  color: string;
  closing_day: number;
  pay_month_offset: number;
  pay_day: number;
  pay_same_day: number;
  shift_count: number;
}
interface Recurring {
  id: string;
  kind: "expense" | "income";
  name: string;
  amount: number;
  category: string | null;
  start_month: string;
  post_day: number;
  end_month: string | null;
  interval: "monthly" | "yearly";
}
interface Category {
  id: string;
  name: string;
  icon: string;
}
interface Preset {
  id: string;
  label: string;
  amount: number;
  category_id: string | null;
  category: string | null;
  icon: string | null;
}

// かんたん入力ボタンの上限（/api/presets 側の制限と同じ値）
const MAX_PRESETS = 12;

type PlanName = "free" | "premium" | "founder";
const PLAN_LABEL: Record<PlanName, string> = {
  free: "無料プラン",
  premium: "プレミアム",
  founder: "ファウンダー",
};
function planOf(v: unknown): PlanName {
  return v === "premium" || v === "founder" ? v : "free";
}

// 分割払いは「◯◯（分割N回）」名の定期支出として保存されている（addSplit 参照）
const SPLIT_RE = /（分割(\d+)回）/;

/** 'YYYY-MM' 同士の月差（to - from）。to が過去なら負 */
function monthsBetween(from: string, to: string): number {
  const [fy, fm] = from.split("-").map(Number);
  const [ty, tm] = to.split("-").map(Number);
  return (ty - fy) * 12 + (tm - fm);
}

/**
 * 折りたたみ一覧：登録が増えてもページが伸びないよう、既定は閉じて要約だけ印字する。
 * レシート世界観に合わせて開閉は ▼／▲ の活字記号（絵文字なし）。
 */
function Fold({ summary, children }: { summary: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="mt-2">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex w-full items-baseline rounded-md border border-rule bg-paper px-3 py-2 text-left active:translate-y-0.5"
      >
        <span className="dot min-w-0 flex-1 truncate text-xs tabular-nums">{summary}</span>
        <span className="ml-2 shrink-0 text-xs text-ink-faint">{open ? "とじる ▲" : "ひらく ▼"}</span>
      </button>
      {open && <div className="mt-2">{children}</div>}
    </div>
  );
}

export default function SettingsPage() {
  const [jobs, setJobs] = useState<Job[]>([]);
  const [recurring, setRecurring] = useState<Recurring[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [goal, setGoal] = useState("");
  const [goalSaved, setGoalSaved] = useState(false);
  const [pageError, setPageError] = useState("");
  const [apiToken, setApiToken] = useState("");
  const [tokenCopied, setTokenCopied] = useState(false);
  // B12: 今月のAI使用量（読み取り/文章入力の残量表示）
  const [aiUsage, setAiUsage] = useState<{
    scans: { used: number; limit: number | null };
    parses: { used: number; limit: number | null };
  } | null>(null);
  // B7: 編集シートの対象（null = 閉じている）
  const [editJob, setEditJob] = useState<Job | null>(null);
  const [editCategory, setEditCategory] = useState<Category | null>(null);
  const [editPreset, setEditPreset] = useState<Preset | null>(null);
  // B7: バイト先削除の行内確認（「シフト◯件も削除されます」を明示してから消す）
  const [jobConfirmId, setJobConfirmId] = useState<string | null>(null);

  async function tryApi(fn: () => Promise<void>) {
    setPageError("");
    try {
      await fn();
    } catch (e) {
      setPageError(e instanceof Error ? e.message : "保存に失敗しました。");
    }
  }

  const [ready, setReady] = useState(false); // 初回データ（キャッシュ含む）が来るまでスケルトン表示

  const load = useCallback(async () => {
    // キャッシュファースト＋並列取得：前回のデータを即表示→裏で最新に差し替え
    // （これが無いとタブ切替のたびに一瞬「未設定の初期画面」が見える）
    await Promise.all([
      cachedFetch<{ jobs?: Job[] }>("/api/jobs", (d) => {
        setJobs(d.jobs ?? []);
        setReady(true);
      }),
      cachedFetch<{ items?: Recurring[] }>("/api/recurring", (d) => setRecurring(d.items ?? [])),
      cachedFetch<{ categories?: Category[] }>("/api/categories", (d) => {
        setCategories(d.categories ?? []);
        const sub = (d.categories ?? []).find((x) => x.name === "サブスク");
        if (sub) setRecCat((prev: string) => prev || sub.id);
      }),
      cachedFetch<{ presets?: Preset[] }>("/api/presets", (d) => setPresets(d.presets ?? [])),
    ]).catch(() => {
      /* 初回読み込み失敗時はスケルトンのまま */
    });
  }, []);

  // --- プラン（プレミアム課金） ---
  const [plan, setPlan] = useState<PlanName>("free");
  const [planBusy, setPlanBusy] = useState(false);
  const [planNotice, setPlanNotice] = useState("");
  // 購入導線の環境判定：Web＝案内のみ / native＝準備中（RevenueCatキー未設定） / ready＝購入可能。
  // SSR中は "web" 固定・クライアントで実環境を読む（ハイドレーション不一致を避ける）
  const purchaseEnv = useSyncExternalStore<"web" | "native" | "ready">(
    () => () => {},
    () => (isPurchasesAvailable() ? "ready" : isNativePlatform() ? "native" : "web"),
    () => "web",
  );

  useEffect(() => {
    load();
    cachedFetch<{
      savingsGoal?: number;
      apiToken?: string;
      plan?: string;
      aiUsage?: {
        scans: { used: number; limit: number | null };
        parses: { used: number; limit: number | null };
      };
    }>("/api/profile", (d) => {
      setGoal(d.savingsGoal ? String(d.savingsGoal) : "");
      setApiToken(d.apiToken ?? "");
      setPlan(planOf(d.plan));
      setAiUsage(d.aiUsage ?? null);
    }).catch(() => {});
  }, [load]);

  async function syncPlan(active: boolean): Promise<PlanName> {
    const res = await apiCall<{ plan?: string }>("/api/purchases/sync", apiJson({ active }));
    clearApiCache(); // プロフィール等のキャッシュを新プランで引き直す
    setPlan(planOf(res.plan));
    return planOf(res.plan);
  }

  async function buyPremium() {
    setPlanBusy(true);
    setPlanNotice("");
    setPageError("");
    try {
      const r = await purchasePremium(); // Appleの購入シートが開く
      if (r.status === "cancelled") return;
      await syncPlan(r.active);
      setPlanNotice(
        r.active
          ? "プレミアムにアップグレードしました。ありがとうございます！"
          : "購入を確認できませんでした。反映されない場合は「購入の復元」をお試しください。",
      );
    } catch (e) {
      setPageError(e instanceof Error ? e.message : "購入に失敗しました。");
    } finally {
      setPlanBusy(false);
    }
  }

  async function restorePurchase() {
    setPlanBusy(true);
    setPlanNotice("");
    setPageError("");
    try {
      const r = await restorePremium();
      await syncPlan(r.active);
      setPlanNotice(
        r.active ? "購入を復元しました。" : "復元できる購入が見つかりませんでした。",
      );
    } catch (e) {
      setPageError(e instanceof Error ? e.message : "復元に失敗しました。");
    } finally {
      setPlanBusy(false);
    }
  }

  async function saveGoal() {
    await tryApi(async () => {
      await apiCall("/api/profile", apiJson({ savingsGoal: Number(goal) || 0 }));
      setGoalSaved(true);
      setTimeout(() => setGoalSaved(false), 2500);
    });
  }

  // --- バイト先 ---
  const [jobName, setJobName] = useState("");
  const [wdRate, setWdRate] = useState("");
  const [weRate, setWeRate] = useState("");
  const [closing, setClosing] = useState("31");
  const [payOffset, setPayOffset] = useState("1");
  const [payDay, setPayDay] = useState("15");
  async function addJob() {
    if (!jobName || !wdRate) return;
    await tryApi(async () => {
      await apiCall(
        "/api/jobs",
        apiJson({
          name: jobName,
          weekdayRate: Number(wdRate),
          weekendHolidayRate: Number(weRate || wdRate),
          closingDay: Number(closing) || 31,
          payMonthOffset: payOffset === "same" ? 0 : Number(payOffset),
          payDay: Number(payDay),
          paySameDay: payOffset === "same",
        }),
      );
      setJobName("");
      setWdRate("");
      setWeRate("");
      load();
    });
  }

  // --- 定期 ---
  const thisMonth = new Date().toISOString().slice(0, 7);
  const [recKind, setRecKind] = useState<"expense" | "income">("expense");
  const [recName, setRecName] = useState("");
  const [recAmount, setRecAmount] = useState("");
  const [recCat, setRecCat] = useState("");
  const [recDay, setRecDay] = useState("1");
  const [recInterval, setRecInterval] = useState<"monthly" | "yearly">("monthly");
  const [recMonth, setRecMonth] = useState(thisMonth); // 年払いの「毎年◯月」＝開始月
  async function addRecurring() {
    if (!recName || !recAmount) return;
    await tryApi(async () => {
      await apiCall(
        "/api/recurring",
        apiJson({
          kind: recKind,
          name: recName,
          amount: Number(recAmount),
          categoryId: recKind === "expense" ? recCat || null : null,
          postDay: Number(recDay),
          interval: recInterval,
          ...(recInterval === "yearly" ? { startMonth: recMonth } : {}),
        }),
      );
      setRecName("");
      setRecAmount("");
      load();
    });
  }

  // --- 分割払い（総額と回数から月々を自動計算して定期支出化） ---
  const [spName, setSpName] = useState("");
  const [spTotal, setSpTotal] = useState("");
  const [spCount, setSpCount] = useState("3");
  const [spStart, setSpStart] = useState(thisMonth);
  const [spDay, setSpDay] = useState("27");
  const spMonthly =
    Number(spTotal) > 0 && Number(spCount) > 0 ? Math.round(Number(spTotal) / Number(spCount)) : 0;
  function addMonths(month: string, delta: number): string {
    const [y, m] = month.split("-").map(Number);
    const d = new Date(y, m - 1 + delta, 1);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
  }
  async function addSplit() {
    const n = Math.min(120, Math.max(1, Math.round(Number(spCount)) || 0));
    if (!spName || !spTotal || n < 1) return;
    await tryApi(async () => {
      await apiCall(
        "/api/recurring",
        apiJson({
          kind: "expense",
          name: `${spName}（分割${n}回）`,
          amount: spMonthly,
          categoryId: recCat || null,
          startMonth: spStart,
          endMonth: addMonths(spStart, n - 1),
          postDay: Number(spDay),
        }),
      );
      setSpName("");
      setSpTotal("");
      load();
    });
  }

  // --- かんたん入力ボタン（ホームで1タップ記録する定型支出） ---
  const [presets, setPresets] = useState<Preset[]>([]);
  const [pName, setPName] = useState("");
  const [pAmount, setPAmount] = useState("");
  const [pCat, setPCat] = useState("");
  async function addPreset() {
    if (!pName || !pAmount) return;
    await tryApi(async () => {
      await apiCall(
        "/api/presets",
        apiJson({ label: pName, amount: Number(pAmount), categoryId: pCat || null }),
      );
      setPName("");
      setPAmount("");
      load();
    });
  }

  // --- カテゴリ ---
  const [cName, setCName] = useState("");
  const [cIcon, setCIcon] = useState(DEFAULT_CATEGORY_ICON);
  async function addCategory() {
    if (!cName) return;
    await tryApi(async () => {
      await apiCall("/api/categories", apiJson({ name: cName, icon: cIcon }));
      setCName("");
      setCIcon(DEFAULT_CATEGORY_ICON);
      load();
    });
  }

  async function del(url: string) {
    await tryApi(async () => {
      await apiCall(url, { method: "DELETE" });
      load();
    });
  }

  // --- 使いすぎ通知（Web Push） ---
  const [pushOn, setPushOn] = useState(false);
  const [pushBusy, setPushBusy] = useState(false);
  useEffect(() => {
    fetch("/api/push")
      .then((r) => r.json())
      .then((d) => setPushOn(!!d.subscribed))
      .catch(() => {});
  }, []);

  function b64ToUint8(base64: string): Uint8Array<ArrayBuffer> {
    const padding = "=".repeat((4 - (base64.length % 4)) % 4);
    const raw = atob((base64 + padding).replace(/-/g, "+").replace(/_/g, "/"));
    const arr = new Uint8Array(new ArrayBuffer(raw.length));
    for (let i = 0; i < raw.length; i++) arr[i] = raw.charCodeAt(i);
    return arr;
  }

  async function togglePush() {
    setPushBusy(true);
    setPageError("");
    try {
      if (pushOn) {
        const reg = await navigator.serviceWorker.getRegistration();
        const sub = await reg?.pushManager.getSubscription();
        if (sub) await sub.unsubscribe();
        await apiCall("/api/push", apiJson({ endpoint: sub?.endpoint }, "DELETE"));
        setPushOn(false);
        return;
      }
      if (!("serviceWorker" in navigator) || !("PushManager" in window)) {
        throw new Error("この環境は通知に対応していません。iPhoneは「ホーム画面に追加」したアプリから設定してください。");
      }
      const perm = await Notification.requestPermission();
      if (perm !== "granted") throw new Error("通知が許可されませんでした。");
      const d = await fetch("/api/push").then((r) => r.json());
      const reg = await navigator.serviceWorker.register("/sw.js");
      const sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: b64ToUint8(d.publicKey),
      });
      await apiCall("/api/push", apiJson(sub.toJSON()));
      setPushOn(true);
    } catch (e) {
      setPageError(e instanceof Error ? e.message : "通知設定に失敗しました。");
    } finally {
      setPushBusy(false);
    }
  }

  async function logout() {
    await fetch("/api/auth", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "logout" }),
    });
    // 別ユーザーでログインし直しても前のデータが見えないよう、キャッシュを必ず全消し
    clearApiCache();
    location.href = "/login";
  }

  const input =
    "rounded-md border border-rule bg-paper px-3 py-2 text-base outline-none focus:border-ink";
  const addBtn =
    "dot rounded-md border border-ink px-4 py-2 text-sm active:translate-y-0.5 disabled:opacity-40";

  // --- 折りたたみ要約：閉じたままでも「何件・月いくら」が一目でわかるように ---
  const splits = recurring.filter((r) => SPLIT_RE.test(r.name));
  const regulars = recurring.filter((r) => !SPLIT_RE.test(r.name));
  const sumAmt = (arr: Recurring[]) => arr.reduce((s, r) => s + r.amount, 0);
  const regExpMonthly = sumAmt(regulars.filter((r) => r.kind === "expense" && r.interval !== "yearly"));
  const regExpYearly = sumAmt(regulars.filter((r) => r.kind === "expense" && r.interval === "yearly"));
  const regIncMonthly = sumAmt(regulars.filter((r) => r.kind === "income" && r.interval !== "yearly"));
  const regIncYearly = sumAmt(regulars.filter((r) => r.kind === "income" && r.interval === "yearly"));
  // 分割払いの残り回数（今月を含む。支払い完了なら0）
  const splitRemain = (r: Recurring) =>
    r.end_month
      ? Math.max(0, monthsBetween(thisMonth > r.start_month ? thisMonth : r.start_month, r.end_month) + 1)
      : 0;
  const splitMonthlySum = sumAmt(splits.filter((r) => splitRemain(r) > 0)); // 支払い中のみ
  const splitRemainTotal = splits.reduce((s, r) => s + r.amount * splitRemain(r), 0);
  let regSummary = `${regulars.length}件`;
  if (regExpMonthly > 0) regSummary += ` ・ 月 ${fmtYen(regExpMonthly)}`;
  if (regExpYearly > 0) regSummary += ` ＋年払い ${fmtYen(regExpYearly)}`;
  if (regIncMonthly + regIncYearly > 0)
    regSummary += ` ・ 収入 月 ${fmtYen(regIncMonthly)}${regIncYearly > 0 ? `＋年 ${fmtYen(regIncYearly)}` : ""}`;
  let splitSummary = `${splits.length}件`;
  if (splitMonthlySum > 0) splitSummary += ` ・ 月 ${fmtYen(splitMonthlySum)}`;
  if (splitRemainTotal > 0) splitSummary += ` ・ 残り ${fmtYen(splitRemainTotal)}`;

  if (!ready) return <Loading />;

  return (
    <div className="space-y-5">
      <h1 className="dot text-lg">設定</h1>
      {pageError && (
        <p className="rounded-md border border-vermilion px-3 py-2 text-sm text-vermilion">
          {pageError}
        </p>
      )}

      <section id="plan" className="zig zig-t zig-b px-4 py-4 shadow-sm">
        <div className="flex items-baseline">
          <h2 className="dot text-sm">プラン</h2>
          <span className="leader" />
          <span className="dot shrink-0 text-sm">{PLAN_LABEL[plan]}</span>
        </div>
        {/* B12: 今月のAI残量（freeは数値・残5回以下でamber、premium/founderは無制限） */}
        {aiUsage &&
          (plan === "free" ? (
            <ul className="mt-2 space-y-1 text-sm">
              {(
                [
                  ["今月のAI読み取り", aiUsage.scans],
                  ["文章入力", aiUsage.parses],
                ] as const
              ).map(([label, u]) => {
                const remaining = u.limit !== null ? Math.max(0, u.limit - u.used) : null;
                return (
                  <li key={label} className="flex items-baseline">
                    <span className="text-ink-faint">{label}</span>
                    <span className="leader" />
                    <span
                      className={`dot tabular-nums ${
                        remaining !== null && remaining <= 5 ? "text-caution" : ""
                      }`}
                    >
                      {u.used}/{u.limit}回
                    </span>
                  </li>
                );
              })}
              <li className="text-[11px] text-ink-faint">毎月1日にリセットされます</li>
            </ul>
          ) : (
            <p className="mt-2 text-sm">
              今月のAI読み取り・文章入力 <span className="dot">無制限</span>
            </p>
          ))}
        {plan === "free" && (
          <>
            <p className="mt-1.5 text-[11px] leading-relaxed text-ink-faint">
              プレミアム（¥480/月）にすると：広告なし・AI読取が高精度（Sonnet）・回数無制限
              <span className="block">※フェアユース：レシート読み取りは月200回まで</span>
            </p>
            {purchaseEnv === "ready" ? (
              <>
                <button
                  onClick={buyPremium}
                  disabled={planBusy}
                  className="dot mt-2 w-full rounded-md border border-ink py-2.5 text-sm active:translate-y-0.5 disabled:opacity-50"
                >
                  {planBusy ? "・・・" : "プレミアムにアップグレード ¥480/月"}
                </button>
                <button
                  onClick={restorePurchase}
                  disabled={planBusy}
                  className="mt-2 w-full rounded-md border border-rule py-2 text-xs text-ink-faint disabled:opacity-50"
                >
                  購入の復元（機種変更でプレミアムが外れたとき）
                </button>
                <p className="mt-1.5 text-[10px] leading-relaxed text-ink-faint">
                  自動更新サブスクリプション（App内課金）。解約はいつでも iPhone の「設定 →
                  Apple ID → サブスクリプション」からできます。
                </p>
              </>
            ) : (
              <p className="mt-2 rounded-md border border-rule px-3 py-2 text-xs text-ink-faint">
                {purchaseEnv === "native"
                  ? "プレミアムの購入は現在準備中です。もうしばらくお待ちください。"
                  : "プレミアムはiOSアプリから購入できます。"}
              </p>
            )}
          </>
        )}
        {plan === "premium" && (
          <p className="mt-1.5 text-[11px] leading-relaxed text-ink-faint">
            プレミアムをご利用中です（広告なし・AI読取が高精度・回数無制限
            ※フェアユース：レシート読み取りは月200回）。解約・変更は iPhone の「設定 → Apple
            ID → サブスクリプション」からできます。
          </p>
        )}
        {plan === "founder" && (
          <p className="mt-1.5 text-[11px] leading-relaxed text-ink-faint">
            初期ユーザー特典（ファウンダー）で、広告なし・高精度AI読取・回数無制限をずっと無料で使えます。
          </p>
        )}
        {planNotice && <p className="mt-2 text-xs text-sage">{planNotice}</p>}
      </section>

      <section id="goal" className="zig zig-t zig-b px-4 py-4 shadow-sm">
        <h2 className="dot text-sm">毎月の貯金目標（先取り貯金）</h2>
        <p className="mt-0.5 text-[11px] text-ink-faint">
          目標額を収入から先に差し引いて「今日使えるお金」を計算します。残りだけ使えば自動的に貯まる方式です。
        </p>
        <div className="mt-3 flex gap-2">
          <input
            type="number"
            inputMode="numeric"
            value={goal}
            onChange={(e) => setGoal(e.target.value)}
            placeholder="例：10000"
            className={`${input} flex-1 min-w-0 tabular-nums`}
          />
          <button onClick={saveGoal} className={addBtn}>
            {goalSaved ? "保存済✓" : "保存"}
          </button>
        </div>
      </section>

      <section id="jobs" className="zig zig-t zig-b px-4 py-4 shadow-sm">
        <div className="flex items-center justify-between">
          <h2 className="dot text-sm">バイト先と時給</h2>
          <Link href="/shifts" className="text-[11px] text-ink-faint underline underline-offset-2">
            シフト入力へ
          </Link>
        </div>
        <Fold summary={`${jobs.length}件`}>
        <ul className="space-y-1.5">
          {jobs.length === 0 && <li className="text-[11px] text-ink-faint">まだ登録がありません</li>}
          {jobs.map((j) =>
            jobConfirmId === j.id ? (
              /* B7: 削除前にシフトも一緒に消えることを明示して確認する */
              <li key={j.id} className="flex items-center gap-2 rounded-md border border-vermilion bg-paper px-2 py-2">
                <span className="min-w-0 flex-1 text-xs leading-snug">
                  「{j.name}」を削除しますか？
                  {j.shift_count > 0 && (
                    <span className="block text-vermilion">
                      入力済みのシフト{j.shift_count}件も削除されます
                    </span>
                  )}
                </span>
                <button
                  onClick={() => {
                    setJobConfirmId(null);
                    del(`/api/jobs?id=${j.id}`);
                  }}
                  className="dot shrink-0 rounded border border-vermilion px-2 py-1 text-xs text-vermilion"
                >
                  削除する
                </button>
                <button
                  onClick={() => setJobConfirmId(null)}
                  className="shrink-0 rounded border border-rule px-2 py-1 text-xs text-ink-faint"
                >
                  やめる
                </button>
              </li>
            ) : (
              <li key={j.id}>
                <div className="flex items-baseline text-sm">
                  <span
                    className="mr-1.5 inline-block h-2.5 w-2.5 shrink-0 self-center rounded-full"
                    style={{ backgroundColor: j.color || "var(--vermilion)" }}
                  />
                  <span className="min-w-0 truncate">{j.name}</span>
                  <span className="leader" />
                  <span className="dot shrink-0 tabular-nums">
                    平日{fmtYen(j.weekday_rate)} / 土日祝{fmtYen(j.weekend_holiday_rate)}
                  </span>
                  <button
                    onClick={() => setEditJob(j)}
                    className="ml-2 shrink-0 text-xs text-ink-faint underline underline-offset-2"
                  >
                    編集
                  </button>
                  <button onClick={() => setJobConfirmId(j.id)} className="ml-2 shrink-0 text-xs text-vermilion">
                    ✕
                  </button>
                </div>
                <p className="ml-4 text-[11px] text-ink-faint">
                  {j.pay_same_day
                    ? "当日払い（働いた日にその場で支給）"
                    : `${j.closing_day >= 28 ? "末日" : `${j.closing_day}日`}締め・${j.pay_month_offset ? "翌月" : "当月"}${j.pay_day >= 28 ? "末日" : `${j.pay_day}日`}払い`}
                </p>
              </li>
            ),
          )}
        </ul>
        </Fold>
        <div className="mt-3 grid grid-cols-2 gap-2">
          <input value={jobName} onChange={(e) => setJobName(e.target.value)} placeholder="バイト先名" className={`${input} col-span-2`} />
          <input type="number" inputMode="numeric" value={wdRate} onChange={(e) => setWdRate(e.target.value)} placeholder="平日時給" className={input} />
          <input type="number" inputMode="numeric" value={weRate} onChange={(e) => setWeRate(e.target.value)} placeholder="土日祝時給" className={input} />
          <select value={closing} onChange={(e) => setClosing(e.target.value)} className={input} title="給料1回分の勤務の区切り">
            <option value="31">末日締め</option>
            <option value="10">10日締め</option>
            <option value="15">15日締め</option>
            <option value="20">20日締め</option>
            <option value="25">25日締め</option>
          </select>
          <select value={payOffset} onChange={(e) => setPayOffset(e.target.value)} className={input}>
            <option value="0">当月払い</option>
            <option value="1">翌月払い</option>
            <option value="same">当日払い</option>
          </select>
          {payOffset !== "same" && (
            <select value={payDay} onChange={(e) => setPayDay(e.target.value)} className={`${input} col-span-2`}>
              <option value="10">支払日：10日</option>
              <option value="15">支払日：15日</option>
              <option value="20">支払日：20日</option>
              <option value="25">支払日：25日</option>
              <option value="31">支払日：末日</option>
            </select>
          )}
        </div>
        <button onClick={addJob} disabled={!jobName || !wdRate} className={`${addBtn} mt-2 w-full`}>
          ＋ 追加
        </button>
        <p className="mt-1 text-[11px] text-ink-faint">
          土日祝の時給が同じなら空欄でOK。祝日は自動判定します。締め日・支払月を設定すると「今月の収入」が実際の給料日ベースで計算されます。
        </p>
      </section>

      <section id="recurring" className="zig zig-t zig-b px-4 py-4 shadow-sm">
        <h2 className="dot text-sm">定期支出・収入</h2>
        <p className="mt-0.5 text-[11px] text-ink-faint">家賃・サブスク・仕送りなど。指定日に自動で記録されます（月払い／年払い）。</p>
        <Fold summary={regSummary}>
          {regulars.length === 0 ? (
            <p className="text-[11px] text-ink-faint">まだ登録がありません</p>
          ) : (
            <ul className="space-y-1">
              {regulars.map((r) => (
                <li key={r.id}>
                  <div className="flex items-baseline text-sm">
                    <span className="flex min-w-0 items-center gap-1 truncate">
                      {r.kind === "income" ? (
                        <CoinIcon className="h-4 w-4 shrink-0 text-sage" />
                      ) : (
                        <CategoryIcon icon="subscription" className="h-4 w-4 shrink-0 text-ink-faint" />
                      )}
                      <span className="min-w-0 truncate">{r.name}</span>
                    </span>
                    <span className="leader" />
                    <span className={`dot shrink-0 tabular-nums ${r.kind === "income" ? "text-sage" : ""}`}>{fmtYen(r.amount)}</span>
                    <button onClick={() => del(`/api/recurring?id=${r.id}`)} className="ml-2 shrink-0 text-xs text-vermilion">
                      ✕
                    </button>
                  </div>
                  <p className="ml-5 text-[11px] text-ink-faint">
                    {r.interval === "yearly"
                      ? `毎年${Number(r.start_month.slice(5))}月${r.post_day >= 28 ? "末日" : `${r.post_day}日`}`
                      : `毎月${r.post_day >= 28 ? "末日" : `${r.post_day}日`}`}
                    ・{fmtYen(r.amount)}
                    {r.end_month && `・${r.end_month.slice(0, 4)}年${Number(r.end_month.slice(5))}月まで`}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </Fold>
        <div className="mt-3 grid grid-cols-2 gap-2">
          <select value={recKind} onChange={(e) => setRecKind(e.target.value as "expense" | "income")} className={`${input} min-w-0`}>
            <option value="expense">支出</option>
            <option value="income">収入</option>
          </select>
          <select value={recInterval} onChange={(e) => setRecInterval(e.target.value as "monthly" | "yearly")} className={`${input} min-w-0`}>
            <option value="monthly">月払い</option>
            <option value="yearly">年払い</option>
          </select>
          <input value={recName} onChange={(e) => setRecName(e.target.value)} placeholder="例：Netflix / 家賃" className={`${input} col-span-2 min-w-0`} />
        </div>
        {recInterval === "yearly" && (
          <div className="mt-2">
            <label className="block">
              <span className="dot text-xs text-ink-faint">初回の年月（毎年この月に計上）</span>
              <input type="month" value={recMonth} onChange={(e) => setRecMonth(e.target.value)} className={`${input} mt-1 block w-full min-w-0`} />
            </label>
            <p className="mt-1 text-[11px] text-ink-faint">
              年払いは毎年{Number((recMonth || thisMonth).slice(5))}月に1回計上します（選んだ月が初回で、以後その月に毎年）。
            </p>
          </div>
        )}
        {recKind === "expense" && (
          <select value={recCat} onChange={(e) => setRecCat(e.target.value)} className={`${input} mt-2 w-full`}>
            <option value="">カテゴリなし</option>
            {categories.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        )}
        <div className="mt-2 flex gap-2">
          <input type="number" inputMode="numeric" value={recAmount} onChange={(e) => setRecAmount(e.target.value)} placeholder="金額" className={`${input} flex-1 min-w-0`} />
          <select value={recDay} onChange={(e) => setRecDay(e.target.value)} className={input}>
            {["1", "5", "10", "15", "20", "25", "27", "31"].map((d) => (
              <option key={d} value={d}>
                {d === "31" ? "末日" : `${d}日`}
              </option>
            ))}
          </select>
          <button onClick={addRecurring} disabled={!recName || !recAmount} className={addBtn}>
            ＋ 追加
          </button>
        </div>

        <div className="cutline mt-4 pt-3">
          <h3 className="dot flex items-center gap-1 text-xs">
            <CardIcon className="h-4 w-4" /> 分割払い
          </h3>
          <Fold summary={splitSummary}>
            {splits.length === 0 ? (
              <p className="text-[11px] text-ink-faint">まだ登録がありません</p>
            ) : (
              <ul className="space-y-1">
                {splits.map((r) => {
                  const rem = splitRemain(r);
                  const total = Number(r.name.match(SPLIT_RE)?.[1] ?? 0);
                  return (
                    <li key={r.id}>
                      <div className="flex items-baseline text-sm">
                        <span className="flex min-w-0 items-center gap-1 truncate">
                          <CardIcon className="h-4 w-4 shrink-0 text-ink-faint" />
                          <span className="min-w-0 truncate">{r.name.replace(SPLIT_RE, "")}</span>
                        </span>
                        <span className="leader" />
                        <span className="dot shrink-0 tabular-nums">{fmtYen(r.amount)}/月</span>
                        <button onClick={() => del(`/api/recurring?id=${r.id}`)} className="ml-2 shrink-0 text-xs text-vermilion">
                          ✕
                        </button>
                      </div>
                      <p className="ml-5 text-[11px] text-ink-faint">
                        {rem > 0
                          ? `毎月${r.post_day >= 28 ? "末日" : `${r.post_day}日`}・残り${rem}回${total > 0 ? `／全${total}回` : ""}（あと${fmtYen(r.amount * rem)}）${r.end_month ? `・${r.end_month.slice(0, 4)}年${Number(r.end_month.slice(5))}月まで` : ""}`
                          : "支払い完了（消してOK）"}
                      </p>
                    </li>
                  );
                })}
              </ul>
            )}
          </Fold>
          <p className="mt-2 text-[11px] text-ink-faint">
            総額と回数を入れると月々の支払いを自動計算して、期間ぶんだけ毎月計上します。
          </p>
          <div className="mt-2 grid grid-cols-2 gap-2">
            <input value={spName} onChange={(e) => setSpName(e.target.value)} placeholder="例：iPhone" className={`${input} col-span-2`} />
            <input type="number" inputMode="numeric" value={spTotal} onChange={(e) => setSpTotal(e.target.value)} placeholder="総額" className={input} />
            <div className={`${input} flex items-center gap-1 py-0`}>
              <input
                type="number"
                inputMode="numeric"
                min={1}
                max={120}
                value={spCount}
                onChange={(e) => setSpCount(e.target.value)}
                placeholder="回数"
                className="min-w-0 flex-1 bg-transparent py-2.5 tabular-nums outline-none"
              />
              <span className="shrink-0 text-sm text-ink-faint">回払い</span>
            </div>
            <input type="month" value={spStart} onChange={(e) => setSpStart(e.target.value)} className={`${input} w-full min-w-0`} />
            <select value={spDay} onChange={(e) => setSpDay(e.target.value)} className={input}>
              {["1", "5", "10", "15", "20", "25", "27", "31"].map((d) => (
                <option key={d} value={d}>
                  {d === "31" ? "末日" : `${d}日`}払い
                </option>
              ))}
            </select>
          </div>
          <button
            onClick={addSplit}
            disabled={!spName || !spTotal || spMonthly <= 0}
            className={`${addBtn} mt-2 w-full`}
          >
            {spMonthly > 0 ? `月々${fmtYen(spMonthly)} × ${spCount}回で追加` : "＋ 追加"}
          </button>
        </div>
      </section>

      <section id="presets" className="zig zig-t zig-b px-4 py-4 shadow-sm">
        <h2 className="dot text-sm">かんたん入力ボタン</h2>
        <p className="mt-0.5 text-[11px] text-ink-faint">
          Suicaチャージなど、レシートやスクショで撮りにくい定型支出を登録すると、ホームに1タップ記録ボタンが並びます（{MAX_PRESETS}個まで）。
        </p>
        <Fold summary={`${presets.length}件`}>
        <ul className="space-y-1.5">
          {presets.length === 0 && <li className="text-[11px] text-ink-faint">まだ登録がありません</li>}
          {presets.map((p) => (
            <li key={p.id} className="flex items-baseline text-sm">
              <CategoryIcon icon={p.icon} className="mr-1.5 h-4 w-4 shrink-0 self-center text-ink-faint" />
              <span className="min-w-0 truncate">{p.label}</span>
              {p.category && <span className="ml-1.5 shrink-0 text-[10px] text-ink-faint">{p.category}</span>}
              <span className="leader" />
              <span className="dot shrink-0 tabular-nums">{fmtYen(p.amount)}</span>
              <button
                onClick={() => setEditPreset(p)}
                className="ml-2 shrink-0 text-xs text-ink-faint underline underline-offset-2"
              >
                編集
              </button>
              <button onClick={() => del(`/api/presets?id=${p.id}`)} className="ml-2 shrink-0 text-xs text-vermilion">
                ✕
              </button>
            </li>
          ))}
        </ul>
        </Fold>
        <div className="mt-3 grid grid-cols-2 gap-2">
          <input
            value={pName}
            onChange={(e) => setPName(e.target.value)}
            placeholder="例：Suicaチャージ"
            maxLength={20}
            className={input}
          />
          <input
            type="number"
            inputMode="numeric"
            value={pAmount}
            onChange={(e) => setPAmount(e.target.value)}
            placeholder="金額"
            className={`${input} tabular-nums`}
          />
          <select value={pCat} onChange={(e) => setPCat(e.target.value)} className={`${input} col-span-2`}>
            <option value="">カテゴリなし</option>
            {categories.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </div>
        <button
          onClick={addPreset}
          disabled={!pName || !pAmount || Number(pAmount) <= 0 || presets.length >= MAX_PRESETS}
          className={`${addBtn} mt-2 w-full`}
        >
          {presets.length >= MAX_PRESETS ? `上限（${MAX_PRESETS}個）に達しています` : "＋ 追加"}
        </button>
      </section>

      <section id="categories" className="zig zig-t zig-b px-4 py-4 shadow-sm">
        <h2 className="dot text-sm">カテゴリ</h2>
        <Fold summary={`${categories.length}件`}>
          <div className="flex flex-wrap gap-1.5">
            {categories.length === 0 && <p className="text-[11px] text-ink-faint">まだ登録がありません</p>}
            {categories.map((c) => (
              <span key={c.id} className="flex items-center gap-1 rounded-full border border-rule bg-paper px-3 py-1 text-sm">
                <CategoryIcon icon={c.icon} className="h-4 w-4 text-ink-faint" /> {c.name}
                <button
                  onClick={() => setEditCategory(c)}
                  className="ml-0.5 text-[10px] text-ink-faint underline underline-offset-2"
                >
                  編集
                </button>
                <button onClick={() => del(`/api/categories?id=${c.id}`)} className="text-xs text-vermilion">
                  ✕
                </button>
              </span>
            ))}
          </div>
        </Fold>
        <div className="mt-3 space-y-2">
          <div className="flex gap-2">
            <input value={cName} onChange={(e) => setCName(e.target.value)} placeholder="カテゴリ名" className={`${input} flex-1 min-w-0`} />
            <button onClick={addCategory} disabled={!cName} className={addBtn}>
              ＋ 追加
            </button>
          </div>
          <div>
            <p className="text-[11px] text-ink-faint">アイコンを選ぶ（任意）</p>
            <div className="mt-1 grid grid-cols-8 gap-1">
              {[DEFAULT_CATEGORY_ICON, ...CATEGORY_ICON_KEYS].map((k) => (
                <button
                  key={k}
                  onClick={() => setCIcon(k)}
                  aria-label={`アイコン ${k}`}
                  className={`rounded-md border p-1.5 ${
                    cIcon === k ? "border-ink bg-card text-ink" : "border-rule bg-paper text-ink-faint"
                  }`}
                >
                  <CategoryIcon icon={k} className="mx-auto h-5 w-5" />
                </button>
              ))}
            </div>
          </div>
        </div>
      </section>

      <section id="push" className="zig zig-t zig-b px-4 py-4 shadow-sm">
        <h2 className="dot text-sm">使いすぎ予兆の通知</h2>
        <p className="mt-0.5 text-[11px] leading-relaxed text-ink-faint">
          毎晩チェックして、月末赤字ペースのときだけ「1日あと◯円おさえれば黒字」と通知します（1日1回まで）。iPhoneは「ホーム画面に追加」したアプリからONにしてください。
        </p>
        <button
          onClick={togglePush}
          disabled={pushBusy}
          className={`mt-2 w-full rounded-md py-2.5 text-sm ${
            pushOn ? "border border-sage text-sage" : "dot border border-ink"
          } disabled:opacity-50`}
        >
          {pushBusy ? "・・・" : pushOn ? "通知ON（タップでOFF）" : "通知をONにする"}
        </button>
      </section>

      <section id="shortcut" className="zig zig-t zig-b px-4 py-4 shadow-sm">
        <h2 className="dot text-sm">iPhoneショートカット連携</h2>
        <p className="mt-0.5 text-[11px] leading-relaxed text-ink-faint">
          ショートカットから「スクショ読取→記録→スクショ削除」を一気に実行するための鍵（連携キー）です。使い方は
          <Link href="/help/shortcut" className="underline underline-offset-2">
            ヘルプ
          </Link>
          を参照してください。
        </p>
        <div className="mt-2 flex gap-2">
          <input
            readOnly
            value={apiToken}
            className={`${input} min-w-0 flex-1 font-mono text-xs`}
            onFocus={(e) => e.target.select()}
          />
          <button
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(apiToken);
                setTokenCopied(true);
                setTimeout(() => setTokenCopied(false), 2000);
              } catch {
                /* http環境等ではフィールドを長押しコピー */
              }
            }}
            className={addBtn}
          >
            {tokenCopied ? "コピー済✓" : "コピー"}
          </button>
        </div>
      </section>

      <button onClick={logout} className="w-full rounded-md border border-rule py-3 text-sm text-ink-faint">
        ログアウト
      </button>
      <p className="flex justify-center gap-4 text-[11px] text-ink-faint">
        <Link href="/legal/terms" className="underline underline-offset-2">
          利用規約
        </Link>
        <Link href="/legal/privacy" className="underline underline-offset-2">
          プライバシーポリシー
        </Link>
      </p>
      <p className="dot pb-2 text-center text-[10px] text-ink-faint">CashSync v0.1</p>

      {/* B7: 編集シート（バイト先・カテゴリ・かんたん入力ボタン） */}
      {editJob && (
        <JobEditSheet
          job={editJob}
          onClose={() => setEditJob(null)}
          onSaved={() => {
            setEditJob(null);
            load();
          }}
        />
      )}
      {editCategory && (
        <CategoryEditSheet
          category={editCategory}
          onClose={() => setEditCategory(null)}
          onSaved={() => {
            setEditCategory(null);
            load();
          }}
        />
      )}
      {editPreset && (
        <PresetEditSheet
          preset={editPreset}
          categories={categories}
          onClose={() => setEditPreset(null)}
          onSaved={() => {
            setEditPreset(null);
            load();
          }}
        />
      )}
    </div>
  );
}
