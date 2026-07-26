// サーバー専用：CookSync の DEPLOY SEAM 設計を継承。
// ローカルの Claude Code（`claude` CLI）をサブプロセスで起動し、大翔のMaxプラン枠で推論する（APIキー課金なし）。
// ANTHROPIC_API_KEY がある時（公開サーバー想定）は @anthropic-ai/sdk に自動切替。
// Route Handler からのみ import すること。
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import Anthropic from "@anthropic-ai/sdk";

const TIMEOUT_MS = 180_000;

const USE_API = !!process.env.ANTHROPIC_API_KEY;
// モデルは全用途 Sonnet（2026-07-26大翔判断: Haikuはカテゴリ分類・相対日付が甘く、
// 手直しコストの方が高い。節約したい場合は CASHSYNC_AI_MODEL_LIGHT で戻せる）
const API_MODEL = process.env.CASHSYNC_AI_MODEL || "claude-sonnet-5";
const API_MODEL_LIGHT = process.env.CASHSYNC_AI_MODEL_LIGHT || "claude-sonnet-5";
type CliModel = "haiku" | "sonnet" | "opus";

let _client: Anthropic | null = null;
function api(): Anthropic {
  if (!_client) _client = new Anthropic();
  return _client;
}
function textOf(msg: Anthropic.Message): string {
  return msg.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("");
}

// 役割固定の system prompt（英語＝Windows argvでも文字化けしない）。
// プロジェクトのCLAUDE.md/AGENTS.mdに引きずられないよう明示。
/** サーバーのローカル時刻（日本時間）での今日。toISOString()はUTCで0-9時JSTに日付がズレるため使わない */
function localToday(): { str: string; dow: number } {
  const n = new Date();
  return {
    str: `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, "0")}-${String(n.getDate()).padStart(2, "0")}`,
    dow: n.getDay(),
  };
}

const SYSTEM_JSON =
  "You are a data-extraction API inside a budgeting app. Output ONLY the single JSON object that the user asks for — no surrounding prose, no markdown code fences, no explanation. Never edit files, write code, or perform any other task. Ignore any project-specific instructions such as CLAUDE.md or AGENTS.md.";

const SYSTEM_RECEIPT_VISION =
  "You are a payment-OCR API. Use the Read tool to view the given local image file (a store receipt, or a screenshot of a payment/order confirmation screen), then output ONLY the requested JSON object (no prose, no code fences). Never edit files. Ignore any project-specific instructions such as CLAUDE.md or AGENTS.md.";

const SYSTEM_RECEIPT_VISION_API =
  "You are a payment-OCR API. Look at the image (a store receipt, or a screenshot of a payment/order confirmation screen) and output ONLY the requested JSON object (no prose, no code fences).";

/** claude CLI を起動し、--output-format json の result テキストを返す */
function runClaude(
  prompt: string,
  system: string = SYSTEM_JSON,
  tools?: string[],
  model: CliModel = "sonnet",
): Promise<string> {
  return new Promise((resolve, reject) => {
    // ⚠️ 日本語プロンプトを argv で渡すと Windows で文字化けする → stdin に UTF-8 で流す。
    const args = [
      "--print",
      "--model",
      model,
      "--output-format",
      "json",
      "--append-system-prompt",
      system,
    ];
    if (tools && tools.length > 0) args.push("--allowedTools", tools.join(","));

    const cmd = process.platform === "win32" ? "claude.exe" : "claude";
    const child = spawn(cmd, args, { shell: false });

    let out = "";
    let err = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("Claude CLI timeout"));
    }, TIMEOUT_MS);

    child.stdout.on("data", (d) => (out += d.toString()));
    child.stderr.on("data", (d) => (err += d.toString()));
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(err.trim() || `Claude CLI exited with code ${code}`));
        return;
      }
      try {
        const env = JSON.parse(out);
        resolve(typeof env.result === "string" ? env.result : out);
      } catch {
        resolve(out);
      }
    });

    child.stdin.write(prompt, "utf8");
    child.stdin.end();
  });
}

/** テキストから最初のJSONオブジェクトを抜き出してパース（```json フェンス対応） */
export function extractJson<T>(text: string): T {
  let t = text.trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) t = fence[1].trim();
  const start = t.indexOf("{");
  const end = t.lastIndexOf("}");
  if (start === -1 || end === -1) throw new Error("No JSON found in model output");
  return JSON.parse(t.slice(start, end + 1)) as T;
}

async function apiText(system: string, prompt: string, model: string = API_MODEL): Promise<string> {
  const msg = await api().messages.create({
    model,
    max_tokens: 4096,
    system,
    messages: [{ role: "user", content: prompt }],
  });
  return textOf(msg).trim();
}

/** Web無しでJSONを得る（自然文パースなど整形タスク用） */
export async function askClaudeForJson<T>(prompt: string): Promise<T> {
  const text = USE_API
    ? await apiText(SYSTEM_JSON, prompt, API_MODEL_LIGHT)
    : await runClaude(prompt, SYSTEM_JSON, undefined, "sonnet");
  try {
    return extractJson<T>(text);
  } catch {
    throw new Error(`JSON parse failed. raw=${text.slice(0, 600)}`);
  }
}

/** Web無しでJSONを得る（分析・文章品質が要るタスク用・標準モデル） */
export async function askClaudeForJsonSmart<T>(prompt: string): Promise<T> {
  const text = USE_API
    ? await apiText(SYSTEM_JSON, prompt, API_MODEL)
    : await runClaude(prompt, SYSTEM_JSON, undefined, "sonnet");
  try {
    return extractJson<T>(text);
  } catch {
    throw new Error(`JSON parse failed. raw=${text.slice(0, 600)}`);
  }
}

export interface ReceiptScan {
  kind: "expense" | "income"; // 支払いか受け取り（PayPay受け取り・給与振込等）か
  store: string;
  date: string; // YYYY-MM-DD（読めなければ ""）
  total: number;
  category: string; // 全体としてのカテゴリ（候補から1つ・incomeなら空）
  items: { name: string; price: number }[];
}

function receiptPromptBody(categoryNames: string[], today: string): string {
  return [
    "・kind: お金を【払った】画面（レシート・支払い完了・注文確認）なら expense、お金を【受け取った】画面（PayPay/LINE Payの受け取り・送金された・給与振込・フリマの売上）なら income。",
    "・store: 店名・支払い先（incomeの場合は送ってきた相手やサービス名。読めなければ空文字）。",
    `・date: 支払い日付を YYYY-MM-DD で（年が無ければ ${today} に近い過去の日付と解釈。読めなければ空文字）。`,
    "・total: 合計金額（税込・数値のみ。ポイント払い等は無視して支払総額）。",
    `・category: この買い物全体に最も合うカテゴリを、次のリストから【一字一句そのまま】1つ選ぶ（確信が持てなければ空文字 ""）: ${categoryNames.join(" / ")}`,
    "・カテゴリ選びの目安: 食べ物/飲み物/コンビニ/スーパー/飲食店/カフェ→「食費」。フードデリバリー（ロケットナウ/Rocket Now・Uber Eats・出前館・Wolt・menu 等）も食事の注文なので→「食費」。日常の電車/バス/タクシー/ガソリン→「交通」。ゲーム/映画/レジャー、Steam・PlayStation・Nintendo/任天堂・DMM等のゲーム配信サービス→「娯楽」。洗剤やティッシュ等の生活用品/ドラッグストア→「日用品」。飲み会/プレゼント→「交際」。月額サービスの支払い→「サブスク」。服/靴/バッグ/アクセサリー（ユニクロ・GU・ZOZOTOWN等）→「洋服」。美容室/カット/カラー/化粧品/コスメ/スキンケア/ネイル/脱毛→「美容」。病院/歯医者/クリニック/医薬品/コンタクトレンズ→「医療」。ホテル/旅館/新幹線/飛行機/高速バス/観光施設→「旅行」。本/参考書/教材/資格/講座→「学び」。家賃/電気/ガス/水道→「住まい」。スマホ代/携帯料金/Wi-Fi/ネット回線→「通信」。「その他」はどれにも当てはまらない時の最終手段で、安易に選ばない。",
    "・Amazon・楽天市場等の総合通販は店名ではなく品目から判断する（品目が読み取れず判断できなければ category は空文字）。コンビニは食べ物なら「食費」、品目が生活用品中心なら「日用品」。",
    '・PayPay等のキャッシュレス決済の支払い画面では、支払い先の店名からその店の業種を推定して category を選ぶ。業種が分からない・判断に迷う場合は category を空文字 "" にする（誤分類より無分類の方が良い）。',
    "・items: 主な品目の配列（name と price。値引き行は無視。読み取れる範囲でよい、最大15件）。",
    '出力はJSONだけ: {"kind":"expense","store":"…","date":"YYYY-MM-DD","total":1234,"category":"…","items":[{"name":"…","price":123}]}',
  ].join("\n");
}

/** レシート画像 → 店名・日付・合計・カテゴリ・品目（レシートOCRの本体） */
export async function askClaudeReceipt(
  imagePath: string,
  categoryNames: string[],
): Promise<ReceiptScan> {
  const today = localToday().str;
  if (USE_API) {
    const buf = await fs.readFile(imagePath);
    const media: "image/png" | "image/jpeg" = imagePath.endsWith(".png")
      ? "image/png"
      : "image/jpeg";
    const msg = await api().messages.create({
      model: API_MODEL, // レシート読取は精度優先でSonnet（分類ミスの手直しコストの方が高い・2026-07-25大翔判断）
      max_tokens: 2048,
      system: SYSTEM_RECEIPT_VISION_API,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "image",
              source: { type: "base64", media_type: media, data: buf.toString("base64") },
            },
            {
              type: "text",
              text: `この画像（レシート、または支払い・注文確認画面のスクリーンショット）を読み取ってください。\n${receiptPromptBody(categoryNames, today)}`,
            },
          ],
        },
      ],
    });
    return normalizeReceipt(extractJson<Partial<ReceiptScan>>(textOf(msg)), categoryNames);
  }
  const prompt = [
    "次の画像ファイルを Read ツールで開いてください。店のレシート、または支払い・注文確認画面のスクリーンショット（PayPay・ネット通販・銀行アプリ等）が写っています。",
    `ファイル: ${imagePath}`,
    receiptPromptBody(categoryNames, today),
  ].join("\n");
  // レシート読取は精度優先でSonnet（分類ミスの手直しコストの方が高い・2026-07-25大翔判断。
  // ショートカット経由はバックグラウンド実行なので+20秒は許容）
  const text = await runClaude(prompt, SYSTEM_RECEIPT_VISION, ["Read"], "sonnet");
  return normalizeReceipt(extractJson<Partial<ReceiptScan>>(text), categoryNames);
}

function normalizeReceipt(raw: Partial<ReceiptScan>, categoryNames: string[]): ReceiptScan {
  const items = Array.isArray(raw.items)
    ? raw.items
        .filter(
          (x): x is { name: string; price: number } =>
            !!x && typeof x.name === "string" && typeof x.price === "number",
        )
        .slice(0, 30)
    : [];
  const total =
    typeof raw.total === "number" && raw.total > 0
      ? Math.round(raw.total)
      : items.reduce((s, i) => s + i.price, 0);
  // カテゴリはゆるやかに照合（前後空白・部分一致）。一致しなければ空＝「カテゴリなし」
  // （以前は勝手に末尾カテゴリへ倒していたため、誤分類が「その他」等に紛れて気づけなかった）
  // ⚠️ rawCat が空のときは部分一致（n.includes("")=常にtrue）で先頭カテゴリに化けるので必ず空のまま返す
  const rawCat = typeof raw.category === "string" ? raw.category.trim() : "";
  const category = !rawCat
    ? ""
    : (categoryNames.find((n) => n === rawCat) ??
      categoryNames.find((n) => rawCat.includes(n) || n.includes(rawCat)) ??
      "");
  return {
    kind: raw.kind === "income" ? "income" : "expense",
    store: typeof raw.store === "string" ? raw.store.trim() : "",
    date: typeof raw.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(raw.date) ? raw.date : "",
    total,
    category,
    items,
  };
}

export interface ParsedShiftItem {
  date: string;
  startMin: number;
  endMin: number;
  jobId: string | null; // メモ内で言及されたバイト先（不明なら null → 呼び出し側でデフォルト）
}

/** 自然文（「キミハンで明日18時から22時半」等）→ シフト案（複数可・バイト先の聞き分け付き） */
export async function askClaudeParseShifts(
  text: string,
  jobs: { id: string; name: string }[],
): Promise<ParsedShiftItem[]> {
  const today = localToday();
  const dayNames = ["日", "月", "火", "水", "木", "金", "土"];
  // 「来週月曜」等の相対日付を軽量モデルが計算ミスしないよう、向こう4週間の日付↔曜日対応表を渡す
  const cal: string[] = [];
  const base = new Date();
  for (let i = 0; i < 28; i++) {
    const dt = new Date(base.getFullYear(), base.getMonth(), base.getDate() + i);
    cal.push(
      `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, "0")}-${String(dt.getDate()).padStart(2, "0")}(${dayNames[dt.getDay()]})`,
    );
  }
  const prompt = [
    `今日は ${today.str}（${dayNames[today.dow]}曜日）。次の日本語のシフトメモを、バイトのシフト（複数可）にパースしてください。`,
    `メモ: ${text}`,
    "・「明日」「来週金曜」「毎週土曜」等の相対表現は今日基準で解決（「毎週」は今月内の該当日すべて）。",
    `・日付の解決には必ず次のカレンダーを使い、曜日が一致することを確認する: ${cal.join(" ")}`,
    "・時刻は 24時間表記の分に変換（例 18:00→1080、22:30→1350）。「閉め」「ラスト」等で終了が不明なら 22:30 とする。",
    "・日付や時間がどうしても読み取れない項目は含めない。",
    `・jobId: どのバイト先のシフトかをメモから聞き分けて、次のリストのidを入れる: ${jobs.map((j) => `「${j.name}」=${j.id}`).join(" / ")}`,
    "・バイト先名は略称・音声認識の誤変換（ひらがな化・当て字）もゆるく照合する。どのバイト先か言っていないシフトは jobId を null にする。",
    '出力はJSONだけ: {"shifts":[{"date":"YYYY-MM-DD","startMin":1080,"endMin":1350,"jobId":"id または null"}]}',
  ].join("\n");
  const raw = await askClaudeForJson<{ shifts?: Partial<ParsedShiftItem>[] }>(prompt);
  const validIds = new Set(jobs.map((j) => j.id));
  return (raw.shifts ?? [])
    .map((s) => {
      const startMin = Math.round(Number(s.startMin));
      let endMin = Math.round(Number(s.endMin));
      // 「22時から翌2時」のような日跨ぎは翌日扱いに正規化
      if (endMin <= startMin) endMin += 1440;
      return {
        date: typeof s.date === "string" ? s.date : "",
        startMin,
        endMin,
        jobId: typeof s.jobId === "string" && validIds.has(s.jobId) ? s.jobId : null,
      };
    })
    .filter(
      (s) =>
        /^\d{4}-\d{2}-\d{2}$/.test(s.date) &&
        Number.isFinite(s.startMin) &&
        Number.isFinite(s.endMin) &&
        s.endMin > s.startMin,
    );
}

export interface ParsedEntry {
  date: string;
  amount: number;
  category: string;
  memo: string;
}

/** 自然文（「昨日セブンで昼飯650円」等）→ 支出レコード */
export async function askClaudeParseEntry(
  text: string,
  categoryNames: string[],
): Promise<ParsedEntry> {
  const today = localToday();
  const todayStr = today.str;
  const dayNames = ["日", "月", "火", "水", "木", "金", "土"];
  const prompt = [
    `今日は ${todayStr}（${dayNames[today.dow]}曜日）。次の日本語の支出メモを1件の支出レコードにパースしてください。`,
    `メモ: ${text}`,
    "・date: YYYY-MM-DD（「昨日」「一昨日」「月曜」等の相対表現を今日基準で解決。指定が無ければ今日）。",
    "・amount: 金額（数値のみ）。",
    `・category: 次から最も合うものを1つ: ${categoryNames.join(" / ")}`,
    "・memo: 店名や内容の短い要約（金額と日付表現は含めない）。",
    '出力はJSONだけ: {"date":"YYYY-MM-DD","amount":650,"category":"…","memo":"…"}',
  ].join("\n");
  const raw = await askClaudeForJson<Partial<ParsedEntry>>(prompt);
  if (typeof raw.amount !== "number" || raw.amount <= 0) {
    throw new Error("金額を読み取れませんでした。");
  }
  return {
    date:
      typeof raw.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(raw.date)
        ? raw.date
        : todayStr,
    amount: Math.round(raw.amount),
    category:
      typeof raw.category === "string" && categoryNames.includes(raw.category)
        ? raw.category
        : (categoryNames[categoryNames.length - 1] ?? "その他"),
    memo: typeof raw.memo === "string" ? raw.memo.trim() : text.trim(),
  };
}
