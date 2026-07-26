// 参照実装：通常の Capacitor プラグインとして import する場合のエントリ。
// CashSync 本体は remote URL 方式（WebView にネイティブブリッジが注入される）のため、
// src/lib/native.ts から window.Capacitor.registerPlugin("PhotoCleaner") で呼び出す。
const { registerPlugin } = require("@capacitor/core");

const PhotoCleaner = registerPlugin("PhotoCleaner");

module.exports = { PhotoCleaner };
