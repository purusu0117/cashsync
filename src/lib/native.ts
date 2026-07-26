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
}

function capGlobal(): CapacitorGlobal | undefined {
  if (typeof window === "undefined") return undefined;
  return (window as unknown as { Capacitor?: CapacitorGlobal }).Capacitor;
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

/** AdMob SDK の初期化（初回のみ。ネイティブ以外では何もしない） */
export function initAdMob(): Promise<void> {
  if (!isNativePlatform()) return Promise.resolve();
  if (!adMobReady) {
    adMobReady = (async () => {
      const { AdMob } = await admob();
      await AdMob.initialize();
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

function photoCleaner(): PhotoCleanerPlugin | null {
  const cap = capGlobal();
  if (!cap?.isNativePlatform?.() || !cap.registerPlugin) return null;
  if (!photoCleanerInstance) {
    photoCleanerInstance = cap.registerPlugin<PhotoCleanerPlugin>("PhotoCleaner");
  }
  return photoCleanerInstance;
}

/** 端末のスクリーンショット一覧（新しい順）。ネイティブ以外は空配列 */
export async function listRecentScreenshots(limit = 30): Promise<ScreenshotItem[]> {
  const plugin = photoCleaner();
  if (!plugin) return [];
  const res = await plugin.listRecentScreenshots({ limit });
  return res.photos ?? [];
}

/**
 * 指定IDの写真を端末から削除（OSの確認ダイアログが出る）。
 * 戻り値: 削除できた枚数（キャンセル時は0）。
 */
export async function deletePhotos(ids: string[]): Promise<{ deleted: number; cancelled?: boolean }> {
  const plugin = photoCleaner();
  if (!plugin || ids.length === 0) return { deleted: 0 };
  return await plugin.deletePhotos({ ids });
}
