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

  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    // 開発モード：メール基盤が無くてもフローを確認できるようにリンクをログに出す
    console.log(`[CashSync] パスワード再設定リンク（開発モード・メール未送信）: ${to} -> ${resetUrl}`);
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
    // 送信失敗は呼び出し元でハンドリング（ユーザーへは常に同じ文言を返すため throw で伝える）
    throw new Error(`resend failed: ${res.status} ${await res.text().catch(() => "")}`);
  }
}
