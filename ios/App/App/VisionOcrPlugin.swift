import Foundation
import Capacitor
import Vision
import UIKit

/// 端末内蔵の Apple Vision で画像から日本語テキストを抽出する Capacitor プラグイン。
/// AI API を使わず、画像も端末外に出さずに OCR する（CashSync の自前OCR用）。
/// JS 側からは `VisionOcr.recognize({ image })` で呼ぶ。image は dataURL か base64 文字列。
@objc(VisionOcrPlugin)
public class VisionOcrPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "VisionOcrPlugin"
    public let jsName = "VisionOcr"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "recognize", returnType: CAPPluginReturnPromise)
    ]

    @objc func recognize(_ call: CAPPluginCall) {
        guard let raw = call.getString("image") else {
            call.reject("image is required"); return
        }
        // dataURL（data:image/png;base64,....）の接頭辞を除去
        let b64 = raw.contains(",") ? String(raw.split(separator: ",", maxSplits: 1).last ?? "") : raw
        guard let data = Data(base64Encoded: b64, options: .ignoreUnknownCharacters),
              let uiImage = UIImage(data: data),
              let cgImage = uiImage.cgImage else {
            call.reject("invalid image data"); return
        }

        let request = VNRecognizeTextRequest { req, err in
            if let err = err {
                call.reject("ocr failed: \(err.localizedDescription)"); return
            }
            let observations = (req.results as? [VNRecognizedTextObservation]) ?? []
            // 上→下・左→右の読み順に並べて行ごとに結合（parseReceiptText が行単位で解析するため）。
            // boundingBox は原点が左下・正規化座標なので y は大きいほど上。
            let sorted = observations.sorted { a, b in
                let dy = b.boundingBox.origin.y - a.boundingBox.origin.y
                if abs(dy) > 0.012 { return a.boundingBox.origin.y > b.boundingBox.origin.y }
                return a.boundingBox.origin.x < b.boundingBox.origin.x
            }
            let lines = sorted.compactMap { $0.topCandidates(1).first?.string }
            call.resolve(["text": lines.joined(separator: "\n")])
        }
        request.recognitionLevel = .accurate
        request.usesLanguageCorrection = false // 金額・店名の勝手な補正を避ける
        if #available(iOS 16.0, *) {
            request.revision = VNRecognizeTextRequestRevision3
        }
        request.recognitionLanguages = ["ja-JP", "en-US"]

        let handler = VNImageRequestHandler(cgImage: cgImage, options: [:])
        DispatchQueue.global(qos: .userInitiated).async {
            do {
                try handler.perform([request])
            } catch {
                call.reject("ocr perform failed: \(error.localizedDescription)")
            }
        }
    }
}
