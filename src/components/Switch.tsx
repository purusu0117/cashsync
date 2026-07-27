"use client";

// iOS標準に寄せたトグルスイッチ。
// ON/OFFを文字ではなく「ツマミの位置＋色」で示すので、一目で状態が分かる（大翔の指摘 2026-07-27）。
// 見た目はiOS準拠（OFF=グレー / ON=緑）だが、CashSyncの世界観に合わせてONは収入緑（sage）を使う。
export default function Switch({
  checked,
  onChange,
  label,
  disabled = false,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: string; // 読み上げ用（画面には出ない）
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`relative inline-flex h-[31px] w-[51px] shrink-0 items-center rounded-full transition-colors duration-200 disabled:opacity-50 ${
        checked ? "bg-sage" : "bg-rule"
      }`}
    >
      <span
        className={`inline-block h-[27px] w-[27px] rounded-full bg-white shadow transition-transform duration-200 ${
          checked ? "translate-x-[22px]" : "translate-x-[2px]"
        }`}
      />
    </button>
  );
}
