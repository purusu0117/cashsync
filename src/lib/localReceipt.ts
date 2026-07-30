// 自前（AI API 無し）のレシート/決済スクショ解析。OCRテキスト→ReceiptScan の純関数。
// OCRエンジン非依存（Tesseract / Apple Vision / ML Kit で共通）。
//   parseReceiptText(text, categoryNames, today) -> ReceiptScan
// 加えて、手入力の自然文→支出案（parseEntryText）／シフトメモ→シフト案（parseShiftText）も
// AI API 無しのルール解析で提供する（ネイティブ版で askClaude* を呼ばないため）。
import type { ParsedEntry, ParsedShiftItem, ReceiptScan } from "./ai";

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
  // 千区切りのカンマを「を/ヲ」等と誤読（PayPay等の大きな金額。例「1 を 480 円」→ 1,480円）。
  t = t.replace(/(\d)\s*[をヲゎ]\s*(?=\d{3}(?:\D|$))/g, "$1,");
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
  const t = line.trim();
  if (/^\d{1,2}:\d{2}\b/.test(t)) return true; // 先頭が時刻
  if (/(5G|4G|LTE|Wi-?Fi)/i.test(t) && t.length <= 20) return true; // 電波表示
  if (/\d{1,3}\s*%/.test(t) && t.length <= 12) return true; // バッテリー残量
  if (/[△▲▼]/.test(t) && t.length <= 16) return true; // アンテナ/電波記号だけの行
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
    // 年(19xx/20xx)と、カンマ無しの7桁以上(≒取引番号/電話等のID)は金額候補にしない。
    if (n >= 100 && n < 1_000_000 && !/^(19|20)\d{2}$/.test(m[1])) out.push(n);
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

/**
 * 検算：レシートの「お預かり−お釣り」や「小計/商品代金 −値引(+税)」から“あり得る合計”を割り出し、
 * 読み取った total がそのどれかに（±1円で）一致するか確認する。
 * ・信頼できる材料（お預かり&お釣り、または小計/商品代金）が無ければ検証不能として true を返す（疑わない）。
 * ・明細合計は誤読/取りこぼしが多いので、矛盾の“判定材料”には使わず、“一致の確認”にだけ使う
 *   （信頼材料があるのに total がどれとも合わない場合のみ false ＝読み取りミスの疑い）。
 */
function totalLooksConsistent(lines: string[], items: { price: number }[], total: number): boolean {
  if (!(total > 0)) return true;
  // ラベル行〜2行先から ¥/円/カンマ付き金額を拾う（moneyIn は数字内の空白「4 , 000」も許容）。
  const moneyNear = (re: RegExp): number => {
    for (let i = 0; i < lines.length; i++) {
      if (!re.test(lines[i])) continue;
      for (let j = 0; j <= 2 && i + j < lines.length; j++) {
        const mv = moneyIn(lines[i + j]);
        if (mv.length) return Math.max(...mv);
      }
    }
    return 0;
  };
  // 値引は「値引額」の値が次行に「-22」と記号なし/負数で分離することが多いので専用に拾う。
  const discountNear = (): number => {
    for (let i = 0; i < lines.length; i++) {
      if (!/(値引|割引)/.test(lines[i])) continue;
      for (let j = 0; j <= 2 && i + j < lines.length; j++) {
        const mv = moneyIn(lines[i + j]);
        if (mv.length) return Math.max(...mv);
        const bm = lines[i + j].replace(/\s/g, "").match(/-?\d[\d,]*/);
        if (bm) {
          const v = Math.abs(Number(bm[0].replace(/,/g, "")));
          if (v >= 1 && v < 100000) return v;
        }
      }
    }
    return 0;
  };
  const discount = discountNear();
  const tax = moneyNear(/(消費税|内税|外税|税等|税額)/);
  const subtotal = moneyNear(/(小計|商品代金)/);
  const paid = moneyNear(/(お預|預り|預かり)/);
  const change = moneyNear(/(お釣|おつり|釣り|釣銭)/);
  const itemsSum = items.reduce((s, it) => s + (it.price > 0 ? Math.round(it.price) : 0), 0);
  const addMods = (base: number, set: Set<number>) => {
    if (base <= 0) return;
    set.add(base);
    if (discount > 0) set.add(base - discount);
    if (tax > 0) set.add(base + tax);
    if (discount > 0 && tax > 0) set.add(base - discount + tax);
  };
  const reliable = new Set<number>();
  if (paid > 0 && change > 0) reliable.add(paid - change);
  addMods(subtotal, reliable);
  if (reliable.size === 0) return true; // 信頼できる検算材料が無い→疑わない
  const all = new Set(reliable);
  if (items.length >= 2) addMods(itemsSum, all); // 明細は確認にだけ使う
  for (const c of all) if (Math.abs(c - total) <= 1) return true;
  return false; // 信頼材料があるのに total がどれとも合わない＝金額の読み取りミスの疑い
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

// 店名ラベル（「お店: ○○」等）。必ず行頭のラベル＋区切りに限定する。
// ※以前は無アンカー＋区切り任意だったため、本文中の「店舗」（例:「…店舗からのお知らせ…」）に
//   誤マッチして後続の文章を店名として拾う不具合があった。行頭アンカー＋区切り必須で防ぐ。
//   紛れやすい単独の「店舗」はラベル語から外す（「店舗名」「ご利用店舗」等の複合語のみ許可）。
const STORE_LABELS = /^\s*(?:お店|店名|店舗名|加盟店|ご利用店舗|利用店舗|ショップ|送金元|送金先|宛先)[\s:：　]+(\S[^\n]*)/;

const STORE_LABEL_ONLY = /^(お店|店名|加盟店|加盟店名|ご利用店舗|利用店舗|ショップ|送金元|送金先|宛先|店舗)$/;
function badStore(v: string): boolean {
  return (
    !v || v.length < 2 || /^[\d¥\\,.\-\s]+$/.test(v) ||
    /(残高|クレジット|現金|コード決済|支払|方法|日時|取引|番号|完了|ポイント|お預|釣)/.test(v)
  );
}

function extractStore(lines: string[]): string {
  const clean = (v: string) => v.trim().replace(/\s{2,}/g, " ");
  // 1) ラベル同一行（お店: ○○）を最優先
  for (const raw of lines) {
    const mm = raw.match(STORE_LABELS);
    if (mm) {
      const v = clean(mm[1]);
      if (!badStore(v)) return v.slice(0, 30);
    }
  }
  // 2) ラベルが単独行（決済スクショはOCRで「お店」と値が別行になりがち）→ 直前/直後の行を店名に
  for (let i = 0; i < lines.length; i++) {
    if (!STORE_LABEL_ONLY.test(lines[i].trim())) continue;
    for (const j of [i - 1, i + 1]) {
      const v = clean(lines[j] ?? "");
      if (!badStore(v) && /[一-龠ぁ-んァ-ヶA-Za-z]/.test(v)) return v.slice(0, 30);
    }
  }
  // 無ければ上部の名前っぽい行（数値/記号のみ・案内文・帳票の見本透かしは除外）。
  // 「見本/サンプル/記載例/フォーマット/仕組み」等はデモ帳票の透かし語で店名ではない。
  const STOP = /(領収|レシート|明細|お客様|TEL|電話|〒|http|支払|合計|小計|クレジット|現金|ありがとう|受付|番号|日時|方法|完了|しました|ください|ご注文|ご利用明細|見本|サンプル|記載例|フォーマット|仕組み|ヘッダ|端末番号)/;
  for (const raw of lines.slice(0, 12)) {
    // 先頭の記号/中黒（「・スマレジ」→「スマレジ」）を落としてから判定
    const line = raw.trim().replace(/^[・･:：\-—\s]+/, "").trim();
    if (line.length < 2 || line.length > 30) continue;
    if (/^[\d\s¥,.\-:/%]+$/.test(line)) continue;
    if (STOP.test(line)) continue;
    if (/[一-龠ぁ-んァ-ヶA-Za-z]/.test(line)) return line.replace(/\s{2,}/g, " ");
  }
  return "";
}

// ---- 品目 ---------------------------------------------------------------

// 品目として保存しない行（小計/合計/税/預り/ポイント等の集計・案内行）。
// 「商品代金/代金/お買上」はレシートの小計行（例:「（商品代金 ¥526)」）で、品目ではないため除外する。
const ITEM_SKIP = /(小計|合計|計|税|お預|預り|釣|おつり|ポイント|point|値引|割引|残高|クレジット|現金|お客様|レシート|TEL|電話|〒|http|受付|番号|日時|支払|方法|税込|税抜|ジ0|レジ|商品代金|代金|お買上|買上|お会計|請求)/i;
const ADDR_DATE = /(\d{3}-?\d{4}|\d{2,4}[年/\-]\d{1,2}[月/\-]\d{1,2}|\d{1,2}:\d{2})/;

function cleanItemName(line: string): string {
  return line
    .replace(/¥\s*[\d\s,]*\d/g, "") // ¥金額（カンマ・スペース混じり）を丸ごと除去
    .replace(/[\d\s,]*\d\s*円/g, "")
    .replace(/\b\d{2,7}\b/g, "")
    .replace(/[*#×xX@]\s*\d+/g, "")
    .replace(/[¥\\\s,]{1,}$/g, "")
    .replace(/^[\s,]+/g, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

function extractItems(lines: string[]): { name: string; price: number }[] {
  const items: { name: string; price: number }[] = [];
  // OCRは「品目名」と「金額」を別行に分けて出すことが多い（列の間隔が広いと行が割れる）。
  // 直前の"名前だけの行"を覚えておき、"金額だけの行"が来たらペアにする。同一行に両方あるなら従来通り。
  let pendingName = "";
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (ITEM_SKIP.test(line) || ADDR_DATE.test(line)) { pendingName = ""; continue; }
    const amts = moneyIn(line);
    if (amts.length) {
      const price = amts[amts.length - 1];
      if (price > 0 && price <= 1_000_000) {
        const inline = cleanItemName(line);
        // 同一行に品名があればそれ。無ければ（金額だけの行なら）直前の名前行を使う。
        const name = /[一-龠ぁ-んァ-ヶA-Za-z]/.test(inline) ? inline : pendingName;
        if (name.length >= 1 && /[一-龠ぁ-んァ-ヶA-Za-z]/.test(name)) {
          items.push({ name: name.slice(0, 40), price });
          if (items.length >= 15) break;
        }
      }
      pendingName = "";
    } else if (line.length >= 2 && /[一-龠ぁ-んァ-ヶA-Za-z]/.test(line) && !/^[\d\s¥\\,.\-:/%]+$/.test(line)) {
      pendingName = line.replace(/\s{2,}/g, " "); // 名前だけの行を保持
    }
  }
  return items;
}

// ---- カテゴリ（店名優先→品目） -----------------------------------------

const CATEGORY_RULES: { cat: string; kw: RegExp }[] = [
  // フードデリバリー（QR決済画面は店名しか出ないため、店名で食費に確定させる）。
  // 宅配系は店名がサービス名になり品目が出ないことが多いので、店名判定を最優先に置く。
  { cat: "食費", kw: /(ロケットナウ|rocketnow|ウーバーイーツ|ubereats|出前館|出前|wolt|ウォルト|フードパンダ|foodpanda|セブンナウ|7now|セブン-?イレブン.*ネット|dデリバリー|ddelivery|doordash|chompy|フードデリバリー|フードネコ|ネットスーパー|楽天ぐるなびデリバリー|ごちクル|くらしのマーケット?デリ)/i },
  // 注: 単独の「駅」は「駅前店」等の店名に誤マッチするため入れない（鉄道系は路線/交通機関名で拾う）。
  { cat: "交通", kw: /(JR|メトロ|地下鉄|私鉄|小田急|京王|東急|西武|京成|バス|タクシー|日本交通|鉄道|電車|新幹線|suica|icoca|pasmo|定期券|ガソリン|給油|ガソリンスタンド|石油|レギュラー|ハイオク|軽油|エネオス|ENEOS|出光|コスモ石油|高速|ETC|駐車場|パーキング|タイムズ)/i },
  { cat: "医療", kw: /(病院|クリニック|歯科|医院|診療|処方|調剤|皮膚科|眼科|内科|外科)/ },
  { cat: "通信", kw: /(docomo|ドコモ|au |au$|kddi|softbank|ソフトバンク|楽天モバイル|ワイモバイル|携帯|通信料|プロバイダ)/i },
  { cat: "住まい", kw: /(家賃|管理費|電気|電力|ガス|水道|光熱|不動産|賃貸|電力会社)/ },
  { cat: "日用品", kw: /(ドラッグ|マツモト|マツキヨ|ウエルシア|サンドラッグ|ツルハ|ココカラ|ホームセンター|カインズ|コーナン|ニトリ|ダイソー|セリア|キャンドゥ|100円|無印良品|洗剤|ティッシュ|日用品|雑貨)/i },
  { cat: "洋服", kw: /(ユニクロ|uniqlo|GU |gu$|ジーユー|zara|h&m|しまむら|ABCマート|abc-mart|スニーカー|衣料|アパレル|洋服|ファッション)/i },
  { cat: "美容", kw: /(美容室|美容院|ヘアサロン|ネイル|理容|バーバー|コスメ|化粧|資生堂|ロクシタン|サロン)/ },
  { cat: "娯楽", kw: /(ゲーム|映画|シネマ|TOHO|カラオケ|書店|本屋|紀伊國屋|ブックオフ|TSUTAYA|ゲオ|steam|ラウンドワン|遊園|アミューズ|ヨドバシ|ビックカメラ)/i },
  { cat: "交際", kw: /(ギフト|贈答|プレゼント|お祝い|ご祝儀|会費|花屋)/ },
  { cat: "食費", kw: /(スーパー|マーケット|まいばすけっと|マルエツ|イオン|ライフ|西友|オーケー|業務スーパー|コンビニ|セブン|ローソン|ファミリー?マート|ファミマ|ミニストップ|デイリー|青果|精肉|鮮魚|食品|弁当|パン|ベーカリー|カフェ|コーヒー|スターバックス|ドトール|タリーズ|コメダ|レストラン|食堂|居酒屋|ラーメン|バーガー|マクドナルド|モス|ケンタッキー|牛丼|吉野家|松屋|すき家|寿司|スシロー|くら寿司|そば|うどん|サイゼリヤ|ガスト|デニーズ|ジョナサン|王将|ミスタードーナツ|ドーナツ|おにぎり|サラダ|チキン|惣菜|お茶|緑茶|牛乳|ヨーグルト|野菜|果物|菓子|スイーツ|サンドイッチ|おでん|飲料|ジュース|ビール|水)/i },
];

/** かな正規化：ひらがな→カタカナ、OCRが「ー」を「一」と誤読する分も吸収。カテゴリ照合の頑健化。 */
function kanaNorm(s: string): string {
  return s
    .replace(/[ぁ-ゖ]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 0x60))
    .replace(/一/g, "ー");
}

function guessCategory(store: string, items: { name: string }[], categoryNames: string[]): string {
  const s = kanaNorm(store.toLowerCase().replace(/\s+/g, "")); // 空白差＋かな差を無視して店名照合
  // 1) 店名で判定（最優先）
  for (const r of CATEGORY_RULES) {
    if (categoryNames.includes(r.cat) && r.kw.test(s)) return r.cat;
  }
  // 2) 店名で決まらなければ品目で
  const it = kanaNorm(items.map((i) => i.name).join(" ").toLowerCase());
  if (it) for (const r of CATEGORY_RULES) {
    if (categoryNames.includes(r.cat) && r.kw.test(it)) return r.cat;
  }
  return "";
}

// ---- 本体 ---------------------------------------------------------------

// ---- 決済アプリ画面（PayPay/LINE Pay/送金/受け取り等）専用の抽出 -----------
// 実物の決済画面は、上部に「相手/店名」「日付」「大きな金額」があり、その下に
// ポイント・クーポン・達成条件など大量のノイズ（"金額100,000円""14pt"等）が続く。
// レシート用の汎用ロジックだとノイズを合計に拾うため、専用に切り分ける。
const PAYMENT_MARKERS =
  /(支払い完了|受け取り完了|送金しました|受け取りました|さんから受け取る|さんに送る|残高を送る|Pay\s?Pay|LINE\s?Pay|楽天ペイ|d払い|au\s?PAY|メルペイ)/i;
const NOISE_LINE =
  /(ポイント|pt\b|還元|付与|クーポン|達成|条件|回数|ステップ|おすすめ|獲得|上限|チャージ|登録する|お困り|詳細を表示|残高を送る|クレジット)/i;

// 決済画面の日付行。実機のApple Visionは「年月日」を *R S E ● 等に化けさせるため、
// 「20xx＋区切り＋月＋区切り＋日」の緩いパターンでも拾う（漢字の年月日にも当たる）。
const PAY_DATE_RE = /20\d{2}[^\d\n]{0,3}\d{1,2}[^\d\n]{1,3}\d{1,2}/;

function payDateIdx(lines: string[]): number {
  return lines.findIndex((l) => PAY_DATE_RE.test(l));
}

/** 決済画面の日付。Vision誤読の「2026*7R28E」→2026-07-28 も拾う。取れなければ ""。 */
function extractPayDate(lines: string[]): string {
  for (const l of lines) {
    const m = l.match(/20(\d\d)[^\d\n]{0,3}(\d{1,2})[^\d\n]{1,3}(\d{1,2})/);
    if (!m) continue;
    const mo = Number(m[2]), da = Number(m[3]);
    if (mo >= 1 && mo <= 12 && da >= 1 && da <= 31) {
      return `20${m[1]}-${pad(mo)}-${pad(da)}`;
    }
  }
  return "";
}

// 紙レシートを決済アプリ画面と誤判定しないためのガード（PayPay決済の"紙"レシート等）。
// 注: 「レジ」は「クレジット」に、「税率」は決済画面にも出るため入れない（誤って紙レシート扱いになる）。
// 紙レシート"固有"の語だけに絞る。
const RECEIPT_MARKERS = /(小計|お買上|お買い上げ|軽減税率|外税|内税|レシート番号|レジ袋)/;

function isPaymentScreen(text: string): boolean {
  if (RECEIPT_MARKERS.test(text)) return false; // 紙レシートは通常ロジックへ
  return PAYMENT_MARKERS.test(text);
}

/**
 * 収入(受け取り)/支出(支払い)の判定。
 * 実機Visionは「受け取り完了/支払い完了」の日本語を破壊するので、日本語マーカーは"あれば"優先し、
 * 無い場合は「金額の頭に + が付く（PayPayの受取表示 +¥1,450）」ことを収入の決め手にする。
 */
function paymentKind(text: string): "expense" | "income" {
  if (/(受け取り完了|受け取りました|さんから受け取る|入金|返金|チャージ完了|送金されました)/.test(text) && !/支払い完了/.test(text)) {
    return "income";
  }
  if (/(支払い完了|送金しました|お支払い)/.test(text)) return "expense";
  // マーカーが化けている場合：受取額は先頭に + が付く（+1,450 / +¥1,450）。誤検知を避けるため
  // 「+ の直後がカンマ区切りの千以上の金額」または「+¥ に続く数字」に限定する（+14pt等のノイズは拾わない）。
  if (/[+＋]\s?[¥￥]?\s?\d{1,3},\d{3}/.test(text) || /[+＋]\s?[¥￥]\s?\d{2,}/.test(text)) return "income";
  return "expense";
}

/** 店名候補の行から、先頭の"きれいなトークン"だけ残す（Visionが付ける末尾ゴミ記号を落とす）。
 *  例「777 èklJ)b*¢*H%」→「777」／「Rocket Now」→「Rocket Now」。 */
function cleanStoreToken(line: string): string {
  const tokens = line.trim().split(/\s+/);
  const kept: string[] = [];
  for (const tk of tokens) {
    if (/^[A-Za-z0-9ぁ-んァ-ヶ一-龠ー々]+$/.test(tk)) kept.push(tk);
    else break;
  }
  return kept.join(" ").trim();
}

/** 決済画面の金額＝日付行から下に見て最初の金額（ポイント等ノイズ行は除外）。 */
function paymentTotal(lines: string[]): number {
  const di = payDateIdx(lines);
  const lo = di >= 0 ? di : 0;
  const hi = Math.min(lines.length, lo + 6);
  for (let i = lo; i < hi; i++) {
    if (NOISE_LINE.test(lines[i])) continue;
    const a = moneyIn(lines[i]);
    if (a.length) return Math.max(...a);
  }
  // フォールバック：ノイズ行を除いた全体でのカンマ区切り金額の最大
  const all: number[] = [];
  for (const l of lines) {
    if (NOISE_LINE.test(l)) continue;
    all.push(...moneyIn(l));
  }
  return all.length ? Math.max(...all) : 0;
}

/** 決済画面の店名/送金相手。①お店/送金元等のラベル ②日付行の直前の行 ③上部の名前行。 */
function paymentStore(lines: string[]): string {
  // 1) ラベル（お店/加盟店/送金元/送金先/宛先/店名/店舗）があればラベル方式を優先
  if (lines.some((l) => /(お店|加盟店|送金元|送金先|宛先|店名|店舗)/.test(l))) {
    const s = extractStore(lines);
    if (s) return s;
  }
  const takeName = (raw: string): string => {
    let l = raw.trim();
    if (!l || isStatusBar(l) || /^[\d\s¥,.\-:+●]+円?$/.test(l)) return "";
    if (/(支払い完了|受け取り完了|送金しました|受け取りました|お支払い|ご請求|完了|詳細|明細|残高|Google\s?Play)/.test(l)) return "";
    const m = l.match(/(.+?)\s*さん(から|へ|に)/); // 「○○さんから受け取る」等
    if (m) l = m[1];
    l = l.replace(/^[ぁ-んァ-ヶ]\s+(?=[A-Za-z0-9])/u, ""); // 「イ Rocket」→「Rocket」（アイコン誤読1字）
    const cleaned = cleanStoreToken(l) || l.replace(/\s{2,}/g, " ").trim();
    return cleaned.length >= 1 && /[一-龠ぁ-んァ-ヶA-Za-z0-9]/.test(cleaned) ? cleaned.slice(0, 30) : "";
  };
  // 2) 日付行の直前の行（PayPayは 相手名→日付→金額 の順）を最優先で見る
  const di = payDateIdx(lines);
  if (di > 0) {
    for (let k = di - 1; k >= 0; k--) {
      const name = takeName(lines[k]);
      if (name) return name;
    }
  }
  // 3) フォールバック：上部の名前行
  const top = lines.slice(0, di > 0 ? di : 4);
  for (const raw of top) {
    const name = takeName(raw);
    if (name) return name;
  }
  return "";
}

export function parseReceiptText(rawText: string, categoryNames: string[], today: string): ReceiptScan {
  const text = normalizeText(rawText);
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !isStatusBar(l));
  const date = extractDate(lines.join("\n"), today);

  // 決済アプリ画面は専用ロジックで（ノイズを合計に拾わないため）
  if (isPaymentScreen(text)) {
    const kind = paymentKind(text);
    const store = paymentStore(lines) || extractStore(lines);
    const total = paymentTotal(lines) || extractTotal(lines);
    // 日付：通常抽出でダメなら、Vision誤読（2026*7R28E 等）向けの緩い抽出で拾う
    const payDate = date || extractPayDate(lines);
    const category = kind === "income" ? "" : guessCategory(store, [], categoryNames);
    return { kind, store, date: payDate, total, category, items: [] };
  }

  // 通常のレシート
  const kind = detectKind(text);
  const total = extractTotal(lines);
  const store = extractStore(lines);
  const items = kind === "income" ? [] : extractItems(lines);
  const category = kind === "income" ? "" : guessCategory(store, items, categoryNames);
  // 検算：明細/お預かり・お釣り等と合計が矛盾したら「読み取りミスの疑い」を立てる（撮り直し誘導用）。
  const needsRecheck = kind === "expense" && !totalLooksConsistent(lines, items, total);
  return { kind, store, date, total, category, items, needsRecheck };
}

// =========================================================================
// 手入力の自然文 / シフトメモ の端末内解析（AI API 無し）
// =========================================================================

const DOW: Record<string, number> = { 日: 0, 月: 1, 火: 2, 水: 3, 木: 4, 金: 5, 土: 6 };

/** "YYYY-MM-DD" に delta 日を足す（TZ非依存でUTC計算）。 */
function addDays(today: string, delta: number): string {
  const [y, m, d] = today.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + delta));
  return `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())}`;
}

/** "YYYY-MM-DD" の曜日（0=日）。 */
function dowOf(dateStr: string): number {
  const [y, m, d] = dateStr.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

/**
 * 相対日付表現（今日/昨日/明日/n日前/来週金曜…）を today 基準で解決。
 * preferFuture=true（シフト）は曜日を「次に来るその曜日」、false（支出）は「直近の過去のその曜日」に倒す。
 * 解決できなければ ""（呼び出し側で明示日付 or today にフォールバック）。
 */
function resolveRelativeDate(text: string, today: string, preferFuture: boolean): string {
  if (/(今日|本日|きょう)/.test(text)) return today;
  if (/(明後日|あさって)/.test(text)) return addDays(today, 2);
  if (/(明日|あした|あす)/.test(text)) return addDays(today, 1);
  if (/(一昨日|おととい|おとつい)/.test(text)) return addDays(today, -2);
  if (/(昨日|きのう|さくじつ)/.test(text)) return addDays(today, -1);
  let m = text.match(/(\d{1,2})\s*日前/);
  if (m) return addDays(today, -Number(m[1]));
  m = text.match(/(\d{1,2})\s*日後/);
  if (m) return addDays(today, Number(m[1]));
  // 曜日（来週/今週/先週の修飾つき）
  m = text.match(/(来週|今週|先週)?\s*[のな]?\s*([日月火水木金土])曜/);
  if (m) {
    const target = DOW[m[2]];
    const base = dowOf(today);
    let delta: number;
    if (m[1] === "来週") delta = ((target - base + 7) % 7) + 7;
    else if (m[1] === "先週") delta = ((target - base + 7) % 7) - 7;
    else if (preferFuture) delta = (target - base + 7) % 7; // 直近の未来（同曜日は今日）
    else delta = -((base - target + 7) % 7); // 直近の過去（同曜日は今日）
    return addDays(today, delta);
  }
  return "";
}

/** テキスト全体からカテゴリを推定（店名/内容キーワード）。 */
function guessCategoryFromText(text: string, categoryNames: string[]): string {
  const s = text.toLowerCase().replace(/\s+/g, "");
  for (const r of CATEGORY_RULES) {
    if (categoryNames.includes(r.cat) && r.kw.test(s)) return r.cat;
  }
  return "";
}

/**
 * 自然文の支出メモ（「昨日セブンで昼飯650円」）→ 支出レコード案。AI API 不使用。
 * amount が取れなければ amount=0 を返す（呼び出し側で「金額を読み取れませんでした」を出す）。
 */
export function parseEntryText(rawText: string, categoryNames: string[], today: string): ParsedEntry {
  const text = normalizeText(rawText);
  // 金額：通貨マーカー付き優先→無ければ独立した整数の最後
  let amount = 0;
  const marked = moneyIn(text);
  if (marked.length) amount = marked[marked.length - 1];
  if (!amount) {
    const bare = text.match(/(?<![\d,:])\d{2,7}(?![\d,:])/g);
    if (bare) {
      const nums = bare.map(Number).filter((n) => n >= 10 && n <= 9_999_999 && !/^(19|20)\d{2}$/.test(String(n)));
      if (nums.length) amount = nums[nums.length - 1];
    }
  }
  const date = resolveRelativeDate(text, today, false) || extractDate(text, today) || today;
  const category = guessCategoryFromText(text, categoryNames);
  const memo = text
    .replace(/¥\s*[\d,]+/g, "")
    .replace(/[\d,]+\s*円/g, "")
    .replace(/(?<![\d,:])\d{2,7}(?![\d,:])/g, "")
    .replace(/(今日|本日|きょう|明後日|あさって|明日|あした|あす|一昨日|おととい|おとつい|昨日|きのう|さくじつ|\d{1,2}日前|\d{1,2}日後)/g, "")
    .replace(/(来週|今週|先週)?\s*[のな]?\s*[日月火水木金土]曜(日)?/g, "")
    .replace(/\d{1,2}\s*[月/]\s*\d{1,2}\s*日?/g, "")
    .replace(/[でにへ、。]/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
  return { date, amount: Math.round(amount), category, memo };
}

/** "18時半"/"18:00"/"22時30分" 等の時刻トークンを順に分（0-1439+）で取り出す。 */
function extractTimeTokens(text: string): number[] {
  const toks: number[] = [];
  const re = /(\d{1,2})\s*(?::|：|時)\s*(半|\d{1,2})?\s*分?/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const h = Number(m[1]);
    let mm = 0;
    if (m[2] === "半") mm = 30;
    else if (m[2] != null) mm = Number(m[2]);
    if (h >= 0 && h <= 28 && mm >= 0 && mm < 60) toks.push(h * 60 + mm);
  }
  return toks;
}

/** メモ内で言及されたバイト先を緩く照合して jobId を返す（不明なら null）。 */
function matchJob(text: string, jobs: { id: string; name: string }[]): string | null {
  const t = text.toLowerCase().replace(/\s+/g, "");
  for (const j of jobs) {
    const n = j.name.toLowerCase().replace(/\s+/g, "");
    if (n.length >= 2 && t.includes(n)) return j.id;
  }
  return null;
}

/**
 * 自然文のシフトメモ（「キミハンで明日18時から22時半」）→ シフト案。AI API 不使用。
 * 日付＋開始/終了の2時刻が取れた時だけ1件返す。読み取れなければ []（呼び出し側で手動入力を案内）。
 * ※「毎週」「複数日まとめて」等の複雑な表現は端末内では非対応（AIなしのため）。
 */
export function parseShiftText(
  rawText: string,
  jobs: { id: string; name: string }[],
  today: string,
): ParsedShiftItem[] {
  const text = normalizeText(rawText);
  const date = resolveRelativeDate(text, today, true) || extractDate(text, today);
  const toks = extractTimeTokens(text);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || toks.length < 2) return [];
  const startMin = toks[0];
  let endMin = toks[1];
  if (endMin <= startMin) endMin += 1440; // 日跨ぎ（22時→翌2時）
  return [{ date, startMin, endMin, jobId: matchJob(text, jobs) }];
}
