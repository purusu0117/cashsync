import Foundation
import Capacitor
import Vision
import UIKit
#if canImport(FoundationModels)
import FoundationModels
#endif

// 端末内AI（Apple Intelligence / Foundation Models, iOS26+）でOCRテキストを家計簿1件に構造化する。
// サーバー/APIは一切使わない・画像やテキストも端末外に出さない。guided generation で型に流し込む。
#if canImport(FoundationModels)
@available(iOS 26.0, *)
@Generable
enum AIKind { case expense; case income }

@available(iOS 26.0, *)
@Generable
struct AIItem {
    @Guide(description: "品目名") var name: String
    @Guide(description: "金額（円・整数）") var price: Int
}

@available(iOS 26.0, *)
@Generable
struct AIReceipt {
    @Guide(description: "支払い/レシート/注文なら expense、受け取り/入金/売上/送金された なら income")
    var kind: AIKind
    @Guide(description: "店名・支払い先。住所/電話/『見本』等の透かしは店名にしない。読めなければ空文字")
    var store: String
    @Guide(description: "日付 YYYY-MM-DD。和暦や崩れた表記も西暦に直す。読めなければ空文字")
    var date: String
    @Guide(description: "実際に支払った合計金額。円・整数。印字された『合計』があればその値。小計+税を自分で足さない")
    var total: Int
    @Guide(description: "最も合うカテゴリ名を渡した候補から1つだけ。該当が無ければ空文字")
    var category: String
    @Guide(description: "主な品目（最大20件）。小計/合計/値引/商品代金/お預り/お釣り/ポイント/部門コードは含めない")
    var items: [AIItem]
}
#endif

/// 端末内蔵の Apple Vision で画像から日本語テキストを抽出する Capacitor プラグイン。
/// AI API を使わず、画像も端末外に出さずに OCR する（CashSync の自前OCR用）。
/// JS 側からは `VisionOcr.recognize({ image })` で呼ぶ。image は dataURL か base64 文字列。
@objc(VisionOcrPlugin)
public class VisionOcrPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "VisionOcrPlugin"
    public let jsName = "VisionOcr"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "recognize", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "aiAvailable", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "parseReceipt", returnType: CAPPluginReturnPromise)
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

    // 端末内AIが使えるか（対応端末＋Apple Intelligence ON＋モデル準備済み）を返す。
    @objc func aiAvailable(_ call: CAPPluginCall) {
        #if canImport(FoundationModels)
        if #available(iOS 26.0, *) {
            let (ok, reason) = VisionOcrPlugin.aiStatus()
            call.resolve(["available": ok, "reason": reason])
            return
        }
        #endif
        call.resolve(["available": false, "reason": "os"]) // iOS26未満/フレームワーク無し
    }

    #if canImport(FoundationModels)
    @available(iOS 26.0, *)
    private static func aiStatus() -> (Bool, String) {
        switch SystemLanguageModel.default.availability {
        case .available:
            return (true, "ok")
        case .unavailable(let reason):
            switch reason {
            case .deviceNotEligible: return (false, "deviceNotEligible")
            case .appleIntelligenceNotEnabled: return (false, "notEnabled")
            case .modelNotReady: return (false, "modelNotReady")
            @unknown default: return (false, "unknown")
            }
        }
    }
    #endif

    // OCRテキスト → 家計簿1件（kind/store/date/total/category/items）を端末内AIで構造化。
    // 使えない端末では available:false を返し、JS側はルール解析にフォールバックする。
    @objc func parseReceipt(_ call: CAPPluginCall) {
        let text = call.getString("text") ?? ""
        let cats = (call.getArray("categories") ?? []).compactMap { $0 as? String }
        if text.isEmpty {
            call.resolve(["available": false, "reason": "empty"]); return
        }
        #if canImport(FoundationModels)
        if #available(iOS 26.0, *) {
            let (ok, reason) = VisionOcrPlugin.aiStatus()
            if !ok {
                call.resolve(["available": false, "reason": reason]); return
            }
            let resolveMain = { (obj: [String: Any]) in DispatchQueue.main.async { call.resolve(obj) } }
            Task {
                do {
                    let instr = """
                    あなたはレシートやQR決済画面のOCRテキストから、家計簿1件分の情報を抽出するアシスタントです。
                    テキストに実際に書かれている事実だけを使い、値を創作しないこと。
                    - store: 店名・支払い先。住所/電話番号/『見本』等の透かし文字は店名にしない。
                    - date: 支払い日を YYYY-MM-DD。和暦や崩れた表記も西暦へ。読めなければ空。
                    - total: 実際に支払った合計（割引後・税込）。レシートに『合計』が印字されていればその値を使い、
                      小計＋税を自分で足し直さない。QR決済は画面に大きく出ている金額。円の整数。
                    - category: 次の候補から最も合うものを1つだけ。該当が無ければ空。候補: \(cats.joined(separator: " / "))
                      フードデリバリー(ロケットナウ/UberEats/出前館/セブンナウ等)は食費。
                    - items: 主な品目のみ。小計/合計/値引/商品代金/お預り/お釣り/ポイント/部門コードは品目に入れない。
                    """
                    let session = LanguageModelSession { instr }
                    let out = try await session.respond(to: text, generating: AIReceipt.self).content
                    resolveMain([
                        "available": true,
                        "kind": out.kind == .income ? "income" : "expense",
                        "store": out.store,
                        "date": out.date,
                        "total": out.total,
                        "category": out.category,
                        "items": out.items.map { ["name": $0.name, "price": $0.price] },
                    ])
                } catch {
                    resolveMain(["available": false, "reason": "error", "message": String(describing: error)])
                }
            }
            return
        }
        #endif
        call.resolve(["available": false, "reason": "os"])
    }
}
