// 法務ページ（/legal/privacy・/legal/terms）の定数
// 運営者名・連絡先・改定日はここだけ直せば全ページに反映される
export const LEGAL = {
  serviceName: "CashSync",
  // 公開ページでは実名を出さず開発者名（屋号）で表記。運営者の氏名・住所は
  // 法令に基づく請求があった場合に遅滞なく開示する運用（無料アプリのため常時掲示はしない）。
  operatorName: "Sync Apps",
  operatorType: "個人開発",
  contactEmail: "daito150117@gmail.com",
  // 制定日・最終改定日（YYYY年M月D日表記）
  privacyEnacted: "2026年7月26日",
  privacyUpdated: "2026年7月26日",
  termsEnacted: "2026年7月26日",
  termsUpdated: "2026年7月26日",
} as const;
