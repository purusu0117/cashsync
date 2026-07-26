// モノクロの線画アイコン（絵文字アイコンの置き換え）。
// カラー絵文字は感熱紙のモノクロ印字と衝突するため、UIの操作要素は
// BottomNav と同じ stroke ベースの線画で統一する。
import type { ReactElement } from "react";

type IconProps = { className?: string };

export function CameraIcon({ className }: IconProps) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
      <path d="M4 7h3l1.5-2h7L17 7h3a1 1 0 0 1 1 1v11a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V8a1 1 0 0 1 1-1Z" strokeLinejoin="round" />
      <circle cx="12" cy="13.5" r="3.5" />
    </svg>
  );
}

export function ScreenshotIcon({ className }: IconProps) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
      <rect x="7" y="3" width="10" height="18" rx="2" />
      <path d="M10 6h4" strokeLinecap="round" />
      <path d="M3 9v6M21 9v6" strokeLinecap="round" strokeDasharray="1.5 2.5" />
    </svg>
  );
}

export function PencilIcon({ className }: IconProps) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
      <path d="m14.5 5 4.5 4.5L8.5 20H4v-4.5L14.5 5Z" strokeLinejoin="round" />
      <path d="m12.5 7 4.5 4.5" />
    </svg>
  );
}

export function MicIcon({ className }: IconProps) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
      <rect x="9" y="3" width="6" height="11" rx="3" />
      <path d="M5.5 11.5a6.5 6.5 0 0 0 13 0M12 18v3" strokeLinecap="round" />
    </svg>
  );
}

export function ReceiptIcon({ className }: IconProps) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
      <path d="M6 3h12v18l-2-1.5L14 21l-2-1.5L10 21l-2-1.5L6 21Z" strokeLinejoin="round" />
      <path d="M9 8h6M9 12h6" strokeLinecap="round" />
    </svg>
  );
}

export function CoinIcon({ className }: IconProps) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
      <circle cx="12" cy="12" r="8.5" />
      <path d="m8.5 8 3.5 4.5L15.5 8M12 12.5V17M9.5 13.5h5M9.5 15.5h5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function StopIcon({ className }: IconProps) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
      <circle cx="12" cy="12" r="8.5" />
      <rect x="9" y="9" width="6" height="6" rx="1" fill="currentColor" stroke="none" />
    </svg>
  );
}

export function ImageIcon({ className }: IconProps) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
      <rect x="3" y="5" width="18" height="15" rx="2" />
      <circle cx="8.5" cy="10" r="1.5" />
      <path d="m5 18 4.5-4.5 3 3 3.5-3.5L21 17.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function TrashIcon({ className }: IconProps) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
      <path d="M4.5 7h15M9.5 7V4.5h5V7M6.5 7l.9 13h9.2l.9-13" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M10 11v5.5M14 11v5.5" strokeLinecap="round" />
    </svg>
  );
}

export function CheckCircleIcon({ className }: IconProps) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
      <circle cx="12" cy="12" r="8.5" />
      <path d="m8 12.5 2.8 2.8 5.7-6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function PinIcon({ className }: IconProps) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
      <path d="M9 3.5h6L14 9l3 3H7l3-3Z" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M12 12v8.5" strokeLinecap="round" />
    </svg>
  );
}

export function PlayIcon({ className }: IconProps) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
      <circle cx="12" cy="12" r="8.5" />
      <path d="m10 8.5 5.5 3.5-5.5 3.5Z" strokeLinejoin="round" />
    </svg>
  );
}

export function CardIcon({ className }: IconProps) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
      <rect x="3" y="6" width="18" height="13" rx="2" />
      <path d="M3 10.5h18M6.5 14.5h4" strokeLinecap="round" />
    </svg>
  );
}

export function CalendarIcon({ className }: IconProps) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
      <rect x="3.5" y="5.5" width="17" height="15" rx="2" />
      <path d="M3.5 10.5h17M8.5 3.5v4M15.5 3.5v4" strokeLinecap="round" />
    </svg>
  );
}

export function WarnIcon({ className }: IconProps) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
      <path d="M12 4 21 19.5H3Z" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M12 10v4.5M12 17.2h.01" strokeLinecap="round" />
    </svg>
  );
}

// ---------------------------------------------------------------------------
// カテゴリアイコン（標準14種＋デフォルトの値札タグ）。
// DBの categories.icon にはキー文字列（'food' 等）が入り、CategoryIcon が解決する。
// 線の太さ1.8・丸端でBottomNav/上記アイコンとトーンを統一。
// ---------------------------------------------------------------------------

function FoodIcon({ className }: IconProps) {
  // 丼と箸
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
      <path d="M4 12h16a8 8 0 0 1-5.2 7.2V21H9.2v-1.8A8 8 0 0 1 4 12Z" strokeLinecap="round" strokeLinejoin="round" />
      <path d="m7 9.5 12-6M9.5 10.5l10-4" strokeLinecap="round" />
    </svg>
  );
}

function TransportIcon({ className }: IconProps) {
  // 電車の前面
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
      <rect x="5" y="3" width="14" height="14" rx="2.5" />
      <path d="M5 9h14" strokeLinecap="round" />
      <path d="M9 13h.01M15 13h.01" strokeLinecap="round" />
      <path d="m8 17-2 4M16 17l2 4" strokeLinecap="round" />
    </svg>
  );
}

function FunIcon({ className }: IconProps) {
  // ゲームコントローラ
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
      <path
        d="M7 7.5h10a4.3 4.3 0 0 1 4.2 5.2l-.7 3.4a2.3 2.3 0 0 1-4.1.9l-1.5-2h-5.8l-1.5 2a2.3 2.3 0 0 1-4.1-.9l-.7-3.4A4.3 4.3 0 0 1 7 7.5Z"
        strokeLinejoin="round"
      />
      <path d="M8 10.5v3M6.5 12h3M15.5 10.7h.01M17.5 13h.01" strokeLinecap="round" />
    </svg>
  );
}

function DailyIcon({ className }: IconProps) {
  // スプレーボトル
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
      <path d="M9 10.5h6.5l1 10.5h-8.5Z" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M10.5 10.5V6.5h3.5v4M10.5 6.5V4H15" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M17.5 4h2M17.3 6.6l1.6 1" strokeLinecap="round" />
    </svg>
  );
}

function SocialIcon({ className }: IconProps) {
  // ジョッキ（乾杯）
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
      <path d="M6 7.5h10V21H6Z" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M16 10h2a1.8 1.8 0 0 1 1.8 1.8v3.4A1.8 1.8 0 0 1 18 17h-2" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M6 7.5c0-1.6 1-2.7 2.3-2.9C8.8 3.6 9.8 3 11 3s2.2.6 2.7 1.6C15 4.8 16 5.9 16 7.5" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M9 11v6M13 11v6" strokeLinecap="round" />
    </svg>
  );
}

function SubscriptionIcon({ className }: IconProps) {
  // 循環矢印
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
      <path d="M4.5 12a7.5 7.5 0 0 1 12.8-5.3L19 8.4" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M19 4.5v3.9h-3.9" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M19.5 12a7.5 7.5 0 0 1-12.8 5.3L5 15.6" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M5 19.5v-3.9h3.9" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function ClothesIcon({ className }: IconProps) {
  // Tシャツ
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
      <path
        d="m8 4-4.5 3 2 3.2L8 9v11h8V9l2.5 1.2 2-3.2L16 4a4 4 0 0 1-8 0Z"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function BeautyIcon({ className }: IconProps) {
  // 手鏡ときらめき
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
      <circle cx="11" cy="9.5" r="5.5" />
      <path d="M11 15v6M8.5 21h5" strokeLinecap="round" />
      <path d="m19.5 3 .5 1.5L21.5 5 20 5.5 19.5 7 19 5.5 17.5 5 19 4.5Z" strokeLinejoin="round" />
    </svg>
  );
}

function MedicalIcon({ className }: IconProps) {
  // 十字の救急箱
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
      <rect x="3.5" y="7" width="17" height="13" rx="2" />
      <path d="M9 7V5.5A1.5 1.5 0 0 1 10.5 4h3A1.5 1.5 0 0 1 15 5.5V7" strokeLinecap="round" />
      <path d="M12 10.5v6M9 13.5h6" strokeLinecap="round" />
    </svg>
  );
}

function TravelIcon({ className }: IconProps) {
  // 飛行機
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
      <path
        d="M12 3.5c.9 0 1.5.8 1.5 1.8V10l7 4.5v2l-7-2.3v3.3l2 1.6v1.9L12 20l-3.5 1v-1.9l2-1.6v-3.3l-7 2.3v-2l7-4.5V5.3c0-1 .6-1.8 1.5-1.8Z"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function StudyIcon({ className }: IconProps) {
  // 開いた本
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
      <path
        d="M12 6.5C10.4 5 8 4.5 5.5 4.5c-.9 0-1.7.1-2.5.3V18c.8-.2 1.6-.3 2.5-.3 2.5 0 4.9.5 6.5 2 1.6-1.5 4-2 6.5-2 .9 0 1.7.1 2.5.3V4.8c-.8-.2-1.6-.3-2.5-.3C16 4.5 13.6 5 12 6.5Z"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path d="M12 6.5v13" strokeLinecap="round" />
    </svg>
  );
}

function HomeCategoryIcon({ className }: IconProps) {
  // 家とドア
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
      <path d="M3.5 11 12 3.5l8.5 7.5" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M6 9.5V20.5h12V9.5" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M10 20.5v-5.5h4v5.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function CommIcon({ className }: IconProps) {
  // スマホと電波
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
      <rect x="6.5" y="5" width="9" height="16" rx="2" />
      <path d="M10 8h2" strokeLinecap="round" />
      <path d="M17.8 3a5.5 5.5 0 0 1 3 3M17.6 6.2a2.6 2.6 0 0 1 1.4 1.4" strokeLinecap="round" />
    </svg>
  );
}

function OtherIcon({ className }: IconProps) {
  // 丸に3点リーダー
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
      <circle cx="12" cy="12" r="8.5" />
      <path d="M7.8 12h.01M12 12h.01M16.2 12h.01" strokeWidth="2.4" strokeLinecap="round" />
    </svg>
  );
}

function TagIcon({ className }: IconProps) {
  // 値札タグ（ユーザー独自カテゴリのデフォルト）
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
      <path
        d="M3.5 5.5v6l9.3 9.3a1.6 1.6 0 0 0 2.3 0l5.7-5.7a1.6 1.6 0 0 0 0-2.3L11.5 3.5h-6a2 2 0 0 0-2 2Z"
        strokeLinejoin="round"
      />
      <circle cx="7.6" cy="7.6" r="1.3" />
    </svg>
  );
}

const CATEGORY_ICON_MAP: Record<string, (p: IconProps) => ReactElement> = {
  food: FoodIcon,
  transport: TransportIcon,
  fun: FunIcon,
  daily: DailyIcon,
  social: SocialIcon,
  subscription: SubscriptionIcon,
  clothes: ClothesIcon,
  beauty: BeautyIcon,
  medical: MedicalIcon,
  travel: TravelIcon,
  study: StudyIcon,
  home: HomeCategoryIcon,
  comm: CommIcon,
  other: OtherIcon,
  tag: TagIcon,
};

/** categories.icon のキー → 線画SVG。未知の値・旧絵文字はタグにフォールバック */
export function CategoryIcon({ icon, className }: { icon?: string | null; className?: string }) {
  const Cmp = CATEGORY_ICON_MAP[(icon ?? "").trim()] ?? TagIcon;
  return <Cmp className={className} />;
}
