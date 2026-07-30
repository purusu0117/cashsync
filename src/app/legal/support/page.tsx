import type { Metadata } from "next";
import { LEGAL } from "@/lib/legal";
import { Faint, Section, Ul } from "../parts";

export const metadata: Metadata = {
  title: `サポート・よくある質問 | ${LEGAL.serviceName}`,
  description: `${LEGAL.serviceName}の使い方・よくある質問・お問い合わせ窓口。`,
};

// App Store審査で必須の「サポートURL」。使い方FAQ＋連絡先を1ページに。
// legalレイアウト配下（認証不要の公開ページ）。
export default function SupportPage() {
  return (
    <article>
      <h1 className="text-xl font-bold">サポート・よくある質問</h1>
      <p className="mt-2 text-[13px] leading-relaxed">
        家計簿アプリ「{LEGAL.serviceName}」の使い方やよくある質問をまとめています。解決しない場合は、ページ下部の連絡先までお問い合わせください。
      </p>

      <Section title="使い方の基本">
        <Ul>
          <li>
            <b>スクショ・レシートから記録</b>：「撮る」タブでレシートを撮影するか、スマホに保存したQR決済・ネット注文の画面を選ぶと、店名・日付・金額・カテゴリ・品目をAIが読み取って自動入力します。内容を確認して保存するだけです。
          </li>
          <li>
            <b>手入力でも記録</b>：金額とカテゴリを選ぶだけの手入力にも対応しています。
          </li>
          <li>
            <b>見える化</b>：ホームで「今日あと使える額」と「月末の予測」、グラフで費目の内訳、カレンダーで日々の支出とバイトの給料を確認できます。
          </li>
        </Ul>
      </Section>

      <Section title="よくある質問">
        <div className="space-y-3">
          <div>
            <p className="font-bold">Q. 読み取りがうまくいきません。</p>
            <p>
              A. 明るい場所で、金額や店名がはっきり写るように撮影してください。QR決済やネット注文は、支払い完了・注文確認の画面のスクリーンショットが最も正確に読み取れます。読み取り結果は保存前に手で修正できます。
            </p>
          </div>
          <div>
            <p className="font-bold">Q. 銀行やクレジットカードと連携できますか？</p>
            <p>
              A. {LEGAL.serviceName}はあえて口座連携を行いません。連携の設定や不安がなく、撮るだけ・選ぶだけで軽く続けられることを大切にしています。
            </p>
          </div>
          <div>
            <p className="font-bold">Q. 読み取った元のスクショはどうなりますか？</p>
            <p>
              A. 記録したあと、元のスクリーンショットをアプリ内から削除できます（あなたが操作したときだけ実行されます）。写真フォルダが散らかりません。
            </p>
          </div>
          <div>
            <p className="font-bold">Q. 撮った画像は保存・学習に使われますか？</p>
            <p>
              A. 画像は読み取りのため一時的に処理されるだけで、サーバーに恒久保存はしません。AIモデルの学習にも使われません。詳しくはプライバシーポリシーをご覧ください。
            </p>
          </div>
          <div>
            <p className="font-bold">Q. パスワードを忘れました。</p>
            <p>
              A. ログイン画面の「パスワードを忘れた方」から、登録メールアドレス宛に再設定リンクをお送りできます。
            </p>
          </div>
          <div>
            <p className="font-bold">Q. アカウントとデータを削除したい。</p>
            <p>
              A. 登録メールアドレスから下記の連絡先へご依頼ください。本人確認のうえ、合理的な期間内にアカウントに紐づく全データを削除します。
            </p>
          </div>
          <div>
            <p className="font-bold">Q. 料金はかかりますか？</p>
            <p>
              A. 基本の機能は無料でお使いいただけます。今後、高精度なAI読み取りを多く使える有料プランを追加する予定です。
            </p>
          </div>
        </div>
      </Section>

      <Section title="動作環境">
        <Ul>
          <li>iPhone（iOS）。TestFlightによるベータ配布時はTestFlightアプリが必要です。</li>
          <li>スクリーンショット読み取りには写真ライブラリへのアクセス許可が必要です。</li>
        </Ul>
      </Section>

      <Section title="お問い合わせ">
        <p>
          不具合のご報告・ご要望・削除依頼などは、以下までお気軽にご連絡ください。個人開発のため返信までお時間をいただく場合があります。
        </p>
        <p>
          運営者：{LEGAL.operatorName}（{LEGAL.operatorType}）
          <br />
          メール：{LEGAL.contactEmail}
        </p>
        <Faint>ご報告の際は、端末（例：iPhone 15）・iOSのバージョン・発生した操作を書き添えていただけると解決が早くなります。</Faint>
      </Section>
    </article>
  );
}
