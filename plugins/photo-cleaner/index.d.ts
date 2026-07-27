/**
 * CashSync photo-cleaner プラグインの型定義。
 * アプリ本体（src/lib/native.ts）は window.Capacitor.registerPlugin 経由で呼ぶため
 * この JS 実装を直接 import しないが、型はここを単一のソースとする。
 */
export interface ScreenshotItem {
  /** iOS: PHAsset.localIdentifier / Android: content:// URI 文字列 */
  id: string;
  /** 撮影日時（エポックms。不明なら0） */
  takenAt: number;
}

export interface PhotoCleanerPlugin {
  /** 端末のスクリーンショット（新しい順）を最大 limit 件返す */
  listRecentScreenshots(options?: { limit?: number }): Promise<{ photos: ScreenshotItem[] }>;
  /**
   * 指定IDの写真を削除する。OSの確認ダイアログが表示され、
   * ユーザーがキャンセルした場合は { deleted: 0, cancelled: true }。
   */
  deletePhotos(options: { ids: string[] }): Promise<{ deleted: number; cancelled?: boolean }>;
  /** ホーム画面ウィジェット用に、APIトークンと接続先を App Group へ保存する */
  setWidgetAuth(options: { token: string; baseUrl?: string }): Promise<{ ok: boolean }>;
  /** ログアウト時にウィジェットの保存データを消す */
  clearWidgetAuth(): Promise<{ ok: boolean }>;
  /**
   * アプリが計算した最新の「今日あと使える額」をウィジェットへ即反映する（App Group保存＋即リロード）。
   * これにより、記録直後にウィジェットが /api/widget を叩き直すのを待たずに新しい残額が出る。
   */
  setWidgetBudget(options: {
    remainingToday: number;
    todayBudget: number;
    spentToday: number;
    nextPaydayDate?: string | null;
    nextPaydayAmount?: number;
  }): Promise<{ ok: boolean }>;
  /** 記録リマインドのローカル通知を毎日 hour:00 に設定（hour<0 で解除） */
  scheduleReminder(options: { hour: number }): Promise<{ scheduled: boolean; denied?: boolean }>;
}

export declare const PhotoCleaner: PhotoCleanerPlugin;
