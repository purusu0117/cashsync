// C4: ホーム画面ウィジェット（今日あと使える額）。
//
// データの流れ:
//   アプリ（WebView）が App Group の UserDefaults に token / baseUrl を保存
//     → ウィジェットがそれを読んで /api/widget を叩く（Bearer認証）
//     → 取得できた値をキャッシュして表示。オフライン時は最後の値＋取得時刻を出す
//
// ウィジェットはアプリ本体とは別プロセスなので、セッションCookieは使えない（=Bearerトークン）。
import SwiftUI
import WidgetKit

private let appGroupId = "group.com.daito.cashsync"
private let defaultBaseUrl = "https://cashsync-eight.vercel.app"

// MARK: - モデル

struct BudgetSnapshot {
    var remainingToday: Int
    var todayBudget: Int
    var spentToday: Int
    var nextPaydayDate: String?
    var nextPaydayAmount: Int
    var updatedAt: Date
    /// 一度も取得できていない（未ログイン or 未設定）
    var isPlaceholder: Bool = false

    static let placeholder = BudgetSnapshot(
        remainingToday: 2500,
        todayBudget: 3500,
        spentToday: 1000,
        nextPaydayDate: nil,
        nextPaydayAmount: 0,
        updatedAt: Date(),
        isPlaceholder: true
    )
}

private struct WidgetResponse: Decodable {
    let remainingToday: Int
    let todayBudget: Int
    let spentToday: Int
    let nextPayday: NextPayday?

    struct NextPayday: Decodable {
        let date: String
        let amount: Int
        let daysUntil: Int
    }
}

// MARK: - 取得＋キャッシュ

enum BudgetStore {
    private static var defaults: UserDefaults? { UserDefaults(suiteName: appGroupId) }

    static func cached() -> BudgetSnapshot? {
        guard let d = defaults, d.object(forKey: "remainingToday") != nil else { return nil }
        return BudgetSnapshot(
            remainingToday: d.integer(forKey: "remainingToday"),
            todayBudget: d.integer(forKey: "todayBudget"),
            spentToday: d.integer(forKey: "spentToday"),
            nextPaydayDate: d.string(forKey: "nextPaydayDate"),
            nextPaydayAmount: d.integer(forKey: "nextPaydayAmount"),
            updatedAt: Date(timeIntervalSince1970: d.double(forKey: "updatedAt"))
        )
    }

    private static func save(_ s: BudgetSnapshot) {
        guard let d = defaults else { return }
        d.set(s.remainingToday, forKey: "remainingToday")
        d.set(s.todayBudget, forKey: "todayBudget")
        d.set(s.spentToday, forKey: "spentToday")
        d.set(s.nextPaydayDate, forKey: "nextPaydayDate")
        d.set(s.nextPaydayAmount, forKey: "nextPaydayAmount")
        d.set(s.updatedAt.timeIntervalSince1970, forKey: "updatedAt")
    }

    /// アプリ側が保存したトークン（未ログインなら nil）
    private static var token: String? {
        guard let t = defaults?.string(forKey: "apiToken"), !t.isEmpty else { return nil }
        return t
    }

    private static var baseUrl: String {
        defaults?.string(forKey: "baseUrl").flatMap { $0.isEmpty ? nil : $0 } ?? defaultBaseUrl
    }

    /// サーバーから最新値を取る。失敗したらキャッシュを返す（無ければ nil）
    static func fetch() async -> BudgetSnapshot? {
        guard let token, let url = URL(string: "\(baseUrl)/api/widget") else { return cached() }
        var req = URLRequest(url: url)
        req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        req.timeoutInterval = 15
        req.cachePolicy = .reloadIgnoringLocalCacheData
        do {
            let (data, response) = try await URLSession.shared.data(for: req)
            guard let http = response as? HTTPURLResponse, http.statusCode == 200 else { return cached() }
            let decoded = try JSONDecoder().decode(WidgetResponse.self, from: data)
            let snapshot = BudgetSnapshot(
                remainingToday: decoded.remainingToday,
                todayBudget: decoded.todayBudget,
                spentToday: decoded.spentToday,
                nextPaydayDate: decoded.nextPayday?.date,
                nextPaydayAmount: decoded.nextPayday?.amount ?? 0,
                updatedAt: Date()
            )
            save(snapshot)
            return snapshot
        } catch {
            return cached() // 圏外・エラー時は前回値を出す（空白にしない）
        }
    }
}

// MARK: - タイムライン

struct BudgetEntry: TimelineEntry {
    let date: Date
    let snapshot: BudgetSnapshot
    /// トークン未設定（アプリでログインしていない）
    let needsSetup: Bool
}

struct BudgetProvider: TimelineProvider {
    func placeholder(in context: Context) -> BudgetEntry {
        BudgetEntry(date: Date(), snapshot: .placeholder, needsSetup: false)
    }

    func getSnapshot(in context: Context, completion: @escaping (BudgetEntry) -> Void) {
        Task {
            let s = await BudgetStore.fetch()
            completion(BudgetEntry(date: Date(), snapshot: s ?? .placeholder, needsSetup: s == nil))
        }
    }

    func getTimeline(in context: Context, completion: @escaping (Timeline<BudgetEntry>) -> Void) {
        Task {
            // アプリが直近（90秒以内）に最新の残額を書き込んでいれば、それを即表示する。
            // 記録直後はアプリが setWidgetBudget→reloadAllTimelines を呼ぶので、ここに入り
            // /api/widget の通信を待たずに新しい数字が出る（体感の遅延をほぼ無くす）。
            if let cached = BudgetStore.cached(),
               Date().timeIntervalSince1970 - cached.updatedAt.timeIntervalSince1970 < 90 {
                let entry = BudgetEntry(date: Date(), snapshot: cached, needsSetup: false)
                let next = Calendar.current.date(byAdding: .minute, value: 15, to: Date()) ?? Date().addingTimeInterval(900)
                completion(Timeline(entries: [entry], policy: .after(next)))
                return
            }
            // アプリを開いていない間の定期更新は、従来どおりウィジェット自身がサーバーから取得する
            let s = await BudgetStore.fetch()
            let entry = BudgetEntry(date: Date(), snapshot: s ?? .placeholder, needsSetup: s == nil)
            let next = Calendar.current.date(byAdding: .minute, value: 30, to: Date()) ?? Date().addingTimeInterval(1800)
            completion(Timeline(entries: [entry], policy: .after(next)))
        }
    }
}

// MARK: - 見た目（レシート紙の世界観に合わせる）

private let paper = Color(red: 0.925, green: 0.906, blue: 0.867) // #ece7dd
private let ink = Color(red: 0.129, green: 0.114, blue: 0.094) // #211d18
private let inkFaint = Color(red: 0.129, green: 0.114, blue: 0.094).opacity(0.55)
private let vermilion = Color(red: 0.910, green: 0.267, blue: 0.180) // #e8442e

private func yen(_ v: Int) -> String {
    let f = NumberFormatter()
    f.numberStyle = .decimal
    let n = f.string(from: NSNumber(value: abs(v))) ?? "\(abs(v))"
    return (v < 0 ? "-¥" : "¥") + n
}

struct CashSyncWidgetEntryView: View {
    @Environment(\.widgetFamily) private var family
    var entry: BudgetEntry

    var body: some View {
        if entry.needsSetup {
            VStack(alignment: .leading, spacing: 4) {
                Text("CashSync").font(.system(size: 12, weight: .bold)).foregroundStyle(inkFaint)
                Text("アプリでログインすると\nここに残額が出ます")
                    .font(.system(size: 12))
                    .foregroundStyle(ink)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
            .containerBackground(paper, for: .widget)
        } else {
            content
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
                .containerBackground(paper, for: .widget)
        }
    }

    private var amountColor: Color { entry.snapshot.remainingToday < 0 ? vermilion : ink }

    @ViewBuilder private var content: some View {
        switch family {
        case .systemMedium:
            VStack(alignment: .leading, spacing: 6) {
                header
                Text(yen(entry.snapshot.remainingToday))
                    .font(.system(size: 40, weight: .heavy, design: .rounded))
                    .foregroundStyle(amountColor)
                    .minimumScaleFactor(0.5)
                    .lineLimit(1)
                HStack(spacing: 12) {
                    label("今日の予算", yen(entry.snapshot.todayBudget))
                    label("使った", yen(entry.snapshot.spentToday))
                    if let d = entry.snapshot.nextPaydayDate {
                        label("次の給料日", shortDate(d))
                    }
                }
                Spacer(minLength: 0)
            }
        default: // .systemSmall とその他
            VStack(alignment: .leading, spacing: 4) {
                header
                Text(yen(entry.snapshot.remainingToday))
                    .font(.system(size: 30, weight: .heavy, design: .rounded))
                    .foregroundStyle(amountColor)
                    .minimumScaleFactor(0.5)
                    .lineLimit(1)
                Spacer(minLength: 0)
                Text("使った \(yen(entry.snapshot.spentToday))")
                    .font(.system(size: 11))
                    .foregroundStyle(inkFaint)
            }
        }
    }

    private var header: some View {
        HStack(spacing: 4) {
            Text(entry.snapshot.remainingToday < 0 ? "今日は超過" : "今日あと")
                .font(.system(size: 12, weight: .bold))
                .foregroundStyle(inkFaint)
            Spacer(minLength: 0)
            Text(timeText)
                .font(.system(size: 10))
                .foregroundStyle(inkFaint)
        }
    }

    private func label(_ title: String, _ value: String) -> some View {
        VStack(alignment: .leading, spacing: 1) {
            Text(title).font(.system(size: 9)).foregroundStyle(inkFaint)
            Text(value).font(.system(size: 13, weight: .semibold)).foregroundStyle(ink)
        }
    }

    private var timeText: String {
        let f = DateFormatter()
        f.dateFormat = "HH:mm"
        f.timeZone = TimeZone(identifier: "Asia/Tokyo")
        return f.string(from: entry.snapshot.updatedAt) + " 時点"
    }

    private func shortDate(_ iso: String) -> String {
        let parts = iso.split(separator: "-")
        guard parts.count == 3 else { return iso }
        return "\(Int(parts[1]) ?? 0)/\(Int(parts[2]) ?? 0)"
    }
}

@main
struct CashSyncWidget: Widget {
    let kind = "CashSyncWidget"

    var body: some WidgetConfiguration {
        StaticConfiguration(kind: kind, provider: BudgetProvider()) { entry in
            CashSyncWidgetEntryView(entry: entry)
        }
        .configurationDisplayName("今日あと使える額")
        .description("CashSyncの「今日あと使えるお金」をホーム画面に表示します。")
        .supportedFamilies([.systemSmall, .systemMedium])
    }
}
