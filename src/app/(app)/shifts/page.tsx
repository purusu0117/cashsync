"use client";

// シフト：カレンダー自動同期（一度設定すれば開くたびに差分同期）＋音声/文章入力＋月カレンダー＋一覧。
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  DEFAULT_EXCLUDES,
  getCalendarToken,
  isAutoSyncOn,
  setAutoSync,
  syncMonth,
} from "@/lib/calendarImport";
import { apiCall, apiJson } from "@/lib/clientApi";
import { fmtDateJa, fmtMonthJa, fmtYen, hhmmToMin, minToHHMM, todayLocal } from "@/lib/format";

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

export default function ShiftsPage() {
  const [month, setMonth] = useState(todayLocal().slice(0, 7));
  const [shifts, setShifts] = useState<Shift[]>([]);
  const [income, setIncome] = useState<Income | null>(null);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [jobId, setJobId] = useState("");
  const [toast, setToast] = useState("");
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // 日タップ：一覧シート（同日掛け持ち対応）と編集フォーム
  const [dayList, setDayList] = useState<string | null>(null); // その日のシフト一覧シート
  const [editDate, setEditDate] = useState<string | null>(null); // 編集フォーム
  const [editShiftId, setEditShiftId] = useState<string | null>(null); // null=新規追加
  const [start, setStart] = useState("18:00");
  const [end, setEnd] = useState("22:30");
  const [brk, setBrk] = useState("0");
  const [busy, setBusy] = useState(false);

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

  function showToast(msg: string) {
    if (toastTimer.current) clearTimeout(toastTimer.current);
    setToast(msg);
    toastTimer.current = setTimeout(() => setToast(""), 5000);
  }

  const load = useCallback(async (m: string) => {
    const res = await fetch(`/api/shifts?month=${m}`);
    if (res.status === 401) {
      location.href = "/login";
      return;
    }
    const d = await res.json();
    setShifts(d.shifts ?? []);
    setIncome(d.income ?? null);
  }, []);

  const loadJobs = useCallback(async () => {
    const d = await fetch("/api/jobs").then((r) => r.json());
    const list: Job[] = d.jobs ?? [];
    setJobs(list);
    if (list[0]) setJobId((prev) => prev || list[0].id);
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
          showToast(
            `📅 カレンダー同期: 追加${added}・変更${updated}・削除${removed}`,
          );
          load(m);
        }
      } catch {
        // サイレント失敗（トークン切れ等）。連携設定シートから再認証できる。
        syncedRef.current.delete(key);
      }
    },
    [load],
  );

  useEffect(() => {
    setAutoOn(isAutoSyncOn());
    const w = window as unknown as {
      SpeechRecognition?: new () => SpeechRecognitionLike;
      webkitSpeechRecognition?: new () => SpeechRecognitionLike;
    };
    setSpeechOk(!!(w.SpeechRecognition || w.webkitSpeechRecognition));
    setIsIOS(/iPad|iPhone|iPod/.test(navigator.userAgent));
  }, []);

  useEffect(() => {
    load(month);
    loadJobs().then((list) => autoSync(month, list));
    // アプリに戻ってきたら最新化
    const onVisible = () => {
      if (document.visibilityState === "visible") load(month);
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [month, load, loadJobs, autoSync]);

  const [y, m] = month.split("-").map(Number);
  const first = new Date(y, m - 1, 1);
  const days = new Date(y, m, 0).getDate();
  const cells: (string | null)[] = [
    ...Array<null>(first.getDay()).fill(null),
    ...Array.from({ length: days }, (_, i) => `${month}-${String(i + 1).padStart(2, "0")}`),
  ];
  // 同日掛け持ち対応：1日に複数シフトを持てる
  const byDate = new Map<string, Shift[]>();
  for (const s of shifts) {
    const arr = byDate.get(s.date) ?? [];
    arr.push(s);
    byDate.set(s.date, arr);
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
      showToast(`${added}日ぶん登録しました${skipped > 0 ? `（${skipped}日は登録済みのためスキップ）` : ""}`);
      setMultiMode(false);
      setMultiDates(new Set());
      load(month);
    } catch (e) {
      showToast(e instanceof Error ? e.message : "登録に失敗しました。");
    } finally {
      setMultiBusy(false);
    }
  }

  function openEditor(date: string, shift: Shift | null) {
    if (shift) {
      setJobId(shift.job_id);
      setStart(minToHHMM(shift.start_min));
      setEnd(minToHHMM(shift.end_min));
      setBrk(String(shift.break_min));
      setEditShiftId(shift.id);
    } else {
      if (shifts.length > 0) {
        // 前回の時間帯を初期値に（入力摩擦の削減）
        const last = shifts[shifts.length - 1];
        setStart(minToHHMM(last.start_min));
        setEnd(minToHHMM(last.end_min));
        setBrk(String(last.break_min));
      }
      setEditShiftId(null);
    }
    setDayList(null);
    setEditDate(date);
  }

  function openDay(date: string) {
    if (multiMode) {
      // 選択モード中は日付をタップで選択/解除
      const next = new Set(multiDates);
      if (next.has(date)) next.delete(date);
      else next.add(date);
      setMultiDates(next);
      return;
    }
    const list = byDate.get(date) ?? [];
    if (list.length === 0) {
      openEditor(date, null); // シフトが無い日は直接新規登録へ
    } else {
      setDayList(date); // その日のシフト一覧（掛け持ち対応）
    }
  }

  async function saveShift() {
    if (!editDate || !jobId) return;
    setBusy(true);
    try {
      // 新規登録を先に検証してから旧シフトを消す（登録失敗でシフトが消えるのを防ぐ）
      await apiCall(
        "/api/shifts",
        apiJson({
          jobId,
          date: editDate,
          startMin: hhmmToMin(start),
          endMin: hhmmToMin(end),
          breakMin: Number(brk) || 0,
        }),
      );
      if (editShiftId) await apiCall(`/api/shifts?id=${editShiftId}`, { method: "DELETE" });
      setEditDate(null);
      setEditShiftId(null);
      load(month);
    } catch (e) {
      showToast(e instanceof Error ? e.message : "保存に失敗しました。");
    } finally {
      setBusy(false);
    }
  }

  async function removeShift() {
    if (!editDate) return;
    try {
      if (editShiftId) {
        setBusy(true);
        await apiCall(`/api/shifts?id=${editShiftId}`, { method: "DELETE" });
      }
      setEditDate(null);
      setEditShiftId(null);
      load(month);
    } catch (e) {
      showToast(e instanceof Error ? e.message : "削除に失敗しました。");
    } finally {
      setBusy(false);
    }
  }

  async function removeById(id: string) {
    try {
      await apiCall(`/api/shifts?id=${id}`, { method: "DELETE" });
      load(month);
    } catch (e) {
      showToast(e instanceof Error ? e.message : "削除に失敗しました。");
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
      showToast(`📅 連携ON: 追加${added}・変更${updated}・削除${removed}。今後は開くたびに自動同期します`);
      load(month);
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
    showToast("自動同期をOFFにしました（取り込み済みシフトは残ります）");
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
      if (!res.ok) throw new Error(d.error ?? "解析に失敗しました。");
      // バイト先を言っていないシフトは、選択中（なければ先頭）のバイト先に倒す
      const fallback = jobId || d.defaultJobId || null;
      setParsed(
        (d.shifts as ParsedShift[]).map((s) => ({ ...s, jobId: s.jobId ?? fallback })),
      );
    } catch (e) {
      showToast(e instanceof Error ? e.message : "解析に失敗しました。");
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
      showToast(`${parsed.length}件のシフトを登録しました`);
      load(month);
    } catch (e) {
      showToast(e instanceof Error ? e.message : "登録に失敗しました。");
    } finally {
      setParsing(false);
    }
  }

  if (jobs.length === 0) {
    return (
      <div className="space-y-4">
        <h1 className="dot text-lg">シフト</h1>
        <div className="zig zig-t zig-b px-5 py-8 text-center shadow-sm">
          <p className="text-sm">まずバイト先と時給を登録しましょう。</p>
          <Link
            href="/settings#jobs"
            className="dot mt-4 inline-block rounded-md bg-vermilion px-6 py-3 text-card shadow-[0_2px_0_var(--vermilion-deep)]"
          >
            バイト先を登録する
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <header className="flex items-center justify-between">
        <button onClick={() => setMonth(shiftMonth(month, -1))} className="dot px-3 py-1 text-lg">
          ◀
        </button>
        <h1 className="dot text-lg">{fmtMonthJa(month)} のシフト</h1>
        <button onClick={() => setMonth(shiftMonth(month, 1))} className="dot px-3 py-1 text-lg">
          ▶
        </button>
      </header>

      {income && (
        <div className="zig zig-t zig-b px-5 py-3 shadow-sm">
          <div className="flex items-baseline justify-between">
            <span className="dot text-xs text-ink-faint">この月の勤務で稼ぐ額</span>
            <span className="dot text-2xl tabular-nums text-sage">{fmtYen(income.total)}</span>
          </div>
          <p className="text-right text-[10px] text-ink-faint">振込日はカレンダーの💰参照</p>
          <p className="mt-1 text-right text-[11px] text-ink-faint">
            平日 {income.weekdayHours.toFixed(1)}h ／ 土日祝 {income.weekendHolidayHours.toFixed(1)}h ／ {income.shiftCount}回
          </p>
        </div>
      )}

      {/* 音声でシフト追加（マイクが主役：話す→自動解析→1タップ登録） */}
      <section className="zig zig-t zig-b px-4 py-4 shadow-sm">
        {!parsed && (
          <>
            {speechOk && (
            <button
              onClick={toggleVoice}
              disabled={parsing}
              className={`w-full rounded-lg py-4 text-center transition-colors ${
                listening
                  ? "animate-pulse bg-vermilion text-card"
                  : parsing
                    ? "border-2 border-ink bg-paper"
                    : "bg-vermilion text-card shadow-[0_2px_0_var(--vermilion-deep)] active:translate-y-0.5 active:shadow-none"
              }`}
            >
              <span className="text-2xl">{listening ? "⏺" : "🎤"}</span>
              <span className="dot block text-lg">
                {listening ? "録音中… タップで確定" : parsing ? "AIが解析中・・・" : "話してシフトを追加"}
              </span>
              <span className={`block text-[11px] ${listening || parsing ? "" : "opacity-80"}`}>
                {listening
                  ? "全部話し終わったら、もう一度ここをタップ"
                  : parsing
                    ? "そのままお待ちください"
                    : jobs.length > 1
                      ? "バイト先名も一緒に話すと自動で振り分けます"
                      : "話し終わったら自分でタップして確定する方式です"}
              </span>
            </button>
            )}
            {listening && liveText && (
              <p className="mt-2 rounded-md border border-rule bg-paper px-3 py-2 text-sm text-ink">
                {liveText}
              </p>
            )}
            {/* iOSショートカット「CashSyncシフト」を起動（トークンはショートカット内に設定済み。
                他のアプリを見ながら使える入口と同じものを、アプリ内からも開けるようにする） */}
            {isIOS && !listening && !parsing && (
              <button
                onClick={() => {
                  location.href = `shortcuts://run-shortcut?name=${encodeURIComponent("CashSyncシフト")}`;
                }}
                className="mt-2 w-full text-center text-[11px] text-ink-faint underline underline-offset-2"
              >
                📲 ショートカットで追加（ショートカットアプリに切り替わります・喋り終わるまで画面そのまま）
              </button>
            )}
            {speechOk && !showTextInput ? (
              <button
                onClick={() => setShowTextInput(true)}
                className="mt-1 w-full text-center text-[11px] text-ink-faint underline underline-offset-2"
              >
                ✏️ 文字で入力する
              </button>
            ) : (
              <div className="mt-2 flex gap-2">
                <input
                  value={text}
                  onChange={(e) => setText(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && parseShiftText()}
                  placeholder={
                    jobs.length > 1
                      ? `${jobs[0]?.name}で明日18時から22時半`
                      : "明日18時から22時半"
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

      {/* 月カレンダー */}
      <div className="zig zig-t zig-b px-3 py-4 shadow-sm">
        <div className="grid grid-cols-7 text-center text-[11px] text-ink-faint">
          {["日", "月", "火", "水", "木", "金", "土"].map((d) => (
            <span key={d} className="py-1">
              {d}
            </span>
          ))}
        </div>
        <div className="grid grid-cols-7 gap-1">
          {cells.map((date, i) => {
            if (!date) return <span key={`x${i}`} />;
            const list = byDate.get(date) ?? [];
            const s = list[0];
            const day = Number(date.slice(8));
            const today = date === todayLocal();
            const picked = multiMode && multiDates.has(date);
            return (
              <button
                key={date}
                onClick={() => openDay(date)}
                className={`flex h-12 flex-col items-center justify-center rounded-md text-sm ${
                  picked
                    ? "border-2 border-vermilion bg-card text-vermilion"
                    : s
                      ? "text-card"
                      : today
                        ? "border-2 border-ink bg-card"
                        : "border border-rule bg-paper"
                }`}
                style={!picked && s ? { backgroundColor: s.job_color || "var(--vermilion)" } : undefined}
              >
                <span className="dot">{picked ? "✓" : day}</span>
                {!picked && list.length === 1 && (
                  <span className="text-[9px] leading-none">{minToHHMM(s.start_min)}</span>
                )}
                {!picked && list.length > 1 && (
                  <span className="flex items-center gap-0.5">
                    {list.slice(0, 3).map((x) => (
                      <span
                        key={x.id}
                        className="inline-block h-1.5 w-1.5 rounded-full border border-card"
                        style={{ backgroundColor: x.job_color || "var(--vermilion)" }}
                      />
                    ))}
                  </span>
                )}
              </button>
            );
          })}
        </div>
        {!multiMode ? (
          <div className="mt-2 text-right">
            <button
              onClick={() => {
                setMultiMode(true);
                setMultiDates(new Set());
              }}
              className="dot rounded border border-rule px-2 py-1 text-[11px] text-ink-faint"
            >
              🗓 複数日まとめて登録
            </button>
          </div>
        ) : (
          <div className="cutline mt-3 pt-3">
            <p className="text-[11px] text-ink-faint">
              日付をタップして選択（✓）→ 下のバイト先・時間帯で一括登録します
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
          </div>
        )}
      </div>

      {/* シフト一覧（管理しやすさ重視：時間・給料・出どころ・削除） */}
      {shifts.length > 0 && (
        <section className="zig zig-t zig-b px-4 py-3 shadow-sm">
          <h2 className="dot text-xs text-ink-faint">この月のシフト</h2>
          <ul className="mt-1">
            {shifts.map((s) => (
              <li key={s.id} className="flex items-center gap-2 py-1.5 text-sm">
                <button onClick={() => openEditor(s.date, s)} className="flex min-w-0 flex-1 items-baseline text-left">
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
                  <span className="ml-1 shrink-0 text-[10px] text-ink-faint">
                    {s.source === "calendar" ? "📅" : "✋"}
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

      {/* カレンダー連携 */}
      <button
        onClick={openLink}
        className={`w-full rounded-md border py-3 text-sm ${
          autoOn ? "border-sage text-sage" : "border-dashed border-rule text-ink-faint"
        }`}
      >
        {autoOn ? "📅 カレンダー自動同期 ON（タップで設定）" : "📅 Googleカレンダーと連携（自動同期）"}
      </button>

      {/* トースト */}
      {toast && (
        <div className="fixed bottom-24 left-1/2 z-50 w-[calc(100%-3rem)] max-w-sm -translate-x-1/2 rounded-md bg-ink px-4 py-3 text-sm text-card shadow-lg">
          {toast}
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
                <button onClick={stopLink} className="w-full rounded-md border border-rule py-2.5 text-sm text-ink-faint">
                  自動同期をOFFにする
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      {/* 日別シフト一覧シート（同日掛け持ち対応） */}
      {dayList && (
        <div className="fixed inset-0 z-50 flex items-end bg-ink/40" onClick={() => setDayList(null)}>
          <div
            className="zig zig-t mx-auto w-full max-w-md px-5 pb-8 pt-5"
            onClick={(e) => e.stopPropagation()}
          >
            <p className="dot text-center text-xs text-ink-faint">＊ {fmtDateJa(dayList)}のシフト ＊</p>
            <ul className="mt-3">
              {(byDate.get(dayList) ?? []).map((s) => (
                <li key={s.id} className="flex items-center gap-2 py-1.5 text-sm">
                  <button onClick={() => openEditor(dayList, s)} className="flex min-w-0 flex-1 items-baseline text-left">
                    <span
                      className="mr-1.5 inline-block h-2.5 w-2.5 shrink-0 self-center rounded-full"
                      style={{ backgroundColor: s.job_color || "var(--vermilion)" }}
                    />
                    <span className="shrink-0">{s.job_name}</span>
                    <span className="leader" />
                    <span className="dot shrink-0 tabular-nums">
                      {minToHHMM(s.start_min)}〜{minToHHMM(s.end_min)}
                    </span>
                    <span className="dot ml-2 shrink-0 tabular-nums text-sage">{fmtYen(s.pay)}</span>
                  </button>
                  <button
                    onClick={async () => {
                      await removeById(s.id);
                      setDayList(null);
                    }}
                    className="shrink-0 px-1 text-xs text-vermilion"
                    aria-label="削除"
                  >
                    ✕
                  </button>
                </li>
              ))}
            </ul>
            <button
              onClick={() => openEditor(dayList, null)}
              className="dot mt-3 w-full rounded-md border border-ink py-2.5 text-sm"
            >
              ＋ この日にシフトを追加（掛け持ちOK）
            </button>
          </div>
        </div>
      )}

      {/* 日タップ編集シート */}
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
                  value={start}
                  onChange={(e) => setStart(e.target.value)}
                  className="min-w-0 flex-1 rounded-md border border-rule bg-paper px-3 py-2 text-base"
                />
                <span className="dot shrink-0">〜</span>
                <input
                  type="time"
                  value={end}
                  onChange={(e) => setEnd(e.target.value)}
                  className="min-w-0 flex-1 rounded-md border border-rule bg-paper px-3 py-2 text-base"
                />
              </div>
              <label className="flex items-center gap-2 text-sm">
                <span className="dot text-xs text-ink-faint">休憩(分)</span>
                <input
                  type="number"
                  inputMode="numeric"
                  value={brk}
                  onChange={(e) => setBrk(e.target.value)}
                  className="w-20 rounded-md border border-rule bg-paper px-3 py-2 text-base tabular-nums"
                />
              </label>
            </div>
            <div className="mt-4 flex gap-2">
              {editShiftId && (
                <button
                  onClick={removeShift}
                  disabled={busy}
                  className="rounded-md border border-vermilion px-4 py-3 text-sm text-vermilion"
                >
                  削除
                </button>
              )}
              <button
                onClick={saveShift}
                disabled={busy}
                className="dot flex-1 rounded-md bg-vermilion py-3 text-base text-card shadow-[0_2px_0_var(--vermilion-deep)]"
              >
                {busy ? "・・・" : "保存"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
