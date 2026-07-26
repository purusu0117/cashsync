import Foundation
import Capacitor
import Photos

/// CashSync カスタムプラグイン：端末のスクリーンショット一覧取得と削除。
/// 削除は PHPhotoLibrary.performChanges → OS標準の確認ダイアログが出る。
@objc(PhotoCleanerPlugin)
public class PhotoCleanerPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "PhotoCleanerPlugin"
    public let jsName = "PhotoCleaner"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "listRecentScreenshots", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "deletePhotos", returnType: CAPPluginReturnPromise)
    ]

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
