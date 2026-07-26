<!-- 本来の置き場所: C:\Users\daito\projects\cashsync-design\store\iap-setup-guide.md（worktree隔離のためリポジトリ内に置いた。コピーして使う） -->
# CashSync プレミアム課金（App内課金）セットアップガイド

Apple審査（アプリ本体）を通過したあと、大翔がやる作業のすべて。
これを完了すると、iOSアプリの設定画面に「プレミアムにアップグレード ¥480/月」ボタンが出て、購入→`users.plan='premium'` 切替→広告非表示・Sonnet読取・無制限（フェアユース月200スキャン）が動く。

## 実装済みの前提（コード側・作業不要）

- クライアント: `src/lib/purchases.ts`（RevenueCat SDK、動的import・キー未設定なら購入UI非表示）
- サーバー: `/api/purchases/webhook`（真実のソース）・`/api/purchases/sync`（購入直後の即時反映）
- 設定画面: プランセクション（アップグレード／購入の復元／特典説明）
- iOSネイティブ: `@revenuecat/purchases-capacitor@13.2.4` を Package.swift に登録済み（`npx cap sync ios` 済み。Mac側でXcodeを開けばSPMが自動解決する）
- 固定値（コードと一致させること）:

```
商品ID（productId）     : cashsync_premium_monthly
entitlement ID          : premium
価格                    : ¥480/月（自動更新サブスクリプション）
Webhook URL             : https://cashsync-eight.vercel.app/api/purchases/webhook
```

---

## ① App Store Connect でサブスク商品を作る

場所: https://appstoreconnect.apple.com/ → マイApp → CashSync → 左メニュー「収益化 > サブスクリプション」

1. **サブスクリプショングループを作成**
   - 「作成」→ 参照名を入力（ユーザーには見えない管理名）:

```
CashSync Premium
```

2. グループ内で **「サブスクリプションを作成」**
   - 参照名:

```
CashSync プレミアム（月額）
```

   - 製品ID（**コードと完全一致必須・後から変更不可**）:

```
cashsync_premium_monthly
```

3. 作成した商品を開いて設定:
   - サブスクリプション期間: **1ヶ月**
   - 価格: 「価格を追加」→ 日本 **¥480**（他国は自動換算でOK）
   - App Store ローカリゼーション（日本語）:
     - 表示名: `プレミアム`
     - 説明: `広告なし・高精度AI読取・回数無制限（フェアユースあり）`
4. **審査用スクリーンショット**（設定画面のプランセクションのスクショでOK）とメモを添付して「審査へ提出」
   - 注意: サブスク商品自体にも審査がある。アプリ本体のアップデート審査と一緒に出すのが速い
5. 「App内課金がある」ことをアプリの審査情報でも申告（バージョン情報ページのApp内課金欄に商品を追加）

> 参考: https://developer.apple.com/jp/help/app-store-connect/manage-subscriptions/offer-auto-renewable-subscriptions/

## ② 有料App契約・税務・銀行口座（お金を受け取るための登録）

**これを完了しないとサブスク商品が「Ready to Submit」にならない**（審査にも出せない）。

場所: https://appstoreconnect.apple.com/ → 右上のアカウント → **「契約 / 税金 / 口座情報」**（Business / Agreements, Tax, and Banking）

1. **Paid Apps（有料App）契約**に同意する
2. **銀行口座**を登録（大翔の受取口座。日本の普通口座でOK）
3. **税務フォーム**を提出:
   - 日本の税務情報
   - 米国税務フォーム（W-8BEN。個人なら数分で完了）
4. ステータスが「有効（Active）」になるのを確認

> お金の流れ: ユーザーが¥480払う → Appleが手数料を引く（**App Store Small Business Programに申し込めば15%**、未申込なら30%）→ 月次で締めて**約33日後**に登録した銀行口座へ振込（最低支払額あり）。
> Small Business Program（年収益$100万以下なら15%）: https://developer.apple.com/jp/app-store/small-business-program/ から**申込制**なので忘れずに。

## ③ RevenueCat セットアップ → Vercel 環境変数 → Webhook 登録

### 3-1. アカウントとプロジェクト

1. https://app.revenuecat.com/signup でアカウント作成（無料。月間収益$2,500までFreeプランでOK）
2. プロジェクトを作成: 名前 `CashSync`
3. **iOSアプリを追加**: Project Settings → Apps → 「+ New」→ App Store
   - Bundle ID:

```
com.daito.cashsync
```

   - **In-App Purchase Key（StoreKit 2用・必須）**を登録:
     - App Store Connect → 「ユーザとアクセス > 統合 > App内課金」→ キーを生成して `.p8` をダウンロード → Issuer ID / Key ID と一緒にRevenueCatのApp設定にアップロード
     - 手順: https://www.revenuecat.com/docs/service-credentials/itunesconnect-app-specific-shared-secret/in-app-purchase-key-configuration
   - App Store Connect API Key の接続も推奨（商品情報の自動取得用）

### 3-2. 商品・Entitlement・Offering（RevenueCatダッシュボード）

1. **Products**: 「+ New」→ App Store → 商品IDを入力:

```
cashsync_premium_monthly
```

2. **Entitlements**: 「+ New」→ ID は**必ずこれ**（コードが参照している）:

```
premium
```

   → この entitlement に `cashsync_premium_monthly` をアタッチ
3. **Offerings**: `default` offering に Monthly パッケージを作成し `cashsync_premium_monthly` を割当
   （コードは「default offering の月額パッケージ」を探す実装）

### 3-3. Vercel 環境変数

場所: https://vercel.com/ → cashsync プロジェクト → Settings → Environment Variables（Production）

| 変数名 | 値の取り方 |
|---|---|
| `NEXT_PUBLIC_REVENUECAT_IOS_KEY` | RevenueCat → Project Settings → **API Keys** → App Store の **Public app-specific API key**（`appl_` で始まる） |
| `REVENUECAT_WEBHOOK_AUTH` | 自分で決める長いランダム文字列（下のコマンドで生成）。RevenueCat側のWebhook設定と**同じ値**を入れる |
| `REVENUECAT_SECRET_KEY`（任意・推奨） | RevenueCat → API Keys → **Secret key**（`sk_` で始まる）。設定すると `/api/purchases/sync` がクライアント申告を信用せずRevenueCatに照会して検証する |

ランダム文字列の生成（PowerShell）:

```powershell
-join ((48..57)+(97..122) | Get-Random -Count 48 | ForEach-Object {[char]$_})
```

⚠️ **`NEXT_PUBLIC_` はビルド時に埋め込まれる** → 環境変数を入れたら**再デプロイ必須**（Deployments → Redeploy）。再デプロイするまでアプリに購入ボタンは出ない（出ない間も壊れず「準備中」表示になるだけ）。

### 3-4. Webhook 登録

場所: RevenueCat → Project Settings → **Integrations → Webhooks** → 「+ New」

- Webhook URL:

```
https://cashsync-eight.vercel.app/api/purchases/webhook
```

- **Authorization header value**: Vercelに入れた `REVENUECAT_WEBHOOK_AUTH` と同じ値
- Environment: Production と Sandbox 両方（テスト購入もWebhookで確認できるように）
- Event type: All events でOK（サーバー側で必要なものだけ処理する）

> 動作仕様: INITIAL_PURCHASE / RENEWAL / UNCANCELLATION / PRODUCT_CHANGE → premium、EXPIRATION → free、CANCELLATION は解約予約なので期限までpremium維持（返金等の即時失効のみfree）。**founderは何が来ても不変**。

## ④ Sandbox テスト購入の確認方法

1. **Sandboxテスターを作る**: App Store Connect → 「ユーザとアクセス > Sandbox > テスターアカウント」→ 「+」
   - 実在しないメールでOK（例: `daito.sandbox1@icloud.com`）。**本物のApple IDは使わない**
   - 手順: https://developer.apple.com/jp/help/app-store-connect/test-in-app-purchases/create-sandbox-apple-accounts/
2. **実機の設定**: iPhoneの「設定 > App Store > サンドボックスアカウント」に上のテスターでサインイン（本体のApple IDはそのままでよい）
3. **TestFlight版（またはXcodeから直接インストールした版）のCashSync**で:
   - 設定画面 → 「プレミアムにアップグレード ¥480/月」→ Appleの購入シートに **[Environment: Sandbox]** と出ることを確認 → 購入
   - 購入直後にプラン表示が「プレミアム」になり、上部バナー広告が消えれば成功（アプリ再起動でも確認）
4. **裏側の確認**:
   - RevenueCat → Customers に自分のユーザーID（CashSyncのユーザーID）が出て、`premium` entitlement がActive
   - RevenueCat → Project Settings → Webhooks → イベント履歴が `200` で届いている
   - DB: `users.plan` が `premium` になっている
5. **自動更新・失効のテスト**: Sandboxでは時間が超圧縮される（**1ヶ月サブスク＝5分で更新**、既定で12回更新後に自動失効）
   - 5分待つ → RENEWAL が届く
   - 放置して失効 → EXPIRATION が届いて `plan` が `free` に戻り、広告が復活すれば一連の流れは完璧
   - サブスク管理は iPhone「設定 > App Store > サンドボックスアカウント > 管理」からもキャンセルできる
6. **購入の復元テスト**: アプリを削除→再インストール（または別端末で同じアカウント）→ 設定 → 「購入の復元」→ プレミアムに戻ればOK

## トラブルシューティング

- **購入ボタンが出ない**: `NEXT_PUBLIC_REVENUECAT_IOS_KEY` 設定後に再デプロイしたか／ネイティブアプリ（WebView）で開いているか（Safariでは出ない仕様）
- **「商品情報を取得できませんでした」**: App Store Connectの商品が「Ready to Submit」以上か／②の契約が有効か／RevenueCatのOfferingに商品が割り当ててあるか。契約締結〜商品がSandboxに反映されるまで数時間かかることがある
- **購入できたのにplanが変わらない**: Webhookイベント履歴のレスポンスコードを見る。`401`=Authorization値の不一致、`503`=`REVENUECAT_WEBHOOK_AUTH`未設定。アプリ側は「購入の復元」でも再同期できる
- **審査時の注意**: 審査員はSandboxで実際に購入を試す。サブスクには利用規約・プライバシーポリシーへのリンクが必要（アプリに実装済み: `/legal/terms`・`/legal/privacy`。App Store Connectのアプリ説明欄にもEULA/プライバシーポリシーURLを記載しておく）
