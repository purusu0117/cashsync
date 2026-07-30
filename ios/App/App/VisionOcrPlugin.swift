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

    // UIImage を長辺 maxDim 以内に縮小（Visionの負荷を下げ、遅延/固まりを防ぐ）。
    private static func downscale(_ image: UIImage, maxDim: CGFloat) -> UIImage {
        let w = image.size.width, h = image.size.height
        let m = max(w, h)
        guard m > maxDim, m > 0 else { return image }
        let scale = maxDim / m
        let newSize = CGSize(width: w * scale, height: h * scale)
        let format = UIGraphicsImageRendererFormat.default()
        format.scale = 1
        return UIGraphicsImageRenderer(size: newSize, format: format).image { _ in
            image.draw(in: CGRect(origin: .zero, size: newSize))
        }
    }

    @objc func recognize(_ call: CAPPluginCall) {
        guard let raw = call.getString("image") else {
            call.reject("image is required"); return
        }
        // dataURL（data:image/png;base64,....）の接頭辞を除去
        let b64 = raw.contains(",") ? String(raw.split(separator: ",", maxSplits: 1).last ?? "") : raw
        guard let data = Data(base64Encoded: b64, options: .ignoreUnknownCharacters),
              let uiImage = UIImage(data: data) else {
            call.reject("invalid image data"); return
        }
        // ネイティブ側でも縮小してから cgImage を作る（大きい画像で .accurate が返らない問題の回避）。
        let resized = VisionOcrPlugin.downscale(uiImage, maxDim: 2500)
        guard let cgImage = resized.cgImage else {
            call.reject("no cgImage"); return
        }

        // resolve/reject は必ずメインスレッドで返す（結果がJSに届かず固まる事故を避ける）。
        let done = { (result: [String: Any]?, err: String?) in
            DispatchQueue.main.async {
                if let err = err { call.reject(err) } else { call.resolve(result ?? [:]) }
            }
        }

        let request = VNRecognizeTextRequest { req, err in
            if let err = err { done(nil, "ocr failed: \(err.localizedDescription)"); return }
            let observations = (req.results as? [VNRecognizedTextObservation]) ?? []
            // 上→下・左→右の読み順に並べて行ごとに結合（parseReceiptText が行単位で解析するため）。
            let sorted = observations.sorted { a, b in
                let dy = b.boundingBox.origin.y - a.boundingBox.origin.y
                if abs(dy) > 0.012 { return a.boundingBox.origin.y > b.boundingBox.origin.y }
                return a.boundingBox.origin.x < b.boundingBox.origin.x
            }
            let lines = sorted.compactMap { $0.topCandidates(1).first?.string }
            done(["text": lines.joined(separator: "\n")], nil)
        }
        // 【重要】日本語(CJK)は .accurate 必須。.fast はラテン系専用で、日本語の文字を
        // ほぼ丸ごと落とす（実機で「食パン/合計/店」等が全部消え数字だけになっていた真因）。
        // 遅延/固まりは createImageBitmap 固まり＋プラグイン未登録が真因で既に解消済みのため、
        // ここは日本語をきちんと読める .accurate に戻す（＋日本語補正ON）。
        request.recognitionLevel = .accurate
        request.usesLanguageCorrection = true
        if #available(iOS 16.0, *) {
            request.revision = VNRecognizeTextRequestRevision3
        }
        request.recognitionLanguages = ["ja-JP", "en-US"]

        let handler = VNImageRequestHandler(cgImage: cgImage, options: [:])
        DispatchQueue.global(qos: .userInitiated).async {
            do {
                try handler.perform([request])
            } catch {
                done(nil, "ocr perform failed: \(error.localizedDescription)")
            }
        }
    }
}
