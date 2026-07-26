// 収支・給与・定期計上のドメインロジック（もこもこ家計簿 app.js から移植・一般化）。
// サーバー専用（db を触る）。純粋計算の部分は関数単位でテスト可能に分離。
// 「今日」はJST固定（jst.ts）でサーバーTZ非依存。給与計算・定期計上のロジック自体は不変。
import { isHoliday } from "@holiday-jp/holiday_jp";
import { db, uid } from "./db";
import { jstToday, jstTodayStr } from "./jst";

export function todayStr(): string {
  return jstTodayStr();
}

export function monthOf(date: string): string {
  return date.slice(0, 7);
}

export function currentMonth(): string {
  return todayStr().slice(0, 7);
}

export function daysInMonth(month: string): number {
  const [y, m] = month.split("-").map(Number);
  return new Date(y, m, 0).getDate();
}

/** 今日を含む残り日数（前作 daysRemainingInMonth の移植） */
export function daysRemainingInMonth(): number {
  return daysInMonth(currentMonth()) - jstToday().d + 1;
}

function parseLocalDate(date: string): Date {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(y, m - 1, d);
}

/** 土日 or 日本の祝日か（前作は Google 祝日カレンダー参照、holiday_jp でオフライン化） */
export function isWeekendOrHoliday(date: string): boolean {
  const d = parseLocalDate(date);
  const dow = d.getDay();
  return dow === 0 || dow === 6 || isHoliday(d);
}

export interface ShiftRow {
  id: string;
  job_id: string;
  date: string;
  start_min: number;
  end_min: number;
  break_min: number;
}

export interface JobRow {
  id: string;
  name: string;
  weekday_rate: number;
  weekend_holiday_rate: number;
  transport_per_shift: number;
  closing_day: number; // 締め日（31=末日）
  pay_month_offset: number; // 0=当月払い, 1=翌月払い
  pay_same_day?: number; // 1=当日払い
}

/** 1シフトの給与（平日/土日祝レート × 実働時間 ＋ 交通費） */
export function shiftPay(shift: ShiftRow, job: JobRow): number {
  const hours = Math.max(0, shift.end_min - shift.start_min - shift.break_min) / 60;
  const rate = isWeekendOrHoliday(shift.date) ? job.weekend_holiday_rate : job.weekday_rate;
  return Math.round(hours * rate) + job.transport_per_shift;
}

export interface MonthShiftIncome {
  total: number;
  weekdayHours: number;
  weekendHolidayHours: number;
  shiftCount: number;
}

function shiftMonthBy(month: string, delta: number): string {
  const [y, m] = month.split("-").map(Number);
  const d = new Date(y, m - 1 + delta, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

function dateStr(month: string, day: number): string {
  return `${month}-${String(Math.min(day, daysInMonth(month))).padStart(2, "0")}`;
}

/**
 * その job の「month に支払われる給料」の対象勤務期間を返す。
 * 例）15日締め・翌月払いなら、8月に支払われるのは 6/16〜7/15 の勤務。
 * デフォルト（末日締め・当月払い）は month の 1日〜末日＝従来の挙動。
 */
export function payPeriodFor(job: JobRow, month: string): { start: string; end: string } {
  // 当日払いは「その月に働いた分＝その月の収入」なので当月まるごと
  if (job.pay_same_day) {
    return { start: dateStr(month, 1), end: dateStr(month, 31) };
  }
  const workMonth = shiftMonthBy(month, -(job.pay_month_offset || 0));
  const closing = job.closing_day >= 28 ? 31 : job.closing_day; // 28以上は末日扱い
  if (closing >= 28) {
    return { start: dateStr(workMonth, 1), end: dateStr(workMonth, 31) };
  }
  const prev = shiftMonthBy(workMonth, -1);
  const startDay = Math.min(closing, daysInMonth(prev)) + 1;
  return { start: dateStr(prev, startDay), end: dateStr(workMonth, closing) };
}

/**
 * その月に「支払われる」シフト収入（前作 fetchKimihanIncome の計算部を移植・給料日対応）。
 * 締め日・支払月が未設定のバイト先は従来どおり当月1日〜末日の勤務＝当月収入。
 */
export async function monthShiftIncome(userId: string, month: string): Promise<MonthShiftIncome> {
  const d = await db();
  const jobs = await d.all<JobRow>(
    "SELECT id, name, weekday_rate, weekend_holiday_rate, transport_per_shift, closing_day, pay_month_offset, pay_same_day FROM jobs WHERE user_id = ?",
    userId,
  );
  let total = 0;
  let weekdayHours = 0;
  let weekendHolidayHours = 0;
  let shiftCount = 0;
  for (const job of jobs) {
    const period = payPeriodFor(job, month);
    const shifts = await d.all<ShiftRow>(
      "SELECT id, job_id, date, start_min, end_min, break_min FROM shifts WHERE user_id = ? AND job_id = ? AND date >= ? AND date <= ?",
      userId,
      job.id,
      period.start,
      period.end,
    );
    for (const s of shifts) {
      const hours = Math.max(0, s.end_min - s.start_min - s.break_min) / 60;
      if (isWeekendOrHoliday(s.date)) weekendHolidayHours += hours;
      else weekdayHours += hours;
      total += shiftPay(s, job);
      shiftCount++;
    }
  }
  return { total, weekdayHours, weekendHolidayHours, shiftCount };
}

function nextMonth(month: string): string {
  const [y, m] = month.split("-").map(Number);
  const d = new Date(y, m, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

/** その月に「働いた」シフトの稼ぎ（シフト画面用。支払いは各jobの給料日） */
export async function monthWorkIncome(userId: string, month: string): Promise<MonthShiftIncome> {
  const d = await db();
  const jobs = new Map(
    (
      await d.all<JobRow>(
        "SELECT id, name, weekday_rate, weekend_holiday_rate, transport_per_shift, closing_day, pay_month_offset FROM jobs WHERE user_id = ?",
        userId,
      )
    ).map((j) => [j.id, j]),
  );
  const shifts = await d.all<ShiftRow>(
    "SELECT id, job_id, date, start_min, end_min, break_min FROM shifts WHERE user_id = ? AND date LIKE ?",
    userId,
    `${month}-%`,
  );
  let total = 0;
  let weekdayHours = 0;
  let weekendHolidayHours = 0;
  for (const s of shifts) {
    const job = jobs.get(s.job_id);
    if (!job) continue;
    const hours = Math.max(0, s.end_min - s.start_min - s.break_min) / 60;
    if (isWeekendOrHoliday(s.date)) weekendHolidayHours += hours;
    else weekdayHours += hours;
    total += shiftPay(s, job);
  }
  return { total, weekdayHours, weekendHolidayHours, shiftCount: shifts.length };
}

export interface Payday {
  date: string; // 支払日
  jobId: string;
  jobName: string;
  color: string;
  amount: number; // その日に支払われる給料
  periodStart: string;
  periodEnd: string;
}

/** その月の給料日一覧（カレンダー表示用）。金額はその月に支払われる給料 */
export async function paydays(userId: string, month: string): Promise<Payday[]> {
  const d = await db();
  const jobs = await d.all<JobRow & { pay_day: number; color: string; name: string }>(
    "SELECT id, name, weekday_rate, weekend_holiday_rate, transport_per_shift, closing_day, pay_month_offset, pay_day, pay_same_day, color FROM jobs WHERE user_id = ?",
    userId,
  );
  const out: Payday[] = [];
  for (const job of jobs) {
    const period = payPeriodFor(job, month);
    const shifts = await d.all<ShiftRow>(
      "SELECT id, job_id, date, start_min, end_min, break_min FROM shifts WHERE user_id = ? AND job_id = ? AND date >= ? AND date <= ?",
      userId,
      job.id,
      period.start,
      period.end,
    );
    if (job.pay_same_day) {
      // 当日払い：働いた日ごとにその日の給料を表示
      for (const sh of shifts) {
        const amount = shiftPay(sh, job);
        if (amount <= 0) continue;
        out.push({
          date: sh.date,
          jobId: job.id,
          jobName: job.name,
          color: job.color,
          amount,
          periodStart: sh.date,
          periodEnd: sh.date,
        });
      }
      continue;
    }
    const amount = shifts.reduce((s, sh) => s + shiftPay(sh, job), 0);
    if (amount <= 0) continue;
    out.push({
      date: dateStr(month, Math.min(job.pay_day || 25, daysInMonth(month))),
      jobId: job.id,
      jobName: job.name,
      color: job.color,
      amount,
      periodStart: period.start,
      periodEnd: period.end,
    });
  }
  return out;
}

/**
 * 定期支出/収入を upToMonth までレコード実体化する（冪等）。
 * 開始月〜upToMonth の未計上月を全てバックフィルするので、
 * ある月にアプリを一度も開かなくても後から欠落しない。
 * 二重計上対策として recurring_posts への mark を先に行い（PK制約で弾く）、成功時のみ本体を挿入する。
 * （sqlite/postgres共通化のため、PK違反のcatchではなく ON CONFLICT DO NOTHING ＋件数判定。挙動は同一）
 */
export async function postRecurringForMonth(userId: string, upToMonth: string) {
  const d = await db();
  const items = await d.all<{
    id: string;
    kind: string;
    name: string;
    amount: number;
    category_id: string | null;
    start_month: string;
    end_month: string | null;
    post_day: number;
    interval: string; // 'monthly' | 'yearly'
  }>(
    `SELECT r.id, r.kind, r.name, r.amount, r.category_id, r.start_month, r.end_month, r.post_day, r.interval
     FROM recurring_items r WHERE r.user_id = ? AND r.start_month <= ?`,
    userId,
    upToMonth,
  );
  if (items.length === 0) return;
  for (const it of items) {
    let month = it.start_month;
    let guard = 0;
    while (month <= upToMonth && (!it.end_month || month <= it.end_month) && guard++ < 120) {
      // 年払いは「毎年、開始月と同じ月」だけ計上（例：2026-07開始なら毎年7月）
      if (it.interval === "yearly" && month.slice(5) !== it.start_month.slice(5)) {
        month = nextMonth(month);
        continue;
      }
      const mark = await d.run(
        "INSERT INTO recurring_posts (recurring_id, month) VALUES (?, ?) ON CONFLICT (recurring_id, month) DO NOTHING",
        it.id,
        month,
      );
      if (mark.changes > 0) {
        // 未計上月のみ本体を挿入（計上済みなら changes=0 → skip）
        const day = String(Math.min(Math.max(1, it.post_day), daysInMonth(month))).padStart(2, "0");
        const date = `${month}-${day}`;
        if (it.kind === "expense") {
          await d.run(
            "INSERT INTO expenses (id, user_id, date, amount, category_id, memo, source, created_at) VALUES (?, ?, ?, ?, ?, ?, 'recurring', ?)",
            uid(),
            userId,
            date,
            it.amount,
            it.category_id,
            it.name,
            Date.now(),
          );
        } else {
          await d.run(
            "INSERT INTO incomes (id, user_id, date, amount, type, memo, created_at) VALUES (?, ?, ?, ?, 'recurring', ?, ?)",
            uid(),
            userId,
            date,
            it.amount,
            it.name,
            Date.now(),
          );
        }
      }
      month = nextMonth(month);
    }
  }
}

export interface MonthSummary {
  month: string;
  incomeTotal: number; // シフト見込み ＋ 収入レコード
  expenseTotal: number; // 支出レコード（定期計上ぶん含む）
  shift: MonthShiftIncome;
}

export async function monthSummary(userId: string, month: string): Promise<MonthSummary> {
  const d = await db();
  const exp = (await d.get<{ s: number }>(
    "SELECT COALESCE(SUM(amount), 0) AS s FROM expenses WHERE user_id = ? AND date LIKE ?",
    userId,
    `${month}-%`,
  )) as { s: number };
  const inc = (await d.get<{ s: number }>(
    "SELECT COALESCE(SUM(amount), 0) AS s FROM incomes WHERE user_id = ? AND date LIKE ?",
    userId,
    `${month}-%`,
  )) as { s: number };
  const shift = await monthShiftIncome(userId, month);
  return {
    month,
    incomeTotal: inc.s + shift.total,
    expenseTotal: exp.s,
    shift,
  };
}

/**
 * 今日使えるお金 =（今月収入 − 貯金目標 − 今月支出）÷ 残り日数。
 * 貯金目標を先に差し引く「先取り貯金」方式：残った分だけ使えば目標が必ず貯まる。
 */
export function dailyAllowance(summary: MonthSummary, savingsGoal = 0): number {
  const remain = summary.incomeTotal - savingsGoal - summary.expenseTotal;
  return Math.floor(remain / daysRemainingInMonth());
}

export interface MonthForecast {
  forecast: number; // このペースだと月末いくら残るか（貯金見込み）
  avgDaily: number; // 変動支出の1日平均
}

/**
 * 月末残高予測（Zaim黒字チェッカー方式の簡易版）：
 * 変動支出（定期計上を除く）の1日平均 × 残り日数を、現在の残額からさらに引く。
 */
export async function monthForecast(userId: string, summary: MonthSummary): Promise<MonthForecast> {
  const d = await db();
  const row = (await d.get<{ s: number }>(
    "SELECT COALESCE(SUM(amount), 0) AS s FROM expenses WHERE user_id = ? AND date LIKE ? AND source != 'recurring'",
    userId,
    `${summary.month}-%`,
  )) as { s: number };
  const daysPassed = jstToday().d;
  const avgDaily = row.s / Math.max(1, daysPassed);
  const futureSpend = avgDaily * (daysInMonth(summary.month) - daysPassed);
  return {
    forecast: Math.round(summary.incomeTotal - summary.expenseTotal - futureSpend),
    avgDaily: Math.round(avgDaily),
  };
}

export interface NoMoneyDays {
  count: number; // 今月ここまでのノーマネーデー数
  streak: number; // 今日までの連続日数（今日未消費なら今日も含む）
}

/** ノーマネーデー：変動支出（定期計上を除く）が1件も無かった日。過去月は月全体、当月は今日まで */
export async function noMoneyDays(userId: string, month: string): Promise<NoMoneyDays> {
  const d = await db();
  const rows = await d.all<{ date: string }>(
    "SELECT DISTINCT date FROM expenses WHERE user_id = ? AND date LIKE ? AND source != 'recurring'",
    userId,
    `${month}-%`,
  );
  const spent = new Set(rows.map((r) => r.date));
  const lastDay = month < currentMonth() ? daysInMonth(month) : Number(todayStr().slice(8));
  let count = 0;
  for (let day = 1; day <= lastDay; day++) {
    if (!spent.has(`${month}-${String(day).padStart(2, "0")}`)) count++;
  }
  let streak = 0;
  for (let day = lastDay; day >= 1; day--) {
    if (spent.has(`${month}-${String(day).padStart(2, "0")}`)) break;
    streak++;
  }
  return { count, streak };
}

export interface CategorySpend {
  category: string;
  amount: number;
  count: number;
}

/** 月のカテゴリ別支出（レビュー用） */
export async function categoryBreakdown(userId: string, month: string): Promise<CategorySpend[]> {
  const d = await db();
  // GROUP BY に c.name を含める（Postgres の集約規則対応。category_id ごとに c.name は一意なので結果は不変）
  return d.all<CategorySpend>(
    `SELECT COALESCE(c.name, '未分類') AS category, SUM(e.amount) AS amount, COUNT(*) AS count
     FROM expenses e LEFT JOIN categories c ON c.id = e.category_id AND c.user_id = e.user_id
     WHERE e.user_id = ? AND e.date LIKE ?
     GROUP BY e.category_id, c.name ORDER BY amount DESC`,
    userId,
    `${month}-%`,
  );
}
