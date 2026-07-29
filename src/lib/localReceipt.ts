// 自前（AI API 無し）のレシート/決済スクショ解析。OCRテキスト→ReceiptScan の純関数。
// OCRエンジン非依存（Tesseract / Apple Vision / ML Kit で共通）。
//   parseReceiptText(text, categoryNames, today) -> ReceiptScan
import type { ReceiptScan } from "./ai";

// ---- 前処理 -------------------------------------------------------------

/** 全角→半角、通貨記号の誤読補正（¥←\,Y\,￥ ／ 円←mn等）、CJK文字間の余分スペース除去。 */
export function normalizeText(raw: string): string {
  let t = raw
    .replace(/[Ａ-Ｚａ-ｚ０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/[，、]/g, ",")
    .replace(/[．]/g, ".")
    .replace(/[￥]/g, "¥")
    .replace(/[（]/g, "(")
    .replace(/[）]/g, ")")
    .replace(/[　]/g, " ");
  // Tesseractの通貨誤読補正：数字直前の \ / Y\ / Y¥ / y / Y を ¥ に
  t = t.replace(/(?:Y\s*)?[\\￥]\s*(?=\d)/g, "¥");
  t = t.replace(/\b[yY](?=[\d.,])/g, "¥"); // ¥をy/Yと誤読
  t = t.replace(/¥\s*[lI|](?=\d)/g, "¥"); // ¥直後の l/I/| は 1 の誤読ノイズ→除去
  t = t.replace(/(\d)[。．｡・･]+(?=[\d,])/g, "$1"); // 数字間に混入する中黒/句点を除去（6。,100→6,100）
  t = t.replace(/(\d{1,3})\.(\d{3})(?!\d)/g, "$1,$2"); // 千区切りのカンマを . と誤読（円は整数）
  // 「円」を "mn"/"m円"/"内" 等と誤読するケース：数字直後の mn/rn を 円 に（"ml"=500mlは除外）
  t = t.replace(/(\d)\s*(?:mn|rn|m円|内)\b/g, "$1円");
  // CJK文字に挟まれた空白を除去（日本語OCRは字ごとに空白を入れがち）
  const CJK = "\\u3040-\\u30ff\\u3400-\\u9fff\\uff66-\\uff9f";
  const re = new RegExp(`([${CJK}])[ \\t]+(?=[${CJK}])`, "g");
  for (let i = 0; i < 3; i++) t = t.replace(re, "$1");
  return t;
}

/** スマホのステータスバー行（左上の時計＋電波/電池）を落とす。 */
function isStatusBar(line: string): boolean {
  if (/^\s*\d{1,2}:\d{2}\b/.test(line)) return true; // 先頭が時刻
  if (/^[\s\d:]*(5G|4G|LTE|Wi-?Fi)?\s*\d{1,3}%/.test(line) && line.length <= 16) return true;
  return false;
}

/** 通貨マーカー付き金額（¥/円/カンマ）を抽出。OCRで数字内に混入した空白・カンマは除去して数値化。 */
function moneyIn(line: string): number[] {
  const out: number[] = [];
  const push = (raw: string) => {
    const n = Number(raw.replace(/[\s,]/g, ""));
    if (Number.isFinite(n) && n > 0 && n <= 9_999_999) out.push(n);
  };
  let m: RegExpExecArray | null;
  // ¥ 前置（数字内の空白・カンマを許容して後で除去。"¥3 79"→379 等）
  const re1 = /¥\s*(\d[\d\s,]{0,8}\d|\d)/g;
  while ((m = re1.exec(line))) push(m[1]);
  // 円 後置
  const re2 = /(\d[\d\s,]{0,8}\d|\d)\s*円/g;
  while ((m = re2.exec(line))) push(m[1]);
  // カンマ区切り（マーカー無しでも桁区切りがあれば金額とみなす）
  const re3 = /(\d{1,3}(?:,\d{3})+)/g;
  while ((m = re3.exec(line))) push(m[1]);
  return out;
}

/** マーカー無しの裸の整数（¥がOCRで消えた大きな金額の保険）。番号・電話・日付・年は除外。 */
function bareCandidates(line: string): number[] {
  if (/(番号|受付|決済|コード|TEL|電話|注文日|会員|No\.?|ID)/i.test(line)) return [];
  if (/\d{2,4}[年/\-.]\d{1,2}[月/\-.]\d{1,2}/.test(line)) return []; // 日付行
  const out: number[] = [];
  const re = /(?<![\d,])(\d{3,7})(?![\d,])/g; // 3〜7桁の独立した整数
  let m: RegExpExecArray | null;
  while ((m = re.exec(line))) {
    const n = Number(m[1]);
    if (n >= 100 && n <= 9_999_999 && !/^(19|20)\d{2}$/.test(m[1])) out.push(n); // 年(19xx/20xx)は除外
  }
  return out;
}

// ---- 合計 ---------------------------------------------------------------

const TOTAL_KEYS = ["合計", "ご請求", "請求金額", "請求額", "お会計", "お支払い金額", "お支払金額", "支払金額", "支払合計", "総額", "お支払い額"];
const NEG_KEYS = /(小計|税|お預|預り|釣|おつり|ポイント|point|値引|割引|残高|手数料|お客様)/i;

function amtNear(lines: string[], i: number): number {
  const here = moneyIn(lines[i]);
  if (here.length) return Math.max(...here);
  for (let j = 1; j <= 2 && i + j < lines.length; j++) {
    const a = moneyIn(lines[i + j]);
    if (a.length) return Math.max(...a);
  }
  return 0;
}

function firstAmt(lines: string[], key: RegExp): number {
  for (let i = 0; i < lines.length; i++) {
    if (!key.test(lines[i])) continue;
    const a = amtNear(lines, i);
    if (a) return a;
  }
  return 0;
}

function extractTotal(lines: string[]): number {
  // 1) レシート：小計 + 税 が読めれば合算（合計行の桁誤読に強い）
  const sub = firstAmt(lines, /小計/);
  const tax = firstAmt(lines, /(消費税|税[込抜]?|内税|外税)/);
  if (sub > 0 && tax > 0) return sub + tax;

  // 2) 合計系キーワード
  for (const k of TOTAL_KEYS) {
    for (let i = 0; i < lines.length; i++) {
      if (!lines[i].includes(k)) continue;
      if (k === "総額" && NEG_KEYS.test(lines[i])) continue;
      const a = amtNear(lines, i);
      if (a) return a;
    }
  }
  // 3) マーカー付き金額の最大（控除行は除く）
  const marked: number[] = [];
  for (const line of lines) {
    if (NEG_KEYS.test(line)) continue;
    marked.push(...moneyIn(line));
  }
  if (marked.length) return Math.max(...marked);
  // 4) 保険：裸整数の最大（番号・日付・年を除外済み）
  const bare: number[] = [];
  for (const line of lines) {
    if (NEG_KEYS.test(line)) continue;
    bare.push(...bareCandidates(line));
  }
  return bare.length ? Math.max(...bare) : 0;
}

// ---- 日付 ---------------------------------------------------------------

const WAREKI: Record<string, number> = { 令和: 2018, R: 2018, 平成: 1988, H: 1988 };
const pad = (n: number) => String(n).padStart(2, "0");

function extractDate(text: string, today: string): string {
  const y0 = Number(today.slice(0, 4));
  let m = text.match(/(令和|平成|R|H)\s*(\d{1,2})\s*[年.\-/]\s*(\d{1,2})\s*[月.\-/]\s*(\d{1,2})/);
  if (m) return `${WAREKI[m[1]] + Number(m[2])}-${pad(Number(m[3]))}-${pad(Number(m[4]))}`;
  m = text.match(/(20\d{2})\s*[年.\-/]\s*(\d{1,2})\s*[月.\-/]\s*(\d{1,2})/);
  if (m) return `${m[1]}-${pad(Number(m[2]))}-${pad(Number(m[3]))}`;
  m = text.match(/(?:^|[^\d:])(\d{1,2})\s*[月/\-]\s*(\d{1,2})(?:\s*日)?(?![\d:])/);
  if (m) {
    const mo = Number(m[1]), da = Number(m[2]);
    if (mo >= 1 && mo <= 12 && da >= 1 && da <= 31) {
      let y = y0;
      if (`${y}-${pad(mo)}-${pad(da)}` > today) y -= 1;
      return `${y}-${pad(mo)}-${pad(da)}`;
    }
  }
  return "";
}

// ---- kind ---------------------------------------------------------------

const INCOME_KEYS = /(受け取り|受取|入金|振込|送金され|受け取りました|売上|給与|給料|報酬|チャージされ|送金元)/;
const EXPENSE_KEYS = /(お支払い|支払い|支払完了|ご利用|注文|レシート|領収|合計|お会計|ご請求|加盟店|お店)/;

function detectKind(text: string): "expense" | "income" {
  if (INCOME_KEYS.test(text) && !/(お支払い|支払い完了|ご請求|合計)/.test(text)) return "income";
  return "expense";
}

// ---- 店名 ---------------------------------------------------------------

const STORE_LABELS = /(?:お店|店名|加盟店|ご利用店舗|利用店舗|ショップ|送金元|送金先|宛先|店舗)[\s:：　]*([^\n]+)/;

function extractStore(lines: string[]): string {
  // ラベル付き（お店/加盟店/ショップ/送金元…）を最優先
  for (const raw of lines) {
    const mm = raw.match(STORE_LABELS);
    if (mm) {
      const v = mm[1].trim().replace(/\s{2,}/g, " ");
      if (v.length >= 2 && !/^[\d¥,.\-]+$/.test(v) && !/^(残高|クレジット|現金|コード決済)$/.test(v))
        return v.slice(0, 30);
    }
  }
  // 無ければ上部の名前っぽい行（数値/記号のみ・案内文は除外）
  const STOP = /(領収|レシート|明細|お客様|TEL|電話|〒|http|支払|合計|小計|クレジット|現金|ありがとう|受付|番号|日時|方法|完了|しました|ください|ご注文|ご利用明細)/;
  for (const raw of lines.slice(0, 6)) {
    const line = raw.trim();
    if (line.length < 2 || line.length > 30) continue;
    if (/^[\d\s¥,.\-:/%]+$/.test(line)) continue;
    if (STOP.test(line)) continue;
    if (/[一-龠ぁ-んァ-ヶA-Za-z]/.test(line)) return line.replace(/\s{2,}/g, " ");
  }
  return "";
}

// ---- 品目 ---------------------------------------------------------------

const ITEM_SKIP = /(小計|合計|計|税|お預|預り|釣|おつり|ポイント|point|値引|割引|残高|クレジット|現金|お客様|レシート|TEL|電話|〒|http|受付|番号|日時|支払|方法|税込|税抜|ジ0|レジ)/i;
const ADDR_DATE = /(\d{3}-?\d{4}|\d{2,4}[年/\-]\d{1,2}[月/\-]\d{1,2}|\d{1,2}:\d{2})/;

function extractItems(lines: string[]): { name: string; price: number }[] {
  const items: { name: string; price: number }[] = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (line.length < 3 || ITEM_SKIP.test(line) || ADDR_DATE.test(line)) continue;
    const amts = moneyIn(line);
    if (!amts.length) continue;
    const price = amts[amts.length - 1];
    if (price <= 0 || price > 1_000_000) continue;
    const name = line
      .replace(/¥\s*\d[\d,]*/g, "")
      .replace(/\d[\d,]*\s*円/g, "")
      .replace(/\b\d{2,7}\b/g, "")
      .replace(/[*#×xX@]\s*\d+/g, "")
      .replace(/[¥\\\s]{1,}$/g, "")
      .replace(/\s{2,}/g, " ")
      .trim();
    if (name.length >= 1 && /[一-龠ぁ-んァ-ヶA-Za-z]/.test(name)) {
      items.push({ name: name.slice(0, 40), price });
      if (items.length >= 15) break;
    }
  }
  return items;
}

// ---- カテゴリ（店名優先→品目） -----------------------------------------

const CATEGORY_RULES: { cat: string; kw: RegExp }[] = [
  { cat: "交通", kw: /(JR|メトロ|地下鉄|私鉄|小田急|京王|東急|西武|京成|バス|タクシー|日本交通|鉄道|電車|駅|suica|icoca|pasmo|定期|ガソリン|給油|ENEOS|出光|コスモ石油|高速|ETC|駐車|パーキング|タイムズ)/i },
  { cat: "医療", kw: /(病院|クリニック|歯科|医院|診療|処方|調剤|皮膚科|眼科|内科|外科)/ },
  { cat: "通信", kw: /(docomo|ドコモ|au |au$|kddi|softbank|ソフトバンク|楽天モバイル|ワイモバイル|携帯|通信料|プロバイダ)/i },
  { cat: "住まい", kw: /(家賃|管理費|電気|電力|ガス|水道|光熱|不動産|賃貸|電力会社)/ },
  { cat: "日用品", kw: /(ドラッグ|マツモト|マツキヨ|ウエルシア|サンドラッグ|ツルハ|ココカラ|ホームセンター|カインズ|コーナン|ニトリ|ダイソー|セリア|キャンドゥ|100円|無印良品|洗剤|ティッシュ|日用品|雑貨)/i },
  { cat: "洋服", kw: /(ユニクロ|uniqlo|GU |gu$|ジーユー|zara|h&m|しまむら|ABCマート|abc-mart|スニーカー|衣料|アパレル|洋服|ファッション)/i },
  { cat: "美容", kw: /(美容室|美容院|ヘアサロン|ネイル|理容|バーバー|コスメ|化粧|資生堂|ロクシタン|サロン)/ },
  { cat: "娯楽", kw: /(ゲーム|映画|シネマ|TOHO|カラオケ|書店|本屋|紀伊國屋|ブックオフ|TSUTAYA|ゲオ|steam|ラウンドワン|遊園|アミューズ|ヨドバシ|ビックカメラ)/i },
  { cat: "交際", kw: /(ギフト|贈答|プレゼント|お祝い|ご祝儀|会費|花屋)/ },
  { cat: "食費", kw: /(スーパー|マーケット|まいばすけっと|マルエツ|イオン|ライフ|西友|オーケー|業務スーパー|コンビニ|セブン|ローソン|ファミリー?マート|ファミマ|ミニストップ|デイリー|青果|精肉|鮮魚|食品|弁当|パン|ベーカリー|カフェ|コーヒー|スターバックス|ドトール|タリーズ|コメダ|レストラン|食堂|居酒屋|ラーメン|バーガー|マクドナルド|モス|ケンタッキー|牛丼|吉野家|松屋|すき家|寿司|スシロー|くら寿司|そば|うどん|サイゼリヤ|ガスト|デニーズ|ジョナサン|王将|ミスタードーナツ|ドーナツ)/i },
];

function guessCategory(store: string, items: { name: string }[], categoryNames: string[]): string {
  const s = store.toLowerCase().replace(/\s+/g, ""); // OCRの空白差を無視して店名照合
  // 1) 店名で判定（最優先）
  for (const r of CATEGORY_RULES) {
    if (categoryNames.includes(r.cat) && r.kw.test(s)) return r.cat;
  }
  // 2) 店名で決まらなければ品目で
  const it = items.map((i) => i.name).join(" ").toLowerCase();
  if (it) for (const r of CATEGORY_RULES) {
    if (categoryNames.includes(r.cat) && r.kw.test(it)) return r.cat;
  }
  return "";
}

// ---- 本体 ---------------------------------------------------------------

export function parseReceiptText(rawText: string, categoryNames: string[], today: string): ReceiptScan {
  const text = normalizeText(rawText);
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !isStatusBar(l));
  const kind = detectKind(text);
  const total = extractTotal(lines);
  const date = extractDate(lines.join("\n"), today);
  const store = extractStore(lines);
  const items = kind === "income" ? [] : extractItems(lines);
  const category = kind === "income" ? "" : guessCategory(store, items, categoryNames);
  return { kind, store, date, total, category, items };
}
