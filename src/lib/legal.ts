// 法務ページ（/legal/privacy・/legal/terms）の定数
// 運営者名・連絡先・改定日はここだけ直せば全ページに反映される
export const LEGAL = {
  serviceName: "CashSync",
  operatorName: "吉武 大翔",
  operatorType: "個人開発者",
  contactEmail: "daito150117@gmail.com",
  // 制定日・最終改定日（YYYY年M月D日表記）
  privacyEnacted: "2026年7月26日",
  privacyUpdated: "2026年7月26日",
  termsEnacted: "2026年7月26日",
  termsUpdated: "2026年7月26日",
} as const;
