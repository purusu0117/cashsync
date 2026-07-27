// verify-daily-budget.mjs 用のシム。
// @holiday-jp/holiday_jp は CJS で、素の Node ESM だと named export（isHoliday）の検出に失敗するため、
// createRequire 経由で読み込んで re-export する（Next.js 本体はバンドラの interop で問題なし）。
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const pkg = require("@holiday-jp/holiday_jp");

export const isHoliday = pkg.isHoliday;
export const between = pkg.between;
export const holidays = pkg.holidays;
export default pkg;
