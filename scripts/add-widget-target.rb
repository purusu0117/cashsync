# C4: WidgetKit拡張ターゲットを Xcode プロジェクトへ追加する（CIのビルド前に実行・冪等）。
#
# なぜスクリプトなのか:
#   Capacitor が生成する App.xcodeproj を手で編集すると `cap sync` で壊れたり差分が巨大になる。
#   ターゲット追加はビルド時に毎回作り直す方が安全で、pbxproj の巨大diffもコミットせずに済む。
#
# 実行: bundle exec ruby scripts/add-widget-target.rb
require "xcodeproj"

PROJECT_PATH = "ios/App/App.xcodeproj"
APP_TARGET = "App"
WIDGET_TARGET = "CashSyncWidgetExtension"
WIDGET_DIR = "CashSyncWidget" # ios/App/CashSyncWidget
APP_BUNDLE_ID = "com.daito.cashsync"
WIDGET_BUNDLE_ID = "com.daito.cashsync.widget"
DEPLOYMENT_TARGET = "17.0" # containerBackground が iOS17専用のため。アプリ本体の対応OSは変えない

project = Xcodeproj::Project.open(PROJECT_PATH)
app_target = project.targets.find { |t| t.name == APP_TARGET }
raise "App ターゲットが見つかりません" unless app_target

# --- 端末内OCR: App直下の追加Swiftを App ターゲットのコンパイル対象へ（冪等・ウィジェット処理より前に必ず実行） ---
# これらは ios/App/App/ にあるが project.pbxproj に未登録だと一切コンパイルされない。
# VisionOcrPlugin.swift = 端末内OCR本体。MainViewController.swift = capacitorDidLoad()で
# VisionOcrを明示登録するブリッジVC（Capacitor 8は自動登録が無いためこれが無いと
# JS側で「not implemented on ios」になる）。
APP_SWIFT_FILES = ["VisionOcrPlugin.swift", "MainViewController.swift"]
app_group = project.main_group.find_subpath("App", true)
APP_SWIFT_FILES.each do |fname|
  in_sources = app_target.source_build_phase.files.any? do |bf|
    bf.file_ref && bf.file_ref.display_name.to_s == fname
  end
  if in_sources
    puts "#{fname} は既に App ターゲットに含まれています"
  else
    ref = app_group.files.find { |f| f.display_name.to_s == fname } || app_group.new_reference(fname)
    app_target.add_file_references([ref])
    puts "#{fname} を App ターゲットのソースに追加しました"
  end
end
project.save

if project.targets.any? { |t| t.name == WIDGET_TARGET }
  puts "既に #{WIDGET_TARGET} があります（何もしません）"
  exit 0
end

# --- ターゲット作成 -----------------------------------------------------------
widget = project.new_target(:app_extension, WIDGET_TARGET, :ios, DEPLOYMENT_TARGET)

group = project.main_group.find_subpath(WIDGET_DIR, true)
group.set_source_tree("SOURCE_ROOT")
group.set_path(WIDGET_DIR)

swift = group.new_reference("CashSyncWidget.swift")
widget.add_file_references([swift])

# バージョンはアプリ本体の実値をコピーする（$(...)の自己参照だと解決できないため）。
# このスクリプトは increment_build_number の後に実行すること。
app_settings = app_target.build_configurations.first.build_settings
marketing = app_settings["MARKETING_VERSION"] || "1.0"
build_no = app_settings["CURRENT_PROJECT_VERSION"] || "1"

widget.build_configurations.each do |config|
  s = config.build_settings
  s["PRODUCT_BUNDLE_IDENTIFIER"] = WIDGET_BUNDLE_ID
  s["PRODUCT_NAME"] = "$(TARGET_NAME)"
  s["INFOPLIST_FILE"] = "#{WIDGET_DIR}/Info.plist"
  s["CODE_SIGN_ENTITLEMENTS"] = "#{WIDGET_DIR}/CashSyncWidget.entitlements"
  s["SWIFT_VERSION"] = "5.0"
  s["IPHONEOS_DEPLOYMENT_TARGET"] = DEPLOYMENT_TARGET
  s["TARGETED_DEVICE_FAMILY"] = "1,2"
  s["SKIP_INSTALL"] = "YES"
  s["MARKETING_VERSION"] = marketing
  s["CURRENT_PROJECT_VERSION"] = build_no
  s["GENERATE_INFOPLIST_FILE"] = "NO"
  s["LD_RUNPATH_SEARCH_PATHS"] = ["$(inherited)", "@executable_path/Frameworks", "@executable_path/../../Frameworks"]
end

# --- アプリ本体に組み込む（Embed App Extensions） -----------------------------
embed = app_target.build_phases.find do |p|
  p.is_a?(Xcodeproj::Project::Object::PBXCopyFilesBuildPhase) && p.name == "Embed App Extensions"
end
unless embed
  embed = app_target.new_copy_files_build_phase("Embed App Extensions")
  embed.symbol_dst_subfolder_spec = :plug_ins
end
embed.add_file_reference(widget.product_reference, true)
app_target.add_dependency(widget)

# --- アプリ本体にも App Group の entitlements を付ける -------------------------
app_target.build_configurations.each do |config|
  config.build_settings["CODE_SIGN_ENTITLEMENTS"] = "App/App.entitlements"
end

project.save
puts "#{WIDGET_TARGET} を追加しました（bundle id: #{WIDGET_BUNDLE_ID}）"
