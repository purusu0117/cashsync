"use client";

// カレンダー：シフトタブを統合した1画面。上から
//   1) 月ヘッダ（◀ 月 ▶）
//   2) 今日あと使えるお金の計算（お金の内訳＝breakdown）
//   3) 大きいカレンダー（日別の+収入/−支出/給料日。複数日まとめて登録モードでは日タップで選択）
//   4) シフト登録エリア（音声/文章でシフト追加・複数日まとめて・この月のシフト一覧・Googleカレンダー連携）
// 既存のお金計算（breakdown）・未来月の予定（plan）・日別シート・支出編集（ExpenseEditSheet）は維持。
// シフト系ロジックは旧 /shifts ページから移植。
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { ExpenseEditSheet } from "@/components/EditSheets";
import { CalendarIcon, CategoryIcon, MicIcon, PencilIcon } from "@/components/Icons";
import Loading from "@/components/Loading";
import { Toast, useToast } from "@/components/Toast";
import { cachedFetch } from "@/lib/cachedFetch";
import {
  DEFAULT_EXCLUDES,
  getCalendarToken,
  isAutoSyncOn,
  setAutoSync,
  syncMonth,
} from "@/lib/calendarImport";
import { apiCall, apiJson } from "@/lib/clientApi";
import { fmtDateJa, fmtMonthJa, fmtYen, hhmmToMin, minToHHMM, todayLocal } from "@/lib/format";
import { isNativePlatform } from "@/lib/native";

interface CalExpense {
  id: string;
  date: string;
  amount: number;
  memo: string;
  source: string;
  category_id?: string | null;
  receipt_id?: string | null;
  category: string | null;
  icon: string | null;
}
interface Category {
  id: string;
  name: string;
  icon: string;
}
interface CalIncome {
  id: string;
  date: string;
  amount: number;
  type: string;
  memo: string;
}
interface Payday {
  date: string;
  jobId: string;
  jobName: string;
  color: string;
  amount: number;
  periodStart: string;
  periodEnd: string;
}
interface PlannedRecurring {
  recurringId: string;
  kind: "expense" | "income";
  date: string;
  name: string;
  amount: number;
  category: string | null;
  icon: string | null;
}
interface PlannedPayday {
  date: string;
  jobId: string;
  jobName: string;
  color: string;
  amount: number; // 0 = シフト未入力で金額未定
  periodStart: string;
  periodEnd: string;
  confirmed: boolean;
}
interface MonthPlan {
  expenses: PlannedRecurring[];
  incomes: PlannedRecurring[];
  paydays: PlannedPayday[];
  expenseTotal: number;
  incomeTotal: number;
}
interface CalData {
  month: string;
  expenses: CalExpense[];
  incomes: CalIncome[];
  paydays: Payday[];
  plan?: MonthPlan; // 未来月のみ中身が入る（旧キャッシュには無いので optional）
  breakdown: {
    planned?: boolean; // true=未来月（予定込みの1系統で表示。実績行は出さない）
    // B9: 集計期間（締め日基準。開始日1なら実カレンダー月と同じ。旧キャッシュには無いので optional）
    range?: { start: string; end: string };
    shiftIncome: number;
    otherIncome: number;
    incomeTotal: number; // 未来月は予定収入込み
    savingsGoal: number;
    expenseTotal: number; // 未来月は予定支出込み
    fixedTotal?: number | null; // 今月の固定費（先取り済み。今月のみ）
    remain: number;
    daysRemaining: number | null;
    // 日次予算＋繰り越し方式の内訳（今月のみ。旧キャッシュには無いので optional）
    todayBudget?: number | null;
    spentToday?: number | null;
    spentBeforeToday?: number | null;
    allowance: number | null; // 今日あと使える額（今日の予算 − 今日の変動支出）
  };
}

// --- シフト（旧 /shifts から移植） ---
interface Shift {
  id: string;
  job_id: string;
  date: string;
  start_min: number;
  end_min: number;
  break_min: number;
  source: string;
  job_name: string | null;
  job_color: string | null;
  pay: number;
}
interface Job {
  id: string;
  name: string;
  weekday_rate: number;
  weekend_holiday_rate: number;
  transport_per_shift: number;
  calendar_keywords: string;
  calendar_exclude: string;
  color: string;
}
interface Income {
  total: number;
  weekdayHours: number;
  weekendHolidayHours: number;
  shiftCount: number;
}
interface ParsedShift {
  date: string;
  startMin: number;
  endMin: number;
  jobId: string | null; // AIが聞き分けたバイト先（不明なら選択中のバイト先）
}

interface SpeechResult {
  isFinal: boolean;
  0: { transcript: string };
}
interface SpeechResultEvent {
  resultIndex: number;
  results: { length: number; [i: number]: SpeechResult };
}
interface SpeechRecognitionLike {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onresult: ((e: SpeechResultEvent) => void) | null;
  onend: (() => void) | null;
  onerror: (() => void) | null;
  start: () => void;
  stop: () => void;
}

function shiftMonth(month: string, delta: number): string {
  const [y, m] = month.split("-").map(Number);
  const d = new Date(y, m - 1 + delta, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

function splitWords(v: string): string[] {
  return v.split(/[,、\s]+/).filter(Boolean);
}

export default function CalendarPage() {
  const [month, setMonth] = useState(todayLocal().slice(0, 7));
  const [data, setData] = useState<CalData | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [showCalc, setShowCalc] = useState(false);
  // C10: 日付シートの支出行タップ→履歴と同じ編集シートを開く
  const [categories, setCategories] = useState<Category[]>([]);
  const [editing, setEditing] = useState<CalExpense | null>(null);
  const { toast, show, hide } = useToast();

  // --- シフト系 state（旧 /shifts から移植） ---
  const [shifts, setShifts] = useState<Shift[]>([]);
  const [income, setIncome] = useState<Income | null>(null);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [jobsLoaded, setJobsLoaded] = useState(false);
  const [jobId, setJobId] = useState("");

  // 日別シートからの単発シフト追加（既存の「＋この日にシフトを追加」を維持）
  const [showShiftAdd, setShowShiftAdd] = useState(false);
  const [shiftStart, setShiftStart] = useState("17:00");
  const [shiftEnd, setShiftEnd] = useState("22:00");
  const [shiftBreak, setShiftBreak] = useState("0");
  const [shiftBusy, setShiftBusy] = useState(false);

  // 既存シフトの編集フォーム（一覧・日別シートから開く）
  const [editDate, setEditDate] = useState<string | null>(null);
  const [editShiftId, setEditShiftId] = useState<string | null>(null);
  const [eStart, setEStart] = useState("18:00");
  const [eEnd, setEEnd] = useState("22:30");
  const [eBrk, setEBrk] = useState("0");
  const [editBusy, setEditBusy] = useState(false);

  // 複数日まとめて登録モード
  const [multiMode, setMultiMode] = useState(false);
  const [multiDates, setMultiDates] = useState<Set<string>>(new Set());
  const [msStart, setMsStart] = useState("18:00");
  const [msEnd, setMsEnd] = useState("22:30");
  const [msBrk, setMsBrk] = useState("0");
  const [multiBusy, setMultiBusy] = useState(false);

  // カレンダー連携設定シート
  const [linkOpen, setLinkOpen] = useState(false);
  const [linkKeywords, setLinkKeywords] = useState("");
  const [linkExcludes, setLinkExcludes] = useState(DEFAULT_EXCLUDES.join(", "));
  const [linkBusy, setLinkBusy] = useState(false);
  const [linkError, setLinkError] = useState("");
  const [autoOn, setAutoOn] = useState(false);

  // 音声/文章シフト入力（音声が主役：話す→自動解析→1タップ登録）
  const [text, setText] = useState("");
  const [parsing, setParsing] = useState(false);
  const [parsed, setParsed] = useState<ParsedShift[] | null>(null);
  const [listening, setListening] = useState(false);
  const [speechOk, setSpeechOk] = useState(false);
  const [isIOS, setIsIOS] = useState(false);
  const [showTextInput, setShowTextInput] = useState(false);
  const recRef = useRef<SpeechRecognitionLike | null>(null);
  const syncedRef = useRef<Set<string>>(new Set());

  // 月切替の連打時に古い月のレスポンスで上書きされないよう、最新リクエストだけ反映する
  const reqRef = useRef(0);
  const loadCal = useCallback(async (m: string) => {
    const req = ++reqRef.current;
    try {
      // キャッシュファースト：見たことのある月は即表示→裏で最新に差し替え
      await cachedFetch<CalData>(`/api/calendar?month=${m}`, (d) => {
        if (reqRef.current === req) setData(d);
      });
    } catch {
      /* 初回読み込み失敗時はスケルトンのまま（復帰時の visibilitychange で再試行される） */
    }
  }, []);

  const shiftReqRef = useRef(0);
  const loadShifts = useCallback(async (m: string) => {
    const req = ++shiftReqRef.current;
    await cachedFetch<{ shifts?: Shift[]; income?: Income | null }>(
      `/api/shifts?month=${m}`,
      (d) => {
        if (shiftReqRef.current !== req) return;
        setShifts(d.shifts ?? []);
        setIncome(d.income ?? null);
      },
    ).catch(() => {});
  }, []);

  // シフトを足すと給料日（payday）・お金の内訳も変わるので、両方まとめて更新する
  const reload = useCallback(
    (m: string) => {
      loadCal(m);
      loadShifts(m);
    },
    [loadCal, loadShifts],
  );

  const loadJobs = useCallback(async () => {
    let list: Job[] = [];
    await cachedFetch<{ jobs?: Job[] }>("/api/jobs", (d) => {
      list = d.jobs ?? [];
      setJobs(list);
      if (list[0]) setJobId((prev) => prev || list[0].id);
      setJobsLoaded(true);
    }).catch(() => {});
    return list;
  }, []);

  // 自動同期：ページを開いたとき・月を切り替えたときに、その月＋翌月を裏で差分同期
  const autoSync = useCallback(
    async (m: string, jobList: Job[]) => {
      if (!isAutoSyncOn()) return;
      const job = jobList.find((j) => j.calendar_keywords.trim());
      if (!job) return;
      const months = [...new Set([m, shiftMonth(todayLocal().slice(0, 7), 1)])];
      const key = months.join("|");
      if (syncedRef.current.has(key)) return; // 同一表示中の重複同期を防ぐ
      syncedRef.current.add(key);
      try {
        const token = await getCalendarToken();
        let added = 0;
        let updated = 0;
        let removed = 0;
        for (const mm of months) {
          const r = await syncMonth(
            token,
            job.id,
            mm,
            splitWords(job.calendar_keywords),
            splitWords(job.calendar_exclude || DEFAULT_EXCLUDES.join(",")),
          );
          added += r.added;
          updated += r.updated;
          removed += r.removed;
        }
        if (added + updated + removed > 0) {
          show(`カレンダー同期: 追加${added}・変更${updated}・削除${removed}`);
          reload(m);
        }
      } catch {
        // サイレント失敗（トークン切れ等）。連携設定シートから再認証できる。
        syncedRef.current.delete(key);
      }
    },
    [reload, show],
  );

  useEffect(() => {
    cachedFetch<{ categories?: Category[] }>("/api/categories", (d) =>
      setCategories(d.categories ?? []),
    ).catch(() => {});
    setAutoOn(isAutoSyncOn());
    const w = window as unknown as {
      SpeechRecognition?: new () => SpeechRecognitionLike;
      webkitSpeechRecognition?: new () => SpeechRecognitionLike;
    };
    setSpeechOk(!!(w.SpeechRecognition || w.webkitSpeechRecognition));
    // ネイティブアプリではショートカット導線を出さない（Web/PWA版のiOSのみ）
    setIsIOS(/iPad|iPhone|iPod/.test(navigator.userAgent) && !isNativePlatform());
  }, []);

  useEffect(() => {
    loadCal(month);
    loadShifts(month);
    loadJobs().then((list) => autoSync(month, list));
    const onVisible = () => {
      if (document.visibilityState === "visible") {
        loadCal(month);
        loadShifts(month);
      }
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [month, loadCal, loadShifts, loadJobs, autoSync]);

  // --- シフト操作（旧 /shifts から移植） ---
  // 同日掛け持ち対応：1日に複数シフトを持てる
  const byDate = new Map<string, Shift[]>();
  for (const s of shifts) {
    const arr = byDate.get(s.date) ?? [];
    arr.push(s);
    byDate.set(s.date, arr);
  }

  // 日別シートの単発追加（既存の挙動を維持）
  async function addShift() {
    if (!jobId || !selected || shiftBusy) return;
    setShiftBusy(true);
    try {
      await apiCall(
        "/api/shifts",
        apiJson({
          jobId,
          date: selected,
          startMin: hhmmToMin(shiftStart),
          endMin: hhmmToMin(shiftEnd),
          breakMin: Number(shiftBreak) || 0,
          // source は既定の "manual"。"calendar" にすると Google カレンダー自動同期の
          // 差分削除対象になり、手動追加したシフトが次回同期で消える（QA指摘の退行修正）
        }),
      );
      setShowShiftAdd(false);
      reload(month);
      show("シフトを追加しました（給料は給料日に反映）");
    } catch (e) {
      show(e instanceof Error ? e.message : "追加に失敗しました。");
    } finally {
      setShiftBusy(false);
    }
  }

  async function saveMulti() {
    if (!jobId || multiDates.size === 0) return;
    setMultiBusy(true);
    try {
      let added = 0;
      let skipped = 0;
      for (const date of [...multiDates].sort()) {
        if ((byDate.get(date) ?? []).some((x) => x.job_id === jobId)) {
          skipped++;
          continue; // 同じバイト先のシフトが既にある日はスキップ（別バイトの掛け持ちはOK）
        }
        await apiCall(
          "/api/shifts",
          apiJson({
            jobId,
            date,
            startMin: hhmmToMin(msStart),
            endMin: hhmmToMin(msEnd),
            breakMin: Number(msBrk) || 0,
          }),
        );
        added++;
      }
      show(`${added}日ぶん登録しました${skipped > 0 ? `（${skipped}日は登録済みのためスキップ）` : ""}`);
      setMultiMode(false);
      setMultiDates(new Set());
      reload(month);
    } catch (e) {
      show(e instanceof Error ? e.message : "登録に失敗しました。");
    } finally {
      setMultiBusy(false);
    }
  }

  function openEditor(date: string, shift: Shift | null) {
    if (shift) {
      setJobId(shift.job_id);
      setEStart(minToHHMM(shift.start_min));
      setEEnd(minToHHMM(shift.end_min));
      setEBrk(String(shift.break_min));
      setEditShiftId(shift.id);
    } else {
      if (shifts.length > 0) {
        // 前回の時間帯を初期値に（入力摩擦の削減）
        const last = shifts[shifts.length - 1];
        setEStart(minToHHMM(last.start_min));
        setEEnd(minToHHMM(last.end_min));
        setEBrk(String(last.break_min));
      }
      setEditShiftId(null);
    }
    setSelected(null);
    setEditDate(date);
  }

  // カレンダーの日タップ：通常は日別シート、複数日モードでは選択のトグル
  function openDay(date: string) {
    if (multiMode) {
      const next = new Set(multiDates);
      if (next.has(date)) next.delete(date);
      else next.add(date);
      setMultiDates(next);
      return;
    }
    setSelected(date);
  }

  async function saveShift() {
    if (!editDate || !jobId) return;
    setEditBusy(true);
    try {
      // 新規登録を先に検証してから旧シフトを消す（登録失敗でシフトが消えるのを防ぐ）
      await apiCall(
        "/api/shifts",
        apiJson({
          jobId,
          date: editDate,
          startMin: hhmmToMin(eStart),
          endMin: hhmmToMin(eEnd),
          breakMin: Number(eBrk) || 0,
        }),
      );
      if (editShiftId) await apiCall(`/api/shifts?id=${editShiftId}`, { method: "DELETE" });
      setEditDate(null);
      setEditShiftId(null);
      reload(month);
    } catch (e) {
      show(e instanceof Error ? e.message : "保存に失敗しました。");
    } finally {
      setEditBusy(false);
    }
  }

  async function removeShift() {
    if (!editDate) return;
    try {
      if (editShiftId) {
        setEditBusy(true);
        await apiCall(`/api/shifts?id=${editShiftId}`, { method: "DELETE" });
      }
      setEditDate(null);
      setEditShiftId(null);
      reload(month);
    } catch (e) {
      show(e instanceof Error ? e.message : "削除に失敗しました。");
    } finally {
      setEditBusy(false);
    }
  }

  async function removeById(id: string) {
    try {
      await apiCall(`/api/shifts?id=${id}`, { method: "DELETE" });
      reload(month);
    } catch (e) {
      show(e instanceof Error ? e.message : "削除に失敗しました。");
    }
  }

  // --- カレンダー連携 ---
  function openLink() {
    const job = jobs.find((j) => j.id === jobId) ?? jobs[0];
    setLinkKeywords(job?.calendar_keywords || job?.name || "");
    setLinkExcludes(job?.calendar_exclude || DEFAULT_EXCLUDES.join(", "));
    setLinkError("");
    setLinkOpen(true);
  }

  async function startLink() {
    const job = jobs.find((j) => j.id === jobId) ?? jobs[0];
    if (!job) return;
    setLinkBusy(true);
    setLinkError("");
    try {
      // 設定をバイト先に保存
      await fetch("/api/jobs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: job.id,
          name: job.name,
          weekdayRate: job.weekday_rate,
          weekendHolidayRate: job.weekend_holiday_rate,
          transportPerShift: job.transport_per_shift,
          calendarKeywords: linkKeywords.trim(),
          calendarExclude: linkExcludes.trim(),
        }),
      });
      const token = await getCalendarToken();
      const months = [...new Set([month, shiftMonth(todayLocal().slice(0, 7), 1)])];
      let added = 0;
      let updated = 0;
      let removed = 0;
      for (const mm of months) {
        const r = await syncMonth(token, job.id, mm, splitWords(linkKeywords), splitWords(linkExcludes));
        added += r.added;
        updated += r.updated;
        removed += r.removed;
      }
      setAutoSync(true);
      setAutoOn(true);
      syncedRef.current.clear();
      setLinkOpen(false);
      show(`連携ON: 追加${added}・変更${updated}・削除${removed}。今後は開くたびに自動同期します`);
      reload(month);
      loadJobs();
    } catch (e) {
      setLinkError(e instanceof Error ? e.message : "同期に失敗しました。");
    } finally {
      setLinkBusy(false);
    }
  }

  function stopLink() {
    setAutoSync(false);
    setAutoOn(false);
    setLinkOpen(false);
    show("自動同期をOFFにしました（取り込み済みシフトは残ります）");
  }

  // --- 音声/文章入力 ---
  // 録音は「自分でタップして止めるまで」続ける（無音でOSが勝手に切っても自動で録音を再開）。
  // 止めた時点の全文をまとめてAI解析に渡す。
  const finalTextRef = useRef("");
  const stopRequestedRef = useRef(false);
  const [liveText, setLiveText] = useState("");

  function toggleVoice() {
    const w = window as unknown as {
      SpeechRecognition?: new () => SpeechRecognitionLike;
      webkitSpeechRecognition?: new () => SpeechRecognitionLike;
    };
    const Ctor = w.SpeechRecognition || w.webkitSpeechRecognition;
    if (!Ctor) {
      setShowTextInput(true);
      return;
    }
    if (listening) {
      // 手動ストップ → onend で確定・解析
      stopRequestedRef.current = true;
      recRef.current?.stop();
      return;
    }
    const rec = new Ctor();
    rec.lang = "ja-JP";
    rec.continuous = true;
    rec.interimResults = true;
    finalTextRef.current = "";
    stopRequestedRef.current = false;
    setLiveText("");
    rec.onresult = (e) => {
      let interim = "";
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i];
        if (r.isFinal) finalTextRef.current += r[0].transcript;
        else interim += r[0].transcript;
      }
      setLiveText(finalTextRef.current + interim);
    };
    rec.onend = () => {
      if (!stopRequestedRef.current) {
        // 無音などでOSに切られた → ユーザーが止めるまで録音を続ける
        try {
          rec.start();
          return;
        } catch {
          /* 再開できなければ確定へ */
        }
      }
      setListening(false);
      const t = finalTextRef.current.trim();
      setLiveText("");
      if (t) {
        setText(t);
        parseShiftText(t);
      }
    };
    rec.onerror = () => {
      /* onendが必ず来るのでそちらで処理 */
    };
    recRef.current = rec;
    setListening(true);
    rec.start();
  }

  async function parseShiftText(input?: string) {
    const t = (input ?? text).trim();
    if (!t) return;
    setParsing(true);
    setParsed(null);
    try {
      const res = await fetch("/api/parse-shift", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: t }),
      });
      const d = await res.json();
      // error:'limit'（無料枠超過）のときは message に日本語の案内が入る
      if (!res.ok) throw new Error(d.message ?? d.error ?? "解析に失敗しました。");
      // バイト先を言っていないシフトは、選択中（なければ先頭）のバイト先に倒す
      const fallback = jobId || d.defaultJobId || null;
      setParsed((d.shifts as ParsedShift[]).map((s) => ({ ...s, jobId: s.jobId ?? fallback })));
    } catch (e) {
      show(e instanceof Error ? e.message : "解析に失敗しました。");
    } finally {
      setParsing(false);
    }
  }

  async function saveParsed() {
    if (!parsed || !jobId) return;
    setParsing(true);
    try {
      for (const s of parsed) {
        const jid = s.jobId ?? jobId; // AIが聞き分けたバイト先（言っていなければ選択中）
        // 同じバイト先の既存シフトだけ置き換える（別バイトの掛け持ちは残す）
        const olds = (byDate.get(s.date) ?? []).filter((x) => x.job_id === jid);
        await apiCall(
          "/api/shifts",
          apiJson({ jobId: jid, date: s.date, startMin: s.startMin, endMin: s.endMin, breakMin: 0 }),
        );
        for (const ex of olds) await apiCall(`/api/shifts?id=${ex.id}`, { method: "DELETE" });
      }
      setParsed(null);
      setText("");
      show(`${parsed.length}件のシフトを登録しました`);
      reload(month);
    } catch (e) {
      show(e instanceof Error ? e.message : "登録に失敗しました。");
    } finally {
      setParsing(false);
    }
  }

  if (!data) return <Loading />;

  const [y, m] = month.split("-").map(Number);
  const first = new Date(y, m - 1, 1);
  const days = new Date(y, m, 0).getDate();
  const cells: (string | null)[] = [
    ...Array<null>(first.getDay()).fill(null),
    ...Array.from({ length: days }, (_, i) => `${month}-${String(i + 1).padStart(2, "0")}`),
  ];
  const expByDate = new Map<string, CalExpense[]>();
  for (const e of data.expenses) {
    const a = expByDate.get(e.date) ?? [];
    a.push(e);
    expByDate.set(e.date, a);
  }
  const incByDate = new Map<string, CalIncome[]>();
  for (const i of data.incomes) {
    const a = incByDate.get(i.date) ?? [];
    a.push(i);
    incByDate.set(i.date, a);
  }
  const pdByDate = new Map<string, Payday[]>();
  for (const p of data.paydays) {
    const a = pdByDate.get(p.date) ?? [];
    a.push(p);
    pdByDate.set(p.date, a);
  }
  // 未来月の「予定」（定期・分割・給料日）。実記録と別マップにして薄い表示で区別する
  const plan = data.plan;
  const planExpByDate = new Map<string, PlannedRecurring[]>();
  const planIncByDate = new Map<string, PlannedRecurring[]>();
  const planPdByDate = new Map<string, PlannedPayday[]>();
  for (const e of plan?.expenses ?? []) {
    const a = planExpByDate.get(e.date) ?? [];
    a.push(e);
    planExpByDate.set(e.date, a);
  }
  for (const i of plan?.incomes ?? []) {
    const a = planIncByDate.get(i.date) ?? [];
    a.push(i);
    planIncByDate.set(i.date, a);
  }
  for (const p of plan?.paydays ?? []) {
    const a = planPdByDate.get(p.date) ?? [];
    a.push(p);
    planPdByDate.set(p.date, a);
  }
  const hasPlan =
    !!plan && (plan.expenses.length > 0 || plan.incomes.length > 0 || plan.paydays.length > 0);
  const b = data.breakdown;
  const selExp = selected ? (expByDate.get(selected) ?? []) : [];
  const selInc = selected ? (incByDate.get(selected) ?? []) : [];
  const selPd = selected ? (pdByDate.get(selected) ?? []) : [];
  const selPlanExp = selected ? (planExpByDate.get(selected) ?? []) : [];
  const selPlanInc = selected ? (planIncByDate.get(selected) ?? []) : [];
  const selPlanPd = selected ? (planPdByDate.get(selected) ?? []) : [];
  const selShifts = selected ? (byDate.get(selected) ?? []) : [];

  return (
    <div className="space-y-4">
      {/* 1) 月ヘッダ */}
      <header className="flex items-center justify-between">
        <button onClick={() => setMonth(shiftMonth(month, -1))} className="dot px-3 py-1 text-lg">
          ◀
        </button>
        <h1 className="dot text-lg">{fmtMonthJa(month)}のお金</h1>
        <button onClick={() => setMonth(shiftMonth(month, 1))} className="dot px-3 py-1 text-lg">
          ▶
        </button>
      </header>

      {/* 2) 今日あと使えるお金の計算（内訳） */}
      <section className="rounded-sm border border-rule bg-card px-5 py-3 shadow-sm">
        <button onClick={() => setShowCalc(!showCalc)} className="flex w-full items-baseline">
          <h2 className="dot text-xs text-ink-faint">
            {b.allowance !== null
              ? "＊ 今日あと使えるお金の計算 ＊"
              : b.planned
                ? "＊ この月の予定収支 ＊"
                : "＊ この月の収支 ＊"}
          </h2>
          <span className="leader" />
          {b.allowance !== null && (
            <span className={`dot text-lg tabular-nums ${b.allowance < 0 ? "text-vermilion" : ""}`}>
              {fmtYen(b.allowance)}
            </span>
          )}
          <span className="ml-1 text-xs text-ink-faint">{showCalc ? "▲" : "▼"}</span>
        </button>
        {/* B9: 締め日を変えている場合だけ、この収支の集計期間を明示する */}
        {b.range && !b.range.start.endsWith("-01") && (
          <p className="mt-0.5 text-[10px] text-ink-faint">
            {fmtDateJa(b.range.start)}〜{fmtDateJa(b.range.end)}の集計
          </p>
        )}
        {b.planned && (b.expenseTotal > 0 || b.incomeTotal > 0) && (
          <div className="mt-1.5 flex items-baseline text-xs">
            <span className="text-ink-faint">予定合計</span>
            <span className="leader" />
            <span className="dot shrink-0 tabular-nums text-ink-faint">
              支出 −{fmtYen(b.expenseTotal)} ・ 収入 +{fmtYen(b.incomeTotal)}
            </span>
          </div>
        )}
        {showCalc && b.planned && (
          /* A1: 未来月は「予定込みの1系統」。実績行（¥0の行）は出さない */
          <div className="mt-2 space-y-1 text-sm">
            <div className="flex items-baseline">
              <span className="text-ink-faint">予定収入（定期＋入力済みシフトの給料）</span>
              <span className="leader" />
              <span className="dot shrink-0 tabular-nums text-sage">+{fmtYen(b.incomeTotal)}</span>
            </div>
            {b.savingsGoal > 0 && (
              <div className="flex items-baseline">
                <span className="text-ink-faint">貯金目標（先取り）</span>
                <span className="leader" />
                <span className="dot tabular-nums">−{fmtYen(b.savingsGoal)}</span>
              </div>
            )}
            <div className="flex items-baseline">
              <span className="text-ink-faint">予定支出（定期・分割）</span>
              <span className="leader" />
              <span className="dot tabular-nums text-vermilion">−{fmtYen(b.expenseTotal)}</span>
            </div>
            <div className="cutline my-1.5" />
            <div className="flex items-baseline">
              <span className="text-ink-faint">残り</span>
              <span className="leader" />
              <span className={`dot tabular-nums ${b.remain < 0 ? "text-vermilion" : ""}`}>
                {fmtYen(b.remain)}
              </span>
            </div>
            <p className="pt-1 text-[10px] text-ink-faint">
              シフト未入力の給料日は金額未定のため含みません
            </p>
          </div>
        )}
        {showCalc && !b.planned && (
          <div className="mt-2 space-y-1 text-sm">
            <div className="flex items-baseline">
              <span className="text-ink-faint">バイト給料（今月支払い分）</span>
              <span className="leader" />
              <span className="dot tabular-nums text-sage">+{fmtYen(b.shiftIncome)}</span>
            </div>
            <div className="flex items-baseline">
              <span className="text-ink-faint">その他の収入</span>
              <span className="leader" />
              <span className="dot tabular-nums text-sage">+{fmtYen(b.otherIncome)}</span>
            </div>
            {b.savingsGoal > 0 && (
              <div className="flex items-baseline">
                <span className="text-ink-faint">貯金目標（先取り）</span>
                <span className="leader" />
                <span className="dot tabular-nums">−{fmtYen(b.savingsGoal)}</span>
              </div>
            )}
            {b.allowance !== null && (b.fixedTotal ?? 0) > 0 && (
              <div className="flex items-baseline">
                <span className="text-ink-faint">今月の固定費（先取り済み）</span>
                <span className="leader" />
                <span className="dot tabular-nums text-vermilion">−{fmtYen(b.fixedTotal ?? 0)}</span>
              </div>
            )}
            <div className="flex items-baseline">
              <span className="text-ink-faint">
                {b.allowance !== null ? "昨日までの変動支出" : "この月の支出"}
              </span>
              <span className="leader" />
              <span className="dot tabular-nums text-vermilion">
                −{fmtYen(b.allowance !== null ? (b.spentBeforeToday ?? b.expenseTotal) : b.expenseTotal)}
              </span>
            </div>
            <div className="cutline my-1.5" />
            <div className="flex items-baseline">
              <span className="text-ink-faint">残り</span>
              <span className="leader" />
              <span className={`dot tabular-nums ${b.remain < 0 ? "text-vermilion" : ""}`}>
                {fmtYen(b.remain)}
              </span>
            </div>
            {b.allowance !== null && b.daysRemaining !== null && (
              <>
                <div className="flex items-baseline">
                  <span className="text-ink-faint">÷ 残り{b.daysRemaining}日</span>
                  <span className="leader" />
                  <span className="dot tabular-nums">
                    = 今日の予算 {fmtYen(b.todayBudget ?? b.allowance)}
                  </span>
                </div>
                <div className="flex items-baseline">
                  <span className="text-ink-faint">− 今日使った分</span>
                  <span className="leader" />
                  <span className="dot tabular-nums text-vermilion">−{fmtYen(b.spentToday ?? 0)}</span>
                </div>
                <div className="flex items-baseline">
                  <span className="text-ink-faint">= 今日あと使える</span>
                  <span className="leader" />
                  <span className={`dot tabular-nums ${b.allowance < 0 ? "text-vermilion" : ""}`}>
                    {fmtYen(b.allowance)}
                  </span>
                </div>
              </>
            )}
          </div>
        )}
      </section>

      {/* 3) 大きいカレンダー：箱を並べず、印字だけで組む（データのない日は静かに、使った日は濃く） */}
      <div className="zig zig-t zig-b px-2 py-4 shadow-sm">
        <div className="grid grid-cols-7 text-center text-[11px]">
          {["日", "月", "火", "水", "木", "金", "土"].map((d, i) => (
            <span key={d} className={`py-1 ${i === 0 ? "text-vermilion" : "text-ink-faint"}`}>
              {d}
            </span>
          ))}
        </div>
        <div className="grid grid-cols-7">
          {cells.map((date, i) => {
            if (!date) return <span key={`x${i}`} />;
            const day = Number(date.slice(8));
            const exp = expByDate.get(date);
            const inc = incByDate.get(date);
            const pd = pdByDate.get(date);
            const spent = exp?.reduce((s, e) => s + e.amount, 0) ?? 0;
            const got =
              (inc?.reduce((s, x) => s + x.amount, 0) ?? 0) +
              (pd?.reduce((s, x) => s + x.amount, 0) ?? 0);
            // 予定（未来月のみ入る）。薄い表示で実記録と区別する
            const ppd = planPdByDate.get(date);
            const planSpent = planExpByDate.get(date)?.reduce((s, e) => s + e.amount, 0) ?? 0;
            const planGot =
              (planIncByDate.get(date)?.reduce((s, x) => s + x.amount, 0) ?? 0) +
              (ppd?.reduce((s, x) => s + x.amount, 0) ?? 0);
            const today = date === todayLocal();
            const hasData = spent > 0 || got > 0;
            const dayShifts = byDate.get(date) ?? [];
            const picked = multiMode && multiDates.has(date);
            return (
              <button
                key={date}
                onClick={() => openDay(date)}
                className={`relative flex h-14 flex-col items-center gap-0.5 pt-1 ${
                  picked ? "rounded-md border-2 border-vermilion" : ""
                }`}
              >
                <span
                  className={`dot flex h-6 w-6 items-center justify-center rounded-full text-[13px] leading-none ${
                    picked
                      ? "text-vermilion"
                      : today
                        ? "bg-vermilion text-card"
                        : hasData
                          ? "text-ink"
                          : "text-ink-faint/70"
                  }`}
                >
                  {picked ? "✓" : day}
                </span>
                {/* シフトのある日は右上に小さな色ドット（掛け持ちは複数） */}
                {!picked && dayShifts.length > 0 && (
                  <span className="absolute right-0.5 top-0.5 flex gap-0.5">
                    {dayShifts.slice(0, 3).map((s) => (
                      <span
                        key={s.id}
                        className="inline-block h-1.5 w-1.5 rounded-full"
                        style={{ backgroundColor: s.job_color || "var(--vermilion)" }}
                      />
                    ))}
                  </span>
                )}
                {(pd || ppd) && (
                  <span className={`dot text-[9px] leading-none ${pd ? "text-sage" : "text-sage/55"}`}>
                    給料日
                  </span>
                )}
                {got > 0 && (
                  <span className="dot text-[10px] leading-none tabular-nums text-sage">
                    +{got.toLocaleString()}
                  </span>
                )}
                {spent > 0 && (
                  <span className="dot text-[10px] leading-none tabular-nums text-ink">
                    -{spent.toLocaleString()}
                  </span>
                )}
                {planGot > 0 && (
                  <span className="dot text-[10px] leading-none tabular-nums text-sage/55">
                    +{planGot.toLocaleString()}
                  </span>
                )}
                {planSpent > 0 && (
                  <span className="dot text-[10px] leading-none tabular-nums text-ink-faint/80">
                    -{planSpent.toLocaleString()}
                  </span>
                )}
              </button>
            );
          })}
        </div>
        <p className="cutline mt-2 pt-2 text-center text-[11px] text-ink-faint">
          {multiMode
            ? "日付をタップして選択（✓）→ 下の「複数日まとめて登録」で一括登録します"
            : hasPlan
              ? "薄い数字は予定（まだ記帳前）・日付をタップで詳細"
              : "日付をタップで詳細"}
        </p>
      </div>

      {/* 4) シフト登録エリア */}
      <div className="space-y-4">
        <div className="flex items-baseline">
          <h2 className="dot text-sm tracking-[0.14em]">シフト</h2>
          {jobs.length > 0 && (
            <>
              <span className="leader" />
              <Link
                href="/settings#jobs"
                className="text-[11px] text-ink-faint underline underline-offset-2"
              >
                バイト先の設定
              </Link>
            </>
          )}
        </div>

        {jobsLoaded && jobs.length === 0 ? (
          /* バイト先0件でもカレンダーは表示。ここから登録へ誘導（強制はしない） */
          <div className="zig zig-t zig-b px-5 py-6 text-center shadow-sm">
            <p className="text-sm">バイト先を登録すると、シフトから給料を自動計算できます。</p>
            <Link
              href="/settings#jobs"
              className="dot mt-3 inline-block rounded-md bg-vermilion px-6 py-3 text-card shadow-[0_2px_0_var(--vermilion-deep)]"
            >
              バイト先を登録する
            </Link>
          </div>
        ) : jobs.length > 0 ? (
          <>
            {/* この月の勤務で稼ぐ額 */}
            {income && (
              <div className="zig zig-t zig-b px-5 pt-4 pb-3 shadow-sm">
                <p className="dot text-center text-xs tracking-[0.18em] text-ink-faint">
                  ＊ この月の勤務で稼ぐ額 ＊
                </p>
                <p className="dot mt-1 text-center text-4xl leading-none tabular-nums text-sage">
                  {fmtYen(income.total)}
                </p>
                <p className="mt-1.5 text-center text-[11px] text-ink-faint">
                  平日 {income.weekdayHours.toFixed(1)}h ／ 土日祝 {income.weekendHolidayHours.toFixed(1)}h ／{" "}
                  {income.shiftCount}回 ・ 振込日はカレンダー参照
                </p>
                <p className="mt-1 text-center text-[11px] text-ink-faint">
                  {Number(month.slice(5))}月に働いた分（給料日は締め日の翌月など）・
                  <Link href="/" className="underline underline-offset-2">
                    振込月ベースの収入はホームへ
                  </Link>
                </p>
              </div>
            )}

            {/* 音声でシフト追加（マイクが主役：話す→自動解析→1タップ登録） */}
            <section className="zig zig-t zig-b px-4 py-4 shadow-sm">
              {!parsed && (
                <>
                  {speechOk && (
                    <>
                      <button
                        onClick={toggleVoice}
                        disabled={parsing}
                        className={`flex w-full items-center justify-center gap-2.5 rounded-md py-3.5 transition-colors ${
                          listening
                            ? "animate-pulse bg-vermilion text-card"
                            : parsing
                              ? "border-2 border-ink bg-paper"
                              : "bg-vermilion text-card shadow-[0_2px_0_var(--vermilion-deep)] active:translate-y-0.5 active:shadow-none"
                        }`}
                      >
                        {listening ? (
                          <span className="inline-block h-4 w-4 shrink-0 rounded-full bg-card" />
                        ) : (
                          <MicIcon className="h-5 w-5 shrink-0" />
                        )}
                        <span className="dot text-lg">
                          {listening
                            ? "録音中… タップで確定"
                            : parsing
                              ? "AIが解析中・・・"
                              : "話してシフトを追加"}
                        </span>
                      </button>
                      <p className="mt-1.5 text-center text-[11px] text-ink-faint">
                        {listening
                          ? "全部話し終わったら、もう一度上をタップ"
                          : parsing
                            ? "そのままお待ちください"
                            : jobs.length > 1
                              ? "バイト先名も一緒に話すと自動で振り分けます"
                              : "話し終わったら自分でタップして確定する方式です"}
                      </p>
                    </>
                  )}
                  {listening && liveText && (
                    <p className="mt-2 rounded-md border border-rule bg-paper px-3 py-2 text-sm text-ink">
                      {liveText}
                    </p>
                  )}
                  {/* iOSショートカット「CashSyncシフト」を起動 */}
                  {isIOS && !listening && !parsing && (
                    <button
                      onClick={() => {
                        location.href = `shortcuts://run-shortcut?name=${encodeURIComponent("CashSyncシフト")}`;
                      }}
                      className="mt-2 w-full text-center text-[11px] text-ink-faint underline underline-offset-2"
                    >
                      ショートカットで追加（ショートカットアプリに切り替わります・喋り終わるまで画面そのまま）
                    </button>
                  )}
                  {speechOk && !showTextInput ? (
                    <button
                      onClick={() => setShowTextInput(true)}
                      className="mt-1 w-full text-center text-[11px] text-ink-faint underline underline-offset-2"
                    >
                      文字で入力する
                    </button>
                  ) : (
                    <div className="mt-2 flex gap-2">
                      <input
                        value={text}
                        onChange={(e) => setText(e.target.value)}
                        onKeyDown={(e) => e.key === "Enter" && parseShiftText()}
                        placeholder={
                          jobs.length > 1 ? `${jobs[0]?.name}で明日18時から22時半` : "明日18時から22時半"
                        }
                        className="min-w-0 flex-1 rounded-md border border-rule bg-paper px-3 py-2 text-base outline-none focus:border-ink"
                      />
                      <button
                        onClick={() => parseShiftText()}
                        disabled={parsing || !text.trim()}
                        className="dot shrink-0 rounded-md border border-ink px-4 text-sm disabled:opacity-40"
                      >
                        {parsing ? "…" : "解析"}
                      </button>
                    </div>
                  )}
                </>
              )}
              {parsed && (
                <div>
                  <p className="dot text-center text-xs text-ink-faint">＊ このシフトを登録します ＊</p>
                  <div className="mt-1">
                    {parsed.map((s, i) => (
                      <div key={i} className="flex items-center gap-1.5 py-0.5 text-sm">
                        <span className="shrink-0">{fmtDateJa(s.date)}</span>
                        {jobs.length > 1 && (
                          <span className="flex min-w-0 items-center gap-1">
                            <span
                              className="inline-block h-2 w-2 shrink-0 rounded-full"
                              style={{
                                backgroundColor:
                                  jobs.find((j) => j.id === (s.jobId ?? jobId))?.color ||
                                  "var(--vermilion)",
                              }}
                            />
                            <select
                              value={s.jobId ?? jobId}
                              onChange={(e) =>
                                setParsed(
                                  parsed.map((x, xi) =>
                                    xi === i ? { ...x, jobId: e.target.value } : x,
                                  ),
                                )
                              }
                              className="min-w-0 max-w-28 truncate rounded border border-rule bg-paper px-1 py-0.5 text-xs"
                            >
                              {jobs.map((j) => (
                                <option key={j.id} value={j.id}>
                                  {j.name}
                                </option>
                              ))}
                            </select>
                          </span>
                        )}
                        <span className="leader" />
                        <span className="dot shrink-0 tabular-nums">
                          {minToHHMM(s.startMin)}〜{minToHHMM(s.endMin)}
                        </span>
                      </div>
                    ))}
                  </div>
                  <div className="mt-2 flex gap-2">
                    <button
                      onClick={() => {
                        setParsed(null);
                        setText("");
                      }}
                      className="flex-1 rounded-md border border-rule py-3 text-sm text-ink-faint"
                    >
                      やめる
                    </button>
                    <button
                      onClick={saveParsed}
                      disabled={parsing}
                      className="dot flex-[2] rounded-md bg-vermilion py-3 text-base text-card shadow-[0_2px_0_var(--vermilion-deep)]"
                    >
                      {parsed.length}件を登録する
                    </button>
                  </div>
                </div>
              )}
            </section>

            {/* 複数日まとめて登録 */}
            <section className="zig zig-t zig-b px-4 py-4 shadow-sm">
              {!multiMode ? (
                <button
                  onClick={() => {
                    setMultiMode(true);
                    setMultiDates(new Set());
                  }}
                  className="dot w-full rounded-md border border-ink py-2.5 text-sm active:translate-y-0.5"
                >
                  複数日まとめて登録
                </button>
              ) : (
                <>
                  <p className="text-[11px] text-ink-faint">
                    上のカレンダーで日付をタップして選択（✓）→ バイト先・時間帯で一括登録します
                  </p>
                  <div className="mt-2 flex items-center gap-2">
                    <span
                      className="inline-block h-2.5 w-2.5 shrink-0 rounded-full"
                      style={{
                        backgroundColor: jobs.find((j) => j.id === jobId)?.color || "var(--vermilion)",
                      }}
                    />
                    <select
                      value={jobId}
                      onChange={(e) => setJobId(e.target.value)}
                      className="min-w-0 flex-1 rounded-md border border-rule bg-paper px-2 py-2 text-sm"
                    >
                      {jobs.map((j) => (
                        <option key={j.id} value={j.id}>
                          {j.name}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="mt-2 flex items-center gap-2">
                    <input
                      type="time"
                      value={msStart}
                      onChange={(e) => setMsStart(e.target.value)}
                      className="min-w-0 flex-1 rounded-md border border-rule bg-paper px-2 py-2 text-sm"
                    />
                    <span className="dot">〜</span>
                    <input
                      type="time"
                      value={msEnd}
                      onChange={(e) => setMsEnd(e.target.value)}
                      className="min-w-0 flex-1 rounded-md border border-rule bg-paper px-2 py-2 text-sm"
                    />
                    <input
                      type="number"
                      inputMode="numeric"
                      value={msBrk}
                      onChange={(e) => setMsBrk(e.target.value)}
                      title="休憩(分)"
                      className="w-14 rounded-md border border-rule bg-paper px-2 py-2 text-sm tabular-nums"
                    />
                  </div>
                  <div className="mt-2 flex gap-2">
                    <button
                      onClick={() => {
                        setMultiMode(false);
                        setMultiDates(new Set());
                      }}
                      className="flex-1 rounded-md border border-rule py-2.5 text-sm text-ink-faint"
                    >
                      やめる
                    </button>
                    <button
                      onClick={saveMulti}
                      disabled={multiBusy || multiDates.size === 0}
                      className="dot flex-[2] rounded-md bg-vermilion py-2.5 text-sm text-card shadow-[0_2px_0_var(--vermilion-deep)] disabled:opacity-50"
                    >
                      {multiBusy ? "登録中・・・" : `${multiDates.size}日ぶん登録`}
                    </button>
                  </div>
                </>
              )}
            </section>

            {/* この月のシフト一覧（時間・給料・出どころ・削除） */}
            {shifts.length > 0 && (
              <section className="zig zig-t zig-b px-4 py-3 shadow-sm">
                <h2 className="dot text-xs text-ink-faint">この月のシフト</h2>
                <ul className="mt-1">
                  {shifts.map((s) => (
                    <li key={s.id} className="flex items-center gap-2 py-1.5 text-sm">
                      <button
                        onClick={() => openEditor(s.date, s)}
                        className="flex min-w-0 flex-1 items-baseline text-left"
                      >
                        <span
                          className="mr-1.5 inline-block h-2.5 w-2.5 shrink-0 self-center rounded-full"
                          style={{ backgroundColor: s.job_color || "var(--vermilion)" }}
                        />
                        <span className="shrink-0">{fmtDateJa(s.date)}</span>
                        {jobs.length > 1 && (
                          <span className="ml-1 max-w-16 shrink-0 truncate text-[10px] text-ink-faint">
                            {s.job_name}
                          </span>
                        )}
                        <span
                          className="ml-1 shrink-0 self-center text-ink-faint"
                          title={s.source === "calendar" ? "カレンダー同期" : "手入力"}
                        >
                          {s.source === "calendar" ? (
                            <CalendarIcon className="h-3.5 w-3.5" />
                          ) : (
                            <PencilIcon className="h-3.5 w-3.5" />
                          )}
                        </span>
                        <span className="leader" />
                        <span className="dot shrink-0 tabular-nums">
                          {minToHHMM(s.start_min)}〜{minToHHMM(s.end_min)}
                        </span>
                        <span className="dot ml-2 shrink-0 tabular-nums text-sage">{fmtYen(s.pay)}</span>
                      </button>
                      <button
                        onClick={() => removeById(s.id)}
                        className="shrink-0 px-1 text-xs text-vermilion"
                        aria-label="削除"
                      >
                        ✕
                      </button>
                    </li>
                  ))}
                </ul>
              </section>
            )}

            {/* Googleカレンダー連携 */}
            <button
              onClick={openLink}
              className={`flex w-full items-center justify-center gap-1.5 rounded-md border py-3 text-sm ${
                autoOn ? "border-sage text-sage" : "border-dashed border-rule text-ink-faint"
              }`}
            >
              <CalendarIcon className="h-4 w-4 shrink-0" />
              {autoOn ? "カレンダー自動同期 ON（タップで設定）" : "Googleカレンダーと連携（自動同期）"}
            </button>
          </>
        ) : null}
      </div>

      {/* 日別詳細シート（お金＋その日のシフト） */}
      {selected && (
        <div className="fixed inset-0 z-50 flex items-end bg-ink/40" onClick={() => setSelected(null)}>
          <div
            className="zig zig-t mx-auto max-h-[75dvh] w-full max-w-md overflow-y-auto px-5 pb-8 pt-5"
            onClick={(e) => e.stopPropagation()}
          >
            <p className="dot text-center text-xs text-ink-faint">＊ {fmtDateJa(selected)} ＊</p>
            {selPd.map((p) => (
              <div
                key={p.jobId}
                className="mt-3 rounded-md border px-3 py-2"
                style={{ borderColor: p.color }}
              >
                <div className="flex items-baseline text-sm">
                  <span
                    className="mr-1.5 inline-block h-2.5 w-2.5 self-center rounded-full"
                    style={{ backgroundColor: p.color }}
                  />
                  <span>{p.jobName} 給料日</span>
                  <span className="leader" />
                  <span className="dot tabular-nums text-sage">+{fmtYen(p.amount)}</span>
                </div>
                <p className="mt-0.5 text-[11px] text-ink-faint">
                  {p.periodStart === p.periodEnd
                    ? "当日の勤務分（当日払い）"
                    : `${fmtDateJa(p.periodStart)}〜${fmtDateJa(p.periodEnd)}の勤務分`}
                </p>
              </div>
            ))}
            {selInc.length > 0 && (
              <ul className="mt-3">
                {selInc.map((x) => (
                  <li key={x.id} className="flex items-baseline py-1 text-sm">
                    <span className="text-sage">＋</span>
                    <span className="ml-1 truncate">{x.memo || "収入"}</span>
                    <span className="leader" />
                    <span className="dot tabular-nums text-sage">+{fmtYen(x.amount)}</span>
                  </li>
                ))}
              </ul>
            )}
            {selExp.length > 0 && (
              <ul className="mt-3 cutline pt-2">
                {selExp.map((e) => (
                  <li key={e.id}>
                    {/* C10: 行タップで履歴と同じ編集シート（削除もシート内から） */}
                    <button
                      onClick={() => setEditing({ ...e })}
                      className="flex w-full items-baseline gap-1 py-1 text-left text-sm"
                    >
                      {e.category && (
                        <CategoryIcon icon={e.icon} className="h-4 w-4 shrink-0 self-center text-ink-faint" />
                      )}
                      <span className="truncate">{e.memo || e.category || "支出"}</span>
                      <span className="leader" />
                      <span className="dot tabular-nums text-vermilion">−{fmtYen(e.amount)}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
            {/* その日のシフト（掛け持ち対応。タップで編集・✕で削除） */}
            {selShifts.length > 0 && (
              <ul className="mt-3 cutline pt-2">
                {selShifts.map((s) => (
                  <li key={s.id} className="flex items-center gap-2 py-1 text-sm">
                    <button
                      onClick={() => openEditor(selected, s)}
                      className="flex min-w-0 flex-1 items-baseline text-left"
                    >
                      <span
                        className="mr-1.5 inline-block h-2.5 w-2.5 shrink-0 self-center rounded-full"
                        style={{ backgroundColor: s.job_color || "var(--vermilion)" }}
                      />
                      <span className="shrink-0">{s.job_name || "シフト"}</span>
                      <span className="leader" />
                      <span className="dot shrink-0 tabular-nums">
                        {minToHHMM(s.start_min)}〜{minToHHMM(s.end_min)}
                      </span>
                      <span className="dot ml-2 shrink-0 tabular-nums text-sage">{fmtYen(s.pay)}</span>
                    </button>
                    <button
                      onClick={async () => {
                        await removeById(s.id);
                      }}
                      className="shrink-0 px-1 text-xs text-vermilion"
                      aria-label="削除"
                    >
                      ✕
                    </button>
                  </li>
                ))}
              </ul>
            )}
            {(selPlanPd.length > 0 || selPlanInc.length > 0 || selPlanExp.length > 0) && (
              <div className="mt-3 cutline pt-2">
                <p className="dot text-[11px] text-ink-faint">＊ 予定（まだ記帳前） ＊</p>
                {selPlanPd.map((p) => (
                  <div
                    key={p.jobId}
                    className="mt-2 rounded-md border border-dashed px-3 py-2 opacity-80"
                    style={{ borderColor: p.color }}
                  >
                    <div className="flex items-baseline text-sm">
                      <span
                        className="mr-1.5 inline-block h-2.5 w-2.5 self-center rounded-full opacity-70"
                        style={{ backgroundColor: p.color }}
                      />
                      <span>{p.jobName} 給料日</span>
                      <span className="ml-1 shrink-0 text-[10px] text-ink-faint">予定</span>
                      <span className="leader" />
                      {p.amount > 0 ? (
                        <span className="dot shrink-0 tabular-nums text-sage">+{fmtYen(p.amount)}</span>
                      ) : (
                        <span className="shrink-0 text-[11px] text-ink-faint">金額未定</span>
                      )}
                    </div>
                    <p className="mt-0.5 text-[11px] text-ink-faint">
                      {p.confirmed
                        ? `${fmtDateJa(p.periodStart)}〜${fmtDateJa(p.periodEnd)}の入力済みシフト分`
                        : "シフト未入力のため金額は未定です"}
                    </p>
                  </div>
                ))}
                {selPlanInc.length > 0 && (
                  <ul className="mt-2">
                    {selPlanInc.map((x) => (
                      <li key={x.recurringId} className="flex items-baseline py-1 text-sm opacity-80">
                        <span className="text-sage">＋</span>
                        <span className="ml-1 truncate">{x.name}</span>
                        <span className="ml-1 shrink-0 text-[10px] text-ink-faint">予定</span>
                        <span className="leader" />
                        <span className="dot shrink-0 tabular-nums text-sage">+{fmtYen(x.amount)}</span>
                      </li>
                    ))}
                  </ul>
                )}
                {selPlanExp.length > 0 && (
                  <ul className="mt-2">
                    {selPlanExp.map((x) => (
                      <li key={x.recurringId} className="flex items-baseline gap-1 py-1 text-sm opacity-80">
                        {x.category && (
                          <CategoryIcon icon={x.icon} className="h-4 w-4 shrink-0 self-center text-ink-faint" />
                        )}
                        <span className="truncate">{x.name}</span>
                        <span className="shrink-0 text-[10px] text-ink-faint">予定</span>
                        <span className="leader" />
                        <span className="dot shrink-0 tabular-nums text-ink-faint">−{fmtYen(x.amount)}</span>
                      </li>
                    ))}
                  </ul>
                )}
                <p className="mt-2 text-[10px] text-ink-faint">
                  予定はその月が来ると自動で記帳されます。内容は「設定 › 定期支出・収入」から変更できます。
                </p>
              </div>
            )}
            {selPd.length === 0 &&
              selInc.length === 0 &&
              selExp.length === 0 &&
              selShifts.length === 0 &&
              selPlanPd.length === 0 &&
              selPlanInc.length === 0 &&
              selPlanExp.length === 0 && (
                <p className="mt-4 pb-2 text-center text-xs text-ink-faint">
                  この日のお金の動きはありません（ノーマネーデー）
                </p>
              )}

            {/* この日にシフトを直接追加（単発。複数日まとめて・音声はカレンダー下のシフト登録エリアから） */}
            <div className="mt-4 cutline pt-3">
              {jobs.length === 0 ? (
                <Link
                  href="/settings#jobs"
                  className="dot block text-center text-[11px] text-ink-faint underline underline-offset-2"
                >
                  バイト先を登録すると、ここからシフトを入れられます
                </Link>
              ) : !showShiftAdd ? (
                <button
                  onClick={() => setShowShiftAdd(true)}
                  className="dot w-full rounded-md border border-ink py-2 text-sm active:translate-y-0.5"
                >
                  ＋ この日にシフトを追加（掛け持ちOK）
                </button>
              ) : (
                <div className="space-y-2">
                  {jobs.length > 1 && (
                    <select
                      value={jobId}
                      onChange={(e) => setJobId(e.target.value)}
                      className="w-full rounded-md border border-rule bg-paper px-3 py-2 text-sm"
                    >
                      {jobs.map((j) => (
                        <option key={j.id} value={j.id}>
                          {j.name}
                        </option>
                      ))}
                    </select>
                  )}
                  <div className="flex items-center gap-2 text-sm">
                    <input
                      type="time"
                      value={shiftStart}
                      onChange={(e) => setShiftStart(e.target.value)}
                      className="flex-1 rounded-md border border-rule bg-paper px-2 py-2"
                    />
                    <span className="text-ink-faint">〜</span>
                    <input
                      type="time"
                      value={shiftEnd}
                      onChange={(e) => setShiftEnd(e.target.value)}
                      className="flex-1 rounded-md border border-rule bg-paper px-2 py-2"
                    />
                  </div>
                  <div className="flex items-center gap-2 text-sm">
                    <label className="flex flex-1 items-center gap-1.5 text-ink-faint">
                      休憩
                      <input
                        type="number"
                        inputMode="numeric"
                        value={shiftBreak}
                        onChange={(e) => setShiftBreak(e.target.value)}
                        className="w-16 rounded-md border border-rule bg-paper px-2 py-1.5 text-right"
                      />
                      分
                    </label>
                    <button
                      onClick={() => setShowShiftAdd(false)}
                      className="rounded-md border border-rule px-3 py-1.5 text-xs text-ink-faint"
                    >
                      やめる
                    </button>
                    <button
                      onClick={addShift}
                      disabled={shiftBusy || !jobId}
                      className="dot rounded-md bg-vermilion px-4 py-1.5 text-sm text-card active:translate-y-0.5 disabled:opacity-50"
                    >
                      追加
                    </button>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* シフト編集シート（一覧・日別シートから開く） */}
      {editDate && (
        <div className="fixed inset-0 z-50 flex items-end bg-ink/40" onClick={() => setEditDate(null)}>
          <div
            className="zig zig-t mx-auto w-full max-w-md px-5 pb-8 pt-5"
            onClick={(e) => e.stopPropagation()}
          >
            <p className="dot text-center text-xs text-ink-faint">＊ {fmtDateJa(editDate)} ＊</p>
            <div className="mt-3 space-y-3">
              {jobs.length > 1 && (
                <select
                  value={jobId}
                  onChange={(e) => setJobId(e.target.value)}
                  className="w-full rounded-md border border-rule bg-paper px-3 py-2 text-base"
                >
                  {jobs.map((j) => (
                    <option key={j.id} value={j.id}>
                      {j.name}
                    </option>
                  ))}
                </select>
              )}
              <div className="flex items-center gap-2">
                <input
                  type="time"
                  value={eStart}
                  onChange={(e) => setEStart(e.target.value)}
                  className="min-w-0 flex-1 rounded-md border border-rule bg-paper px-3 py-2 text-base"
                />
                <span className="dot shrink-0">〜</span>
                <input
                  type="time"
                  value={eEnd}
                  onChange={(e) => setEEnd(e.target.value)}
                  className="min-w-0 flex-1 rounded-md border border-rule bg-paper px-3 py-2 text-base"
                />
              </div>
              <label className="flex items-center gap-2 text-sm">
                <span className="dot text-xs text-ink-faint">休憩(分)</span>
                <input
                  type="number"
                  inputMode="numeric"
                  value={eBrk}
                  onChange={(e) => setEBrk(e.target.value)}
                  className="w-20 rounded-md border border-rule bg-paper px-3 py-2 text-base tabular-nums"
                />
              </label>
            </div>
            <div className="mt-4 flex gap-2">
              {editShiftId && (
                <button
                  onClick={removeShift}
                  disabled={editBusy}
                  className="rounded-md border border-vermilion px-4 py-3 text-sm text-vermilion"
                >
                  削除
                </button>
              )}
              <button
                onClick={saveShift}
                disabled={editBusy}
                className="dot flex-1 rounded-md bg-vermilion py-3 text-base text-card shadow-[0_2px_0_var(--vermilion-deep)]"
              >
                {editBusy ? "・・・" : "保存"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 連携設定シート */}
      {linkOpen && (
        <div className="fixed inset-0 z-50 flex items-end bg-ink/40" onClick={() => setLinkOpen(false)}>
          <div
            className="zig zig-t mx-auto max-h-[85dvh] w-full max-w-md overflow-y-auto px-5 pb-8 pt-5"
            onClick={(e) => e.stopPropagation()}
          >
            <p className="dot text-center text-xs text-ink-faint">＊ カレンダー自動同期 ＊</p>
            <p className="mt-2 text-[11px] leading-relaxed text-ink-faint">
              一度ONにすると、アプリを開くたびに今月・来月のシフトを自動で取り込み、時間変更や取り消しも反映します（手入力のシフトには触りません）。
            </p>
            <div className="mt-3 space-y-3">
              {jobs.length > 1 && (
                <select
                  value={jobId}
                  onChange={(e) => setJobId(e.target.value)}
                  className="w-full rounded-md border border-rule bg-paper px-3 py-2 text-base"
                >
                  {jobs.map((j) => (
                    <option key={j.id} value={j.id}>
                      {j.name}
                    </option>
                  ))}
                </select>
              )}
              <label className="block">
                <span className="dot text-xs text-ink-faint">含めるキーワード（予定タイトル・カンマ区切り）</span>
                <input
                  value={linkKeywords}
                  onChange={(e) => setLinkKeywords(e.target.value)}
                  placeholder="例：キミハン"
                  className="mt-1 w-full rounded-md border border-rule bg-paper px-3 py-2 text-base outline-none focus:border-ink"
                />
              </label>
              <label className="block">
                <span className="dot text-xs text-ink-faint">除外ワード（希望提出・締切などの誤取り込み防止）</span>
                <input
                  value={linkExcludes}
                  onChange={(e) => setLinkExcludes(e.target.value)}
                  className="mt-1 w-full rounded-md border border-rule bg-paper px-3 py-2 text-base outline-none focus:border-ink"
                />
              </label>
              <p className="text-[11px] text-ink-faint">
                ほかに1時間未満・12時間超の予定は自動でシフト扱いしません。
              </p>
              {linkError && <p className="text-sm text-vermilion">{linkError}</p>}
              {linkBusy && (
                <p className="text-[11px] text-ink-faint">
                  Googleのログインポップアップが開きます。表示されないときはポップアップブロックを確認してください。
                </p>
              )}
              <button
                onClick={startLink}
                disabled={linkBusy || !linkKeywords.trim()}
                className="dot w-full rounded-md bg-vermilion py-3 text-base text-card shadow-[0_2px_0_var(--vermilion-deep)] disabled:opacity-50"
              >
                {linkBusy ? "同期中・・・" : autoOn ? "設定を保存して今すぐ同期" : "連携して自動同期を開始"}
              </button>
              {autoOn && (
                <button
                  onClick={stopLink}
                  className="w-full rounded-md border border-rule py-2.5 text-sm text-ink-faint"
                >
                  自動同期をOFFにする
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      {/* C10: 履歴と同じ支出編集シート */}
      {editing && (
        <ExpenseEditSheet
          expense={{
            id: editing.id,
            date: editing.date,
            amount: editing.amount,
            memo: editing.memo,
            category_id: editing.category_id ?? null,
            source: editing.source,
            receipt_id: editing.receipt_id ?? null,
          }}
          categories={categories}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            loadCal(month);
            show("保存しました");
          }}
          onDeleted={(undo) => {
            setEditing(null);
            loadCal(month);
            show("支出を削除しました", async () => {
              try {
                await undo();
                loadCal(month);
                show("元に戻しました");
              } catch (e) {
                show(e instanceof Error ? e.message : "元に戻せませんでした。");
              }
            });
          }}
        />
      )}

      <Toast toast={toast} hide={hide} />
    </div>
  );
}
