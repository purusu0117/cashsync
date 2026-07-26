"use client";

// 手入力 ＋ 自然文/音声入力（「昨日セブンで昼飯650円」→AIパース→確認→保存）
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { fmtYen, todayLocal } from "@/lib/format";

interface Category {
  id: string;
  name: string;
  icon: string;
}

// Web Speech API（iOS Safariは不安定なので progressive enhancement）
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

export default function AddPage() {
  const router = useRouter();
  const [categories, setCategories] = useState<Category[]>([]);
  const [amount, setAmount] = useState("");
  const [date, setDate] = useState(todayLocal());
  const [categoryId, setCategoryId] = useState<string | null>(null);
  const [memo, setMemo] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const [text, setText] = useState("");
  const [parsing, setParsing] = useState(false);
  const [listening, setListening] = useState(false);
  const [speechOk, setSpeechOk] = useState(false);
  const [showTextInput, setShowTextInput] = useState(false);
  const [parsedNote, setParsedNote] = useState(""); // 音声/文章→フォーム反映済みの案内
  const recRef = useRef<SpeechRecognitionLike | null>(null);

  useEffect(() => {
    // つけ忘れ赦免カード等からの ?date=YYYY-MM-DD 指定
    const qd = new URLSearchParams(location.search).get("date");
    if (qd && /^\d{4}-\d{2}-\d{2}$/.test(qd)) setDate(qd);
    fetch("/api/categories")
      .then((r) => r.json())
      .then((d) => {
        setCategories(d.categories ?? []);
        if (d.categories?.[0]) setCategoryId(d.categories[0].id);
      });
    const w = window as unknown as {
      SpeechRecognition?: new () => SpeechRecognitionLike;
      webkitSpeechRecognition?: new () => SpeechRecognitionLike;
    };
    setSpeechOk(!!(w.SpeechRecognition || w.webkitSpeechRecognition));
  }, []);

  // 録音は「自分でタップして止めるまで」続ける（無音でOSが切っても自動で再開）。止めたら全文を解析。
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
        try {
          rec.start(); // 無音で切られた → ユーザーが止めるまで再開
          return;
        } catch {
          /* 再開不可なら確定へ */
        }
      }
      setListening(false);
      const t = finalTextRef.current.trim();
      setLiveText("");
      if (t) {
        setText(t);
        parseText(t);
      }
    };
    rec.onerror = () => {
      /* onendで処理 */
    };
    recRef.current = rec;
    setListening(true);
    rec.start();
  }

  async function parseText(input?: string) {
    const t = (input ?? text).trim();
    if (!t) return;
    setParsing(true);
    setError("");
    setParsedNote("");
    try {
      const res = await fetch("/api/parse-entry", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: t }),
      });
      const d = await res.json();
      if (!res.ok) throw new Error(d.error ?? "解析に失敗しました。");
      setAmount(String(d.parsed.amount));
      setDate(d.parsed.date);
      setMemo(d.parsed.memo);
      if (d.categoryId) setCategoryId(d.categoryId);
      setParsedNote(`「${t}」を下のフォームに入れました。確認して記録ボタンを押してください。`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "解析に失敗しました。");
    } finally {
      setParsing(false);
    }
  }

  async function save() {
    const n = Math.round(Number(amount));
    if (!Number.isFinite(n) || n <= 0) {
      setError("金額を入力してください。");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const res = await fetch("/api/expenses", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ amount: n, date, categoryId, memo, source: text ? "text" : "manual" }),
      });
      const d = await res.json();
      if (!res.ok) throw new Error(d.error ?? "保存に失敗しました。");
      router.push("/");
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "保存に失敗しました。");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      <h1 className="dot text-lg">支出を記録</h1>

      {/* 音声/文章で入力（マイクが主役：話す→自動でフォームに反映） */}
      <section className="zig zig-t zig-b px-4 py-4 shadow-sm">
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
              {listening ? "録音中… タップで確定" : parsing ? "AIが解析中・・・" : "話して記録"}
            </span>
            <span className={`block text-[11px] ${listening || parsing ? "" : "opacity-80"}`}>
              {listening
                ? "全部話し終わったら、もう一度ここをタップ"
                : parsing
                  ? "そのままお待ちください"
                  : "話し終わったら自分でタップして確定する方式です"}
            </span>
          </button>
        )}
        {listening && liveText && (
          <p className="mt-2 rounded-md border border-rule bg-paper px-3 py-2 text-sm text-ink">{liveText}</p>
        )}
        {speechOk && !showTextInput ? (
          <button
            onClick={() => setShowTextInput(true)}
            className="mt-2 w-full text-center text-[11px] text-ink-faint underline underline-offset-2"
          >
            💬 文章で書いて変換する（例：昨日セブンで650円）
          </button>
        ) : (
          <div className="mt-2 flex gap-2">
            <input
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && parseText()}
              placeholder="昨日セブンで昼飯650円"
              className="min-w-0 flex-1 rounded-md border border-rule bg-paper px-3 py-2 text-base outline-none focus:border-ink"
            />
            <button
              onClick={() => parseText()}
              disabled={parsing || !text.trim()}
              className="dot shrink-0 rounded-md border border-ink px-4 text-sm disabled:opacity-40"
            >
              {parsing ? "…" : "変換"}
            </button>
          </div>
        )}
        {parsedNote && <p className="mt-2 text-[11px] text-sage">✓ {parsedNote}</p>}
      </section>

      {/* 手入力フォーム */}
      <section className="zig zig-t zig-b px-4 py-4 shadow-sm space-y-3">
        <h2 className="dot text-xs text-ink-faint">手入力フォーム</h2>
        <label className="block">
          <span className="dot text-xs text-ink-faint">金額</span>
          <input
            type="number"
            inputMode="numeric"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            placeholder="0"
            className="dot mt-1 w-full rounded-md border border-rule bg-paper px-3 py-2.5 text-3xl tabular-nums outline-none focus:border-ink"
          />
        </label>
        <label className="block">
          <span className="dot text-xs text-ink-faint">日付</span>
          <input
            type="date"
            value={date}
            onChange={(e) => setDate(e.target.value)}
            className="mt-1 w-full rounded-md border border-rule bg-paper px-3 py-2.5 text-base outline-none focus:border-ink"
          />
        </label>
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
        <label className="block">
          <span className="dot text-xs text-ink-faint">メモ（任意）</span>
          <input
            value={memo}
            onChange={(e) => setMemo(e.target.value)}
            placeholder="セブンイレブン"
            className="mt-1 w-full rounded-md border border-rule bg-paper px-3 py-2.5 text-base outline-none focus:border-ink"
          />
        </label>
        {error && <p className="text-sm text-vermilion">{error}</p>}
        <button
          onClick={save}
          disabled={busy}
          className="dot w-full rounded-md bg-vermilion py-3 text-lg text-card shadow-[0_2px_0_var(--vermilion-deep)] active:translate-y-0.5 active:shadow-none disabled:opacity-50"
        >
          {busy ? "保存中・・・" : amount ? `${fmtYen(Number(amount))} で記録` : "記録する"}
        </button>
      </section>
    </div>
  );
}
