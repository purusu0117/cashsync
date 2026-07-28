// メール送信（パスワード再設定用）。
// RESEND_API_KEY があれば Resend API を fetch で直接叩く（SDK不要）。
// 無ければコンソールにリンクを出力する開発モード（ローカル運用でもリセットを完結できる）。
const RESEND_ENDPOINT = "https://api.resend.com/emails";

export async function sendPasswordResetMail(to: string, resetUrl: string): Promise<void> {
  const subject = "CashSync パスワード再設定";
  const text = [
    "CashSync のパスワード再設定を受け付けました。",
    "",
    "次のリンクを開いて、新しいパスワードを設定してください（有効期限：1時間）。",
    resetUrl,
    "",
    "心当たりがない場合は、このメールは無視してください（パスワードは変更されません）。",
  ].join("\n");

  await sendMail(to, subject, text, "パスワード再設定リンク");
}

/** 公開前の不正対策①：新規登録のメール確認リンク。password_reset と同じResend基盤を流用する。 */
export async function sendVerificationMail(to: string, verifyUrl: string): Promise<void> {
  const subject = "CashSync メールアドレスの確認";
  const text = [
    "CashSync へのご登録ありがとうございます。",
    "",
    "次のリンクを開いて、メールアドレスの確認を完了してください（有効期限：24時間）。",
    verifyUrl,
    "",
    "確認が済むと、レシート読み取りなどの機能がご利用いただけます。",
    "心当たりがない場合は、このメールは無視してください。",
  ].join("\n");
  await sendMail(to, subject, text, "メール確認リンク");
}

/**
 * Resend でメールを送る共通処理。RESEND_API_KEY が無ければ開発モード（リンクをログ出力）。
 * 送信失敗は throw する（呼び出し元でハンドリング）。新規シークレットは不要＝既存の環境変数を流用。
 */
async function sendMail(to: string, subject: string, text: string, devLabel: string): Promise<void> {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    // 開発モード：メール基盤が無くてもフローを確認できるように内容をログに出す
    console.log(`[CashSync] ${devLabel}（開発モード・メール未送信）: ${to} -> ${text}`);
    return;
  }
  const res = await fetch(RESEND_ENDPOINT, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: process.env.MAIL_FROM || "CashSync <onboarding@resend.dev>",
      to: [to],
      subject,
      text,
    }),
  });
  if (!res.ok) {
    throw new Error(`resend failed: ${res.status} ${await res.text().catch(() => "")}`);
  }
}
