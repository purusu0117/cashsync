import Foundation
import Capacitor
import Photos
import UserNotifications
import WidgetKit

/// CashSync カスタムプラグイン：
///  - 端末のスクリーンショット一覧取得と削除（削除はOS標準の確認ダイアログつき）
///  - ホーム画面ウィジェットへのログイン情報の受け渡し（App Group 経由）
///  - 記録リマインドのローカル通知（毎日指定時刻・端末内で完結）
@objc(PhotoCleanerPlugin)
public class PhotoCleanerPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "PhotoCleanerPlugin"
    public let jsName = "PhotoCleaner"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "listRecentScreenshots", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "deletePhotos", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setWidgetAuth", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "clearWidgetAuth", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setWidgetBudget", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "scheduleReminder", returnType: CAPPluginReturnPromise)
    ]

    private let appGroupId = "group.com.daito.cashsync"

    /// ウィジェットが /api/widget を叩けるように、トークンとベースURLを App Group に保存する。
    /// これが無いとウィジェットは「アプリでログインすると…」のままになる。
    @objc func setWidgetAuth(_ call: CAPPluginCall) {
        guard let token = call.getString("token"), !token.isEmpty else {
            call.reject("token required")
            return
        }
        guard let defaults = UserDefaults(suiteName: appGroupId) else {
            call.reject("app group unavailable")
            return
        }
        defaults.set(token, forKey: "apiToken")
        if let baseUrl = call.getString("baseUrl"), !baseUrl.isEmpty {
            defaults.set(baseUrl, forKey: "baseUrl")
        }
        WidgetCenter.shared.reloadAllTimelines()
        call.resolve(["ok": true])
    }

    /// ログアウト時に呼ぶ。ウィジェットに残額が出続けないようにする。
    @objc func clearWidgetAuth(_ call: CAPPluginCall) {
        if let defaults = UserDefaults(suiteName: appGroupId) {
            for key in ["apiToken", "remainingToday", "todayBudget", "spentToday", "nextPaydayDate", "nextPaydayAmount", "updatedAt"] {
                defaults.removeObject(forKey: key)
            }
        }
        WidgetCenter.shared.reloadAllTimelines()
        call.resolve(["ok": true])
    }

    /// アプリが計算した最新の「今日あと使える額」を、ウィジェットへ即座に反映する。
    /// アプリはホームで /api/summary を取得するたびにこれを呼ぶ。ウィジェットは App Group から
    /// この値を読めるので、記録直後にネットワーク往復を待たずに新しい残額を表示できる
    /// （従来はウィジェット自身が /api/widget を叩き直すまで最大30分＋通信待ちだった）。
    @objc func setWidgetBudget(_ call: CAPPluginCall) {
        guard let defaults = UserDefaults(suiteName: appGroupId) else {
            call.reject("app group unavailable")
            return
        }
        defaults.set(call.getInt("remainingToday") ?? 0, forKey: "remainingToday")
        defaults.set(call.getInt("todayBudget") ?? 0, forKey: "todayBudget")
        defaults.set(call.getInt("spentToday") ?? 0, forKey: "spentToday")
        if let payday = call.getString("nextPaydayDate"), !payday.isEmpty {
            defaults.set(payday, forKey: "nextPaydayDate")
        } else {
            defaults.removeObject(forKey: "nextPaydayDate")
        }
        defaults.set(call.getInt("nextPaydayAmount") ?? 0, forKey: "nextPaydayAmount")
        defaults.set(Date().timeIntervalSince1970, forKey: "updatedAt")
        WidgetCenter.shared.reloadAllTimelines()
        call.resolve(["ok": true])
    }

    /// 記録リマインドのローカル通知（毎日 hour:00）。hour が負なら解除。
    /// サーバーからのプッシュと違い証明書不要で、端末内で完結する。
    @objc func scheduleReminder(_ call: CAPPluginCall) {
        let hour = call.getInt("hour") ?? -1
        let center = UNUserNotificationCenter.current()
        let identifier = "cashsync-record-reminder"
        center.removePendingNotificationRequests(withIdentifiers: [identifier])
        if hour < 0 || hour > 23 {
            call.resolve(["scheduled": false])
            return
        }
        center.requestAuthorization(options: [.alert, .sound, .badge]) { granted, _ in
            guard granted else {
                call.resolve(["scheduled": false, "denied": true])
                return
            }
            let content = UNMutableNotificationContent()
            content.title = "CashSync"
            content.body = "今日の記録がまだです。レシートを撮るだけなら3秒で終わります"
            content.sound = .default
            var components = DateComponents()
            components.hour = hour
            components.minute = 0
            let trigger = UNCalendarNotificationTrigger(dateMatching: components, repeats: true)
            center.add(UNNotificationRequest(identifier: identifier, content: content, trigger: trigger)) { error in
                if let error = error {
                    call.reject(error.localizedDescription)
                } else {
                    call.resolve(["scheduled": true])
                }
            }
        }
    }

    @objc func listRecentScreenshots(_ call: CAPPluginCall) {
        let limit = call.getInt("limit") ?? 30
        PHPhotoLibrary.requestAuthorization(for: .readWrite) { status in
            guard status == .authorized || status == .limited else {
                call.reject("photo library permission denied")
                return
            }
            let fetchOptions = PHFetchOptions()
            fetchOptions.sortDescriptors = [NSSortDescriptor(key: "creationDate", ascending: false)]
            fetchOptions.fetchLimit = limit
            var items: [[String: Any]] = []
            let collections = PHAssetCollection.fetchAssetCollections(
                with: .smartAlbum,
                subtype: .smartAlbumScreenshots,
                options: nil
            )
            if let album = collections.firstObject {
                let assets = PHAsset.fetchAssets(in: album, options: fetchOptions)
                assets.enumerateObjects { asset, _, _ in
                    items.append([
                        "id": asset.localIdentifier,
                        "takenAt": asset.creationDate.map { Int($0.timeIntervalSince1970 * 1000) } ?? 0
                    ])
                }
            }
            call.resolve(["photos": items])
        }
    }

    @objc func deletePhotos(_ call: CAPPluginCall) {
        guard let ids = call.getArray("ids", String.self), !ids.isEmpty else {
            call.reject("ids required")
            return
        }
        PHPhotoLibrary.requestAuthorization(for: .readWrite) { status in
            guard status == .authorized || status == .limited else {
                call.reject("photo library permission denied")
                return
            }
            let assets = PHAsset.fetchAssets(withLocalIdentifiers: ids, options: nil)
            guard assets.count > 0 else {
                call.resolve(["deleted": 0])
                return
            }
            PHPhotoLibrary.shared().performChanges({
                PHAssetChangeRequest.deleteAssets(assets)
            }) { success, error in
                if success {
                    call.resolve(["deleted": assets.count])
                } else if let e = error as NSError?,
                          e.domain == PHPhotosErrorDomain,
                          e.code == PHPhotosError.userCancelled.rawValue {
                    // ユーザーがOSダイアログでキャンセル
                    call.resolve(["deleted": 0, "cancelled": true])
                } else {
                    call.reject(error?.localizedDescription ?? "delete failed")
                }
            }
        }
    }
}
