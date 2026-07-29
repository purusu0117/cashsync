import type { Metadata } from "next";
import { LEGAL } from "@/lib/legal";
import { Faint, Section, Ul } from "../parts";

export const metadata: Metadata = {
  title: `プライバシーポリシー | ${LEGAL.serviceName}`,
  description: `${LEGAL.serviceName}のプライバシーポリシー（個人情報の取り扱いについて）`,
};

export default function PrivacyPage() {
  return (
    <article>
      <h1 className="text-xl font-bold">プライバシーポリシー</h1>
      <p className="mt-2 text-[13px] leading-relaxed">
        {LEGAL.operatorType}・{LEGAL.operatorName}（以下「運営者」）は、家計簿アプリ「{LEGAL.serviceName}
        」（以下「本サービス」）における利用者の情報の取り扱いについて、以下のとおりプライバシーポリシー（以下「本ポリシー」）を定めます。
      </p>

      <Section title="1. 収集する情報">
        <p>本サービスは、以下の情報を収集・保存します。</p>
        <Ul>
          <li>
            <b>アカウント情報</b>：メールアドレス、パスワード（scrypt方式でハッシュ化して保存し、平文では保存しません）、表示名
          </li>
          <li>
            <b>家計簿データ</b>：支出・収入の記録（金額、店名、カテゴリ、メモ、日付等）、シフト・バイト先情報（時給等）、貯金目標などの設定
          </li>
          <li>
            <b>AI読取のための画像・テキスト</b>：レシート写真、決済アプリ等のスクリーンショット、入力テキスト（取り扱いは第3条参照）
          </li>
          <li>
            <b>Googleカレンダーの予定情報</b>：利用者が明示的に連携を許可した場合のみ、シフト取込のため読み取り専用（calendar.readonly）でアクセスします
          </li>
          <li>
            <b>広告識別子（IDFA等）</b>：iOSアプリの無料プランで広告表示のために利用されることがあります（第5条参照）
          </li>
          <li>
            <b>プッシュ通知の購読情報</b>：利用者が通知をオンにした場合のみ
          </li>
        </Ul>
        <p>クレジットカード番号などの決済情報は、本サービスでは取得・保存しません。</p>
      </Section>

      <Section title="2. 利用目的">
        <Ul>
          <li>本サービスの提供（家計簿の記録・集計・給料計算・通知等）</li>
          <li>レシート・スクリーンショット・入力テキストのAIによる読み取りと記録の自動作成</li>
          <li>アカウントの認証と不正利用の防止</li>
          <li>無料プランにおける広告の表示</li>
          <li>お問い合わせへの対応、重要なお知らせの連絡</li>
          <li>サービスの改善（統計的な利用状況の把握）</li>
        </Ul>
      </Section>

      <Section title="3. AIによる読み取り処理">
        <Ul>
          <li>
            レシート・スクリーンショットの画像や入力テキストは、解析のためAnthropic社のAPIに送信されます。Anthropic社の商用APIポリシーに基づき、送信されたデータがAIモデルの学習に使われることはありません。
          </li>
          <li>
            送信された画像は解析のための一時的な処理にのみ使用し、解析後に本サービスのサーバーへ恒久的に保存することはありません。
          </li>
          <li>読み取り結果（店名・金額・日付等のテキストデータ）は、家計簿データとして保存されます。</li>
        </Ul>
      </Section>

      <Section title="4. 第三者提供・外部サービス">
        <p>
          運営者は、法令に基づく場合を除き、利用者の同意なく個人情報を第三者に提供しません。ただし、本サービスの提供にあたり、以下の外部サービスへデータの処理を委託しています。
        </p>
        <Ul>
          <li>
            <b>Supabase</b>（データベースホスティング・サーバー所在地：東京リージョン）：アカウント情報・家計簿データの保存
          </li>
          <li>
            <b>Anthropic</b>（AI解析API）：レシート等の画像・テキストの読み取り処理
          </li>
          <li>
            <b>Google</b>（Googleカレンダー）：利用者が許可した場合のみ、予定の読み取り
          </li>
          <li>
            <b>Google AdMob</b>（広告配信）：iOSアプリの無料プランにおける広告表示
          </li>
        </Ul>
        <Faint>各サービスにおけるデータの取り扱いは、各社のプライバシーポリシーに従います。</Faint>
      </Section>

      <Section title="5. 広告と広告識別子（iOSアプリ）">
        <Ul>
          <li>iOSアプリの無料プランでは、Google AdMobによるバナー広告およびリワード広告を表示します。</li>
          <li>
            パーソナライズされた広告の表示にあたっては、iOSのAppトラッキング透明性（ATT）の仕組みに基づき、事前に利用者の許可を求めます。許可しない場合もパーソナライズされない広告が表示され、本サービスは引き続き利用できます。
          </li>
          <li>広告配信のためにAdMobが広告識別子（IDFA等）や端末情報を取得することがあります。</li>
          <li>有料プラン（プレミアム）では広告は表示されません。</li>
        </Ul>
      </Section>

      <Section title="6. 写真ライブラリへのアクセス（iOSアプリ）">
        <Ul>
          <li>
            スクリーンショット読取機能のため、利用者が操作したときのみ写真ライブラリにアクセスします。バックグラウンドで自動的に写真を読み取ることはありません。
          </li>
          <li>
            読取済みスクリーンショットの削除機能は、利用者の明示的な操作に基づいてのみ実行されます。
          </li>
        </Ul>
      </Section>

      <Section title="7. Cookie・プッシュ通知">
        <Ul>
          <li>ログイン状態の維持のため、セッション用Cookieを使用します。</li>
          <li>
            プッシュ通知（Web Push）は任意です。利用者がオンにした場合のみ購読情報を保存し、いつでもオフにできます。
          </li>
        </Ul>
      </Section>

      <Section title="8. 安全管理">
        <p>
          通信の暗号化（TLS）、パスワードのハッシュ化（scrypt）等、利用者の情報を保護するために合理的な安全管理措置を講じます。
        </p>
      </Section>

      <Section title="9. 保存期間とデータの削除">
        <Ul>
          <li>アカウント情報・家計簿データは、アカウントが存続する間保存されます。</li>
          <li>
            アカウントおよび全データの削除を希望する場合は、登録メールアドレスから下記連絡先へご依頼ください。本人確認のうえ、合理的な期間内にアカウントに紐づく全データを削除します。
          </li>
        </Ul>
      </Section>

      <Section title="10. 本ポリシーの改定">
        <p>
          本ポリシーは必要に応じて改定することがあります。重要な変更がある場合は、本サービス内での表示等によりお知らせします。改定後の本ポリシーは、本ページに掲載した時点から効力を生じます。
        </p>
      </Section>

      <Section title="11. お問い合わせ">
        <p>
          本ポリシーおよび個人情報の取り扱いに関するお問い合わせ・削除依頼は、以下までご連絡ください。
        </p>
        <p>
          運営者：{LEGAL.operatorName}（{LEGAL.operatorType}）
          <br />
          メール：{LEGAL.contactEmail}
        </p>
      </Section>

      <div className="mt-5 border-t border-rule pt-3">
        <Faint>
          制定日：{LEGAL.privacyEnacted}／最終改定日：{LEGAL.privacyUpdated}
        </Faint>
      </div>
    </article>
  );
}
