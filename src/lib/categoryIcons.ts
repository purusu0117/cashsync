// カテゴリアイコンの共有定義（サーバー/クライアント両用・React非依存）。
// 方針: 絵文字はDBにもUIにも持たない。categories.icon には短いキー文字列
// （'food' 等）を保存し、描画は Icons.tsx の CategoryIcon がキー→線画SVGに解決する。
// 旧データ（絵文字入りカテゴリ名・絵文字icon列）は migrateCategoryRow で冪等に変換する。

/** 標準14カテゴリのアイコンキー（新規カテゴリ作成UIの選択グリッドもこの並び） */
export const CATEGORY_ICON_KEYS = [
  "food", // 食費：丼と箸
  "transport", // 交通：電車の前面
  "fun", // 娯楽：ゲームコントローラ
  "daily", // 日用品：スプレーボトル
  "social", // 交際：ジョッキ（乾杯）
  "subscription", // サブスク：循環矢印
  "clothes", // 洋服：Tシャツ
  "beauty", // 美容：手鏡ときらめき
  "medical", // 医療：十字の救急箱
  "travel", // 旅行：飛行機
  "study", // 学び：開いた本
  "home", // 住まい：家とドア
  "comm", // 通信：スマホと電波
  "other", // その他：丸に3点リーダー
] as const;

export type CategoryIconKey = (typeof CATEGORY_ICON_KEYS)[number];

/** ユーザー独自カテゴリのデフォルト（値札タグ） */
export const DEFAULT_CATEGORY_ICON = "tag";

export function isCategoryIconKey(v: string): boolean {
  return v === DEFAULT_CATEGORY_ICON || (CATEGORY_ICON_KEYS as readonly string[]).includes(v);
}

// 旧DBの絵文字icon列 → キー（初期リリースのDEFAULT_CATEGORIESで使っていた絵文字）
const EMOJI_TO_ICON: Record<string, string> = {
  "🍚": "food",
  "🚃": "transport",
  "🎮": "fun",
  "🧻": "daily",
  "🍻": "social",
  "🔁": "subscription",
  "👕": "clothes",
  "💄": "beauty",
  "💊": "medical",
  "✈": "travel", // FE0F(異体字セレクタ)は正規化で落とす
  "📚": "study",
  "🏠": "home",
  "📱": "comm",
  "🧾": "other",
};

// 標準カテゴリ名 → キー（icon列が空/不明でも名前から復元できるように）
const NAME_TO_ICON: Record<string, string> = {
  食費: "food",
  交通: "transport",
  娯楽: "fun",
  日用品: "daily",
  交際: "social",
  サブスク: "subscription",
  洋服: "clothes",
  美容: "beauty",
  医療: "medical",
  旅行: "travel",
  学び: "study",
  住まい: "home",
  通信: "comm",
  その他: "other",
};

// 絵文字・記号系コードポイント（除去対象）。CJK・かな・英数には触れない。
const EMOJI_RE =
  /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{2190}-\u{21FF}\u{2300}-\u{23FF}\u{2934}\u{2935}\u{3030}\u{303D}\u{3297}\u{3299}\u{FE0F}\u{200D}\u{20E3}\u{1F1E6}-\u{1F1FF}]/gu;

/** カテゴリ名から絵文字を除去（例「サブスク🔁」→「サブスク」）。空白も整える */
export function stripCategoryEmoji(name: string): string {
  return name.replace(EMOJI_RE, "").replace(/\s+/g, " ").trim();
}

/** name/旧icon から表示に使うアイコンキーを解決 */
export function categoryIconFor(name: string, icon: string): string {
  const raw = (icon ?? "").trim();
  if (isCategoryIconKey(raw)) return raw;
  const emoji = raw.replace(/\uFE0F/gu, "");
  if (EMOJI_TO_ICON[emoji]) return EMOJI_TO_ICON[emoji];
  return NAME_TO_ICON[stripCategoryEmoji(name)] ?? DEFAULT_CATEGORY_ICON;
}

/**
 * 1カテゴリ行のマイグレーション計算（純関数・冪等）。
 * 変更が必要なら新しい {name, icon} を、既に綺麗なら null を返す。
 */
export function migrateCategoryRow(
  name: string,
  icon: string,
): { name: string; icon: string } | null {
  const newName = stripCategoryEmoji(name) || name.trim();
  const newIcon = categoryIconFor(name, icon);
  if (newName === name && newIcon === icon) return null;
  return { name: newName, icon: newIcon };
}
