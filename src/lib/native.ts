// クライアント専用：Capacitor ネイティブ機能のラッパー。
// CashSync のネイティブ版は remote URL 方式（WebView が本番Webを読み込む）のため、
// ネイティブ検出は「ネイティブブリッジが window.Capacitor を注入しているか」で行う。
// Webビルドにネイティブ依存を混ぜないよう、AdMob プラグインは動的 import する。
import type { PhotoCleanerPlugin, ScreenshotItem } from "cashsync-photo-cleaner";

export type { ScreenshotItem };

interface CapacitorGlobal {
  isNativePlatform?: () => boolean;
  getPlatform?: () => string;
  registerPlugin?: <T>(name: string) => T;
  Plugins?: Record<string, unknown>;
}

function capGlobal(): CapacitorGlobal | undefined {
  if (typeof window === "undefined") return undefined;
  return (window as unknown as { Capacitor?: CapacitorGlobal }).Capacitor;
}

/**
 * カスタムプラグインの取得。
 * remote URL 方式では、WebViewに注入される window.Capacitor に registerPlugin が
 * 存在しないことがある（注入されるのは Plugins のプロキシのみ）。
 * そのため ①注入された Plugins ②@capacitor/core の registerPlugin ③window.Capacitor.registerPlugin
 * の順に解決する。ここを1本に決め打ちしていたため、ウィジェット連携と端末登録が
 * 何も実行されずに無視されていた（2026-07-28 大翔の実機報告で判明）。
 */
export async function nativePlugin<T>(name: string): Promise<T | null> {
  if (!isNativePlatform()) return null;
  const cap = capGlobal();
  const injected = cap?.Plugins?.[name];
  if (injected) return injected as T;
  try {
    const core = await import("@capacitor/core");
    if (core?.registerPlugin) return core.registerPlugin<T>(name) as T;
  } catch {
    /* パッケージが解決できない場合は次へ */
  }
  if (cap?.registerPlugin) return cap.registerPlugin<T>(name);
  return null;
}

/** ネイティブアプリ（iOS/Android の Capacitor シェル）内で動いているか */
export function isNativePlatform(): boolean {
  return !!capGlobal()?.isNativePlatform?.();
}

function platform(): "ios" | "android" {
  return capGlobal()?.getPlatform?.() === "ios" ? "ios" : "android";
}

// ---------------------------------------------------------------------------
// AdMob（無料プランのみ上部バナー＋リワード動画）
// ---------------------------------------------------------------------------

// 本番モード: NEXT_PUBLIC_ADMOB_PRODUCTION=1 で本番ユニットID＋テストモード解除。
// それ以外（開発・TestFlight検証中）は Google 公式テストIDで配信する
//（自分の本番広告を表示・クリックするとAdMobポリシー違反になるため）。
const AD_TESTING = process.env.NEXT_PUBLIC_ADMOB_PRODUCTION !== "1";

// 本番の広告ユニットID（iOS・2026-07-26 大翔のAdMobアカウントで発行済み）。
// ユニットIDは公開情報のため直書きでよい。NEXT_PUBLIC_ 環境変数があればそちらを優先。
const PROD_BANNER_ID_IOS = "ca-app-pub-8116409688907735/1061329015";
const PROD_REWARDED_ID_IOS = "ca-app-pub-8116409688907735/2182838994";

const BANNER_AD_ID: Record<"ios" | "android", string> = {
  ios:
    process.env.NEXT_PUBLIC_ADMOB_BANNER_ID_IOS ||
    (AD_TESTING ? "ca-app-pub-3940256099942544/2934735716" : PROD_BANNER_ID_IOS),
  android:
    process.env.NEXT_PUBLIC_ADMOB_BANNER_ID_ANDROID || "ca-app-pub-3940256099942544/6300978111",
};
const REWARDED_AD_ID: Record<"ios" | "android", string> = {
  ios:
    process.env.NEXT_PUBLIC_ADMOB_REWARDED_ID_IOS ||
    (AD_TESTING ? "ca-app-pub-3940256099942544/1712485313" : PROD_REWARDED_ID_IOS),
  android:
    process.env.NEXT_PUBLIC_ADMOB_REWARDED_ID_ANDROID || "ca-app-pub-3940256099942544/5224354917",
};

async function admob() {
  return await import("@capacitor-community/admob");
}

let adMobReady: Promise<void> | null = null;

/**
 * AdMob SDK の初期化（初回のみ。ネイティブ以外では何もしない）。
 *
 * ATT（Appのトラッキング許可ダイアログ）は**出さない**方針（2026-07-26 大翔承認）。
 * プラグイン v8 では ATT は `AdMob.requestTrackingAuthorization()` を明示的に呼んだときだけ出るので、
 * ここでは呼ばない＝ダイアログは表示されない。代わりに広告は常に非パーソナライズ（NPA）で配信する
 * （各広告リクエストの npa: true）。
 * eCPMは多少下がるが、①審査項目が1つ減る ②「許可しますか」で離脱しない、を優先した判断。
 * 方針を変えるときは、この初期化直後に requestTrackingAuthorization() を呼び、
 * Info.plist に NSUserTrackingUsageDescription を戻し、npa を状態に応じて切り替えること。
 */
export function initAdMob(): Promise<void> {
  if (!isNativePlatform()) return Promise.resolve();
  if (!adMobReady) {
    adMobReady = (async () => {
      const { AdMob } = await admob();
      await AdMob.initialize(); // ATTは要求しない（呼ばなければダイアログは出ない）
    })().catch((e) => {
      adMobReady = null; // 失敗時は次回リトライ
      throw e;
    });
  }
  return adMobReady;
}

/** 上部バナー広告を表示（free プランのネイティブ利用時のみ呼ぶ） */
export async function showTopBanner(): Promise<void> {
  if (!isNativePlatform()) return;
  await initAdMob();
  const { AdMob, BannerAdPosition, BannerAdSize } = await admob();
  await AdMob.showBanner({
    adId: BANNER_AD_ID[platform()],
    adSize: BannerAdSize.BANNER, // 高さ50px固定（CSS側の余白と対応）
    position: BannerAdPosition.TOP_CENTER,
    margin: 0,
    isTesting: AD_TESTING,
    npa: true, // ATTを出さない方針のため常に非パーソナライズ広告
  });
}

/** 上部バナー広告を消す */
export async function removeTopBanner(): Promise<void> {
  if (!isNativePlatform()) return;
  const { AdMob } = await admob();
  await AdMob.removeBanner();
}

/**
 * リワード動画広告を表示し、視聴完了（リワード獲得）したかを返す。
 * 読み込み失敗・途中離脱は false。
 */
export async function showRewardedAd(): Promise<boolean> {
  if (!isNativePlatform()) return false;
  await initAdMob();
  const { AdMob, RewardAdPluginEvents } = await admob();
  let rewarded = false;
  const handles = await Promise.all([
    AdMob.addListener(RewardAdPluginEvents.Rewarded, () => {
      rewarded = true;
    }),
  ]);
  // 閉じられた or 表示失敗で完了とみなす
  const done = new Promise<void>((resolve) => {
    AdMob.addListener(RewardAdPluginEvents.Dismissed, () => resolve()).then((h) =>
      handles.push(h),
    );
    AdMob.addListener(RewardAdPluginEvents.FailedToShow, () => resolve()).then((h) =>
      handles.push(h),
    );
  });
  try {
    await AdMob.prepareRewardVideoAd({
      adId: REWARDED_AD_ID[platform()],
      isTesting: AD_TESTING,
      npa: true, // ATTを出さない方針のため常に非パーソナライズ広告
    });
    await AdMob.showRewardVideoAd();
    await done;
  } finally {
    for (const h of handles) h.remove().catch(() => {});
  }
  return rewarded;
}

// ---------------------------------------------------------------------------
// PhotoCleaner（カスタムプラグイン：スクショ一覧・削除）
// ---------------------------------------------------------------------------

let photoCleanerInstance: PhotoCleanerPlugin | null = null;

async function photoCleaner(): Promise<PhotoCleanerPlugin | null> {
  if (!photoCleanerInstance) {
    photoCleanerInstance = await nativePlugin<PhotoCleanerPlugin>("PhotoCleaner");
  }
  return photoCleanerInstance;
}

/** 端末のスクリーンショット一覧（新しい順）。ネイティブ以外は空配列 */
export async function listRecentScreenshots(limit = 30): Promise<ScreenshotItem[]> {
  const plugin = await photoCleaner();
  if (!plugin) return [];
  const res = await plugin.listRecentScreenshots({ limit });
  return res.photos ?? [];
}

/**
 * 指定IDの写真を端末から削除（OSの確認ダイアログが出る）。
 * 戻り値: 削除できた枚数（キャンセル時は0）。
 */
export async function deletePhotos(ids: string[]): Promise<{ deleted: number; cancelled?: boolean }> {
  const plugin = await photoCleaner();
  if (!plugin || ids.length === 0) return { deleted: 0 };
  return await plugin.deletePhotos({ ids });
}

// ---------------------------------------------------------------------------
// ホーム画面ウィジェット連携 ＋ ローカル通知（どちらもネイティブのみ）
// ---------------------------------------------------------------------------

/**
 * ウィジェットが /api/widget を叩けるよう、APIトークンと接続先を端末側（App Group）に渡す。
 * ウィジェットはアプリとは別プロセスでセッションCookieを読めないため、これが無いと
 * 「アプリでログインするとここに残額が出ます」の表示のままになる。
 */
export async function syncWidgetAuth(token: string): Promise<void> {
  const plugin = await photoCleaner();
  if (!plugin || !token) return;
  await plugin
    .setWidgetAuth({ token, baseUrl: window.location.origin })
    .catch(() => {}); // 失敗してもアプリ本体の動作は止めない
}

/** ログアウト時：ウィジェットに残額が出続けないよう保存データを消す */
export async function clearWidgetAuth(): Promise<void> {
  const plugin = await photoCleaner();
  if (!plugin) return;
  await plugin.clearWidgetAuth().catch(() => {});
}

/**
 * APNs（サーバーからのプッシュ）の端末登録。
 * 「読み取りが終わりました」などアプリを閉じている間に起きたことを届けるために必要。
 * 権限が拒否されている場合は何もしない（アプリの他の機能には影響しない）。
 */
export async function registerPushDevice(): Promise<void> {
  if (!isNativePlatform()) return;
  try {
    const { PushNotifications } = await import("@capacitor/push-notifications");
    const perm = await PushNotifications.checkPermissions();
    let granted = perm.receive === "granted";
    if (!granted) {
      const asked = await PushNotifications.requestPermissions();
      granted = asked.receive === "granted";
    }
    if (!granted) return;
    // 端末トークンはイベントで返ってくる（登録は毎回呼んでよい・冪等）
    await PushNotifications.addListener("registration", (token) => {
      fetch("/api/push/device", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: token.value, platform: "ios" }),
      }).catch(() => {});
    });
    await PushNotifications.register();
  } catch {
    /* プラグイン未対応環境では何もしない */
  }
}

/**
 * 記録リマインドのローカル通知を設定（hour<0 で解除）。
 * サーバーからのプッシュと違い証明書不要で、機内モードでも端末内で発火する。
 */
export async function scheduleLocalReminder(
  hour: number,
): Promise<{ scheduled: boolean; denied?: boolean }> {
  const plugin = await photoCleaner();
  if (!plugin) return { scheduled: false };
  try {
    return await plugin.scheduleReminder({ hour });
  } catch {
    return { scheduled: false };
  }
}
