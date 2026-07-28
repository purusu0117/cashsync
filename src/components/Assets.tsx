"use client";

// 資産・口座残高の手動管理＋純資産＋推移（グラフタブ内の「資産」ビュー）。
// 銀行連携なしの手入力でストック（資産）を可視化する。既存の支出フロー計算とは独立。
import { useCallback, useEffect, useState } from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import Loading from "@/components/Loading";
import { apiCall, apiJson } from "@/lib/clientApi";
import { cachedFetch } from "@/lib/cachedFetch";
import { fmtMonthJa, fmtYen } from "@/lib/format";

const SAGE = "#2f8f5b"; // 資産のデータカラー（datavizの緑系）

type Kind = "bank" | "cash" | "emoney" | "securities" | "debt";

interface Account {
  id: string;
  name: string;
  kind: Kind;
  balance: number;
  sort: number;
}
interface TrendPoint {
  month: string;
  netWorth: number;
}
interface Overview {
  accounts: Account[];
  netWorth: number;
  prevNetWorth: number | null;
  trend: TrendPoint[];
}

const KINDS: { key: Kind; label: string }[] = [
  { key: "bank", label: "銀行" },
  { key: "cash", label: "現金" },
  { key: "emoney", label: "電子マネー" },
  { key: "securities", label: "証券" },
  { key: "debt", label: "負債" },
];
const KIND_LABEL: Record<Kind, string> = Object.fromEntries(
  KINDS.map((k) => [k.key, k.label]),
) as Record<Kind, string>;

function KindIcon({ kind, className }: { kind: Kind; className?: string }) {
  const p = { className, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.8 };
  switch (kind) {
    case "bank":
      return (
        <svg {...p}>
          <path d="M4 9 12 4l8 5" strokeLinejoin="round" />
          <path d="M5 9v8m4-8v8m6-8v8m4-8v8M3 20h18" strokeLinecap="round" />
        </svg>
      );
    case "cash":
      return (
        <svg {...p}>
          <rect x="3" y="6" width="18" height="12" rx="2" />
          <circle cx="12" cy="12" r="2.5" />
        </svg>
      );
    case "emoney":
      return (
        <svg {...p}>
          <rect x="3" y="5" width="18" height="14" rx="2" />
          <path d="M3 10h18" />
        </svg>
      );
    case "securities":
      return (
        <svg {...p}>
          <path d="M4 16l4-4 3 3 5-6" strokeLinecap="round" strokeLinejoin="round" />
          <path d="M15 9h3v3" strokeLinecap="round" strokeLinejoin="round" />
          <path d="M4 20h16" strokeLinecap="round" />
        </svg>
      );
    case "debt":
      return (
        <svg {...p}>
          <circle cx="12" cy="12" r="8.5" />
          <path d="M8.5 12h7" strokeLinecap="round" />
        </svg>
      );
  }
}

const EMPTY_FORM = { name: "", kind: "bank" as Kind, balance: "" };

export default function Assets() {
  const [data, setData] = useState<Overview | null>(null);
  const [ready, setReady] = useState(false);
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [form, setForm] = useState(EMPTY_FORM);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  // 資産(口座残高)更新リマインド（1〜28＝毎月その日／-1＝しない）。手入力なので任意で促す。
  const [reminderDay, setReminderDay] = useState(-1);
  const [reminderSaved, setReminderSaved] = useState(false);

  const load = useCallback(async () => {
    await cachedFetch<Overview>("/api/accounts", (d) => {
      setData(d);
      setReady(true);
    }).catch(() => setReady(true));
  }, []);

  useEffect(() => {
    load();
    cachedFetch<{ assetReminderDay?: number }>("/api/profile", (d) => {
      setReminderDay(d.assetReminderDay ?? -1);
    }).catch(() => {});
  }, [load]);

  async function saveReminderDay(day: number) {
    const prev = reminderDay;
    setReminderDay(day); // 先に反映して待たせない
    try {
      await apiCall("/api/profile", apiJson({ assetReminderDay: day }));
      setReminderSaved(true);
      setTimeout(() => setReminderSaved(false), 2500);
    } catch {
      setReminderDay(prev);
    }
  }

  function openAdd() {
    setEditing(null);
    setForm(EMPTY_FORM);
    setAdding(true);
    setError("");
  }
  function openEdit(a: Account) {
    setAdding(false);
    setEditing(a.id);
    setForm({ name: a.name, kind: a.kind, balance: String(a.balance) });
    setError("");
  }
  function closeForm() {
    setAdding(false);
    setEditing(null);
    setForm(EMPTY_FORM);
    setError("");
  }

  async function save() {
    const name = form.name.trim();
    if (!name) {
      setError("名前を入力してください。");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const body = { name, kind: form.kind, balance: Number(form.balance) || 0 };
      if (editing) {
        await apiCall("/api/accounts", apiJson({ id: editing, ...body }, "PUT"));
      } else {
        await apiCall("/api/accounts", apiJson(body, "POST"));
      }
      closeForm();
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "保存に失敗しました。");
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!editing) return;
    setBusy(true);
    setError("");
    try {
      await apiCall(`/api/accounts?id=${encodeURIComponent(editing)}`, { method: "DELETE" });
      closeForm();
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "削除に失敗しました。");
    } finally {
      setBusy(false);
    }
  }

  if (!ready) return <Loading label="集計中・・・" />;

  const accounts = data?.accounts ?? [];
  const netWorth = data?.netWorth ?? 0;
  const prev = data?.prevNetWorth ?? null;
  const diff = prev === null ? null : netWorth - prev;
  const trend = data?.trend ?? [];

  return (
    <div className="space-y-4">
      {/* 純資産の合計＋前月比 */}
      <section className="zig zig-t zig-b px-5 py-5 text-center shadow-sm">
        <h2 className="dot text-sm tracking-[0.1em] text-ink-faint">純資産（資産−負債）</h2>
        <p
          className={`dot mt-1 text-3xl tabular-nums ${netWorth < 0 ? "text-vermilion" : "text-sage"}`}
        >
          {fmtYen(netWorth)}
        </p>
        {diff !== null ? (
          <p className="mt-1 text-xs">
            <span className="text-ink-faint">前月比 </span>
            <span className={`dot tabular-nums ${diff < 0 ? "text-vermilion" : "text-sage"}`}>
              {diff >= 0 ? "+" : "−"}
              {fmtYen(Math.abs(diff))}
            </span>
          </p>
        ) : (
          <p className="mt-1 text-[11px] text-ink-faint">前月の記録がたまると前月比が出ます</p>
        )}
      </section>

      {accounts.length === 0 ? (
        // 空状態
        <section className="zig zig-t zig-b px-5 py-8 text-center shadow-sm">
          <p className="text-sm text-ink-faint">
            口座を追加すると、純資産と推移が見られます。
          </p>
          <button
            onClick={openAdd}
            className="dot mt-4 rounded-md bg-vermilion px-5 py-2.5 text-sm text-card shadow-[0_2px_0_var(--vermilion-deep)] active:translate-y-0.5"
          >
            ＋ 口座を追加
          </button>
          {adding && (
            <div className="mt-4 text-left">
              <AccountForm
                form={form}
                setForm={setForm}
                onSave={save}
                onCancel={closeForm}
                busy={busy}
                error={error}
              />
            </div>
          )}
        </section>
      ) : (
        <>
          {/* 純資産の推移 */}
          <section className="zig zig-t zig-b px-3 py-4 shadow-sm">
            <h2 className="dot px-2 text-sm tracking-[0.1em]">純資産の推移</h2>
            {trend.length <= 1 ? (
              <p className="mt-3 px-2 text-[11px] text-ink-faint">
                まだ{trend.length === 1 ? "1ヶ月分" : "データ"}だけです。翌月以降の残高を記録すると推移が見えてきます。
              </p>
            ) : (
              <div className="mt-2 h-44">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={trend} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
                    <CartesianGrid vertical={false} stroke="var(--rule)" strokeDasharray="2 4" />
                    <XAxis
                      dataKey="month"
                      tickFormatter={(m: string) => `${Number(m.slice(5))}月`}
                      tick={{ fontSize: 10, fill: "var(--ink-faint)" }}
                      axisLine={{ stroke: "var(--rule)" }}
                      tickLine={false}
                    />
                    <YAxis
                      tickFormatter={(v: number) =>
                        Math.abs(v) >= 10000 ? `${Math.round(v / 1000) / 10}万` : String(v)
                      }
                      tick={{ fontSize: 10, fill: "var(--ink-faint)" }}
                      axisLine={false}
                      tickLine={false}
                      width={40}
                    />
                    <Tooltip
                      cursor={{ fill: "rgba(33,29,24,0.05)" }}
                      content={({ active, payload, label }) => {
                        if (!active || !payload?.length) return null;
                        const p = payload[0].payload as TrendPoint;
                        return (
                          <div className="zig zig-b rounded-t-sm px-3 py-2 text-xs shadow-md">
                            <p className="dot">{fmtMonthJa(String(label))}</p>
                            <p style={{ color: SAGE }}>純資産 {fmtYen(p.netWorth)}</p>
                          </div>
                        );
                      }}
                    />
                    <Bar dataKey="netWorth" fill={SAGE} radius={[1, 1, 0, 0]} maxBarSize={22} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            )}
          </section>

          {/* 口座一覧 */}
          <section className="zig zig-t zig-b px-5 py-4 shadow-sm">
            <h2 className="dot text-sm tracking-[0.1em]">口座</h2>
            <ul className="mt-3 space-y-2.5">
              {accounts.map((a) => (
                <li key={a.id}>
                  <button
                    onClick={() => (editing === a.id ? closeForm() : openEdit(a))}
                    className="flex w-full items-baseline text-left text-sm"
                  >
                    <KindIcon kind={a.kind} className="mr-1.5 h-4 w-4 shrink-0 self-center text-ink-faint" />
                    <span>{a.name}</span>
                    <span className="ml-1.5 text-[10px] text-ink-faint">{KIND_LABEL[a.kind]}</span>
                    <span className="leader" />
                    <span
                      className={`dot text-[15px] tabular-nums ${a.kind === "debt" ? "text-vermilion" : ""}`}
                    >
                      {a.kind === "debt" ? fmtYen(-a.balance) : fmtYen(a.balance)}
                    </span>
                  </button>
                  {editing === a.id && (
                    <div className="mt-2">
                      <AccountForm
                        form={form}
                        setForm={setForm}
                        onSave={save}
                        onCancel={closeForm}
                        onDelete={remove}
                        busy={busy}
                        error={error}
                      />
                    </div>
                  )}
                </li>
              ))}
            </ul>
            <div className="cutline mt-3 pt-3">
              {adding ? (
                <AccountForm
                  form={form}
                  setForm={setForm}
                  onSave={save}
                  onCancel={closeForm}
                  busy={busy}
                  error={error}
                />
              ) : (
                <button
                  onClick={openAdd}
                  className="dot w-full rounded-md border border-ink py-2.5 text-sm"
                >
                  ＋ 口座を追加
                </button>
              )}
            </div>
            <div className="barcode mt-5" />
          </section>

          {/* 残高更新リマインド。資産は手入力なので、任意で毎月の更新日を通知する */}
          <section className="zig zig-t zig-b px-5 py-4 shadow-sm">
            <div className="flex items-center justify-between">
              <h2 className="dot text-sm tracking-[0.1em]">残高更新リマインド</h2>
              {reminderSaved && <span className="text-[11px] text-sage">保存しました</span>}
            </div>
            <p className="mt-0.5 text-[11px] leading-relaxed text-ink-faint">
              残高は手入力です。毎月この日に「残高を更新しましょう」とお知らせします。通知がONのときに届きます。
            </p>
            <select
              value={String(reminderDay)}
              onChange={(e) => saveReminderDay(Number(e.target.value))}
              className="mt-2 w-full rounded-md border border-rule bg-card px-3 py-2.5 text-sm"
            >
              <option value="-1">リマインドしない</option>
              {Array.from({ length: 28 }, (_, i) => i + 1).map((day) => (
                <option key={day} value={day}>
                  毎月 {day}日
                </option>
              ))}
            </select>
          </section>
        </>
      )}
    </div>
  );
}

function AccountForm({
  form,
  setForm,
  onSave,
  onCancel,
  onDelete,
  busy,
  error,
}: {
  form: { name: string; kind: Kind; balance: string };
  setForm: (f: { name: string; kind: Kind; balance: string }) => void;
  onSave: () => void;
  onCancel: () => void;
  onDelete?: () => void;
  busy: boolean;
  error: string;
}) {
  return (
    <div className="space-y-2 rounded-md border border-rule bg-paper p-3">
      <input
        value={form.name}
        onChange={(e) => setForm({ ...form, name: e.target.value })}
        placeholder="口座名（例：三井住友銀行）"
        className="w-full rounded-md border border-rule bg-card px-3 py-1.5 text-sm outline-none focus:border-ink"
      />
      <div className="flex flex-wrap gap-1.5">
        {KINDS.map((k) => (
          <button
            key={k.key}
            onClick={() => setForm({ ...form, kind: k.key })}
            aria-pressed={form.kind === k.key}
            className={`dot rounded-md px-2.5 py-1 text-xs ${
              form.kind === k.key ? "bg-ink text-card" : "border border-rule text-ink-faint"
            }`}
          >
            {k.label}
          </button>
        ))}
      </div>
      <div className="flex items-baseline gap-2">
        <span className="text-sm text-ink-faint">
          {form.kind === "debt" ? "残高（借りている額）" : "残高"}
        </span>
        <input
          type="number"
          inputMode="numeric"
          value={form.balance}
          onChange={(e) => setForm({ ...form, balance: e.target.value })}
          placeholder="0"
          className="min-w-0 flex-1 rounded-md border border-rule bg-card px-3 py-1.5 text-right text-sm tabular-nums outline-none focus:border-ink"
        />
        <span className="text-sm text-ink-faint">円</span>
      </div>
      {error && <p className="text-xs text-vermilion">{error}</p>}
      <div className="flex gap-2">
        <button
          onClick={onSave}
          disabled={busy}
          className="dot flex-1 rounded-md bg-vermilion py-2 text-sm text-card shadow-[0_2px_0_var(--vermilion-deep)] active:translate-y-0.5 disabled:opacity-50"
        >
          {busy ? "・・・" : "保存"}
        </button>
        <button
          onClick={onCancel}
          disabled={busy}
          className="dot rounded-md border border-rule px-4 py-2 text-sm text-ink-faint"
        >
          やめる
        </button>
        {onDelete && (
          <button
            onClick={onDelete}
            disabled={busy}
            className="dot rounded-md border border-vermilion px-4 py-2 text-sm text-vermilion"
          >
            削除
          </button>
        )}
      </div>
    </div>
  );
}
