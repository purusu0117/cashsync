// 収支・給与・定期計上のドメインロジック（もこもこ家計簿 app.js から移植・一般化）。
// サーバー専用（db を触る）。純粋計算の部分は関数単位でテスト可能に分離。
// 「今日」はJST固定（jst.ts）でサーバーTZ非依存。給与計算・定期計上のロジック自体は不変。
import { isHoliday } from "@holiday-jp/holiday_jp";
import { db, uid } from "./db";
import { jstTodayStr } from "./jst";

// 金額の上限（円）。Postgres の amount は int4（最大約21.4億）なので、それ未満かつ
// 個人家計として非現実的でない上限を設ける。超過は各APIが400で丁寧に返す（sqlite/pg差の解消も兼ねる）。
export const MAX_AMOUNT = 1_000_000_000; // 10億円

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

function parseLocalDate(date: string): Date {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(y, m - 1, d);
}

/** 'YYYY-MM-DD' 同士の日数差（b - a）。同日=0 */
function daysBetween(a: string, b: string): number {
  return Math.round((parseLocalDate(b).getTime() - parseLocalDate(a).getTime()) / 86_400_000);
}

function addDays(date: string, delta: number): string {
  const d = parseLocalDate(date);
  d.setDate(d.getDate() + delta);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

// ---------------------------------------------------------------------------
// B9: 「月」の定義の一元化（締め日＝月の開始日）。
// users.month_start_day（1〜28、デフォルト1）を基準に、集計上の「◯月」を
// 「開始日〜翌月の開始日前日」で解決する。例：25日開始なら 7/25〜8/24 が「8月」。
// 開始日1（デフォルト）は従来のカレンダー月と完全に同一挙動になる。
// 日次予算・月次サマリー・カレンダー・グラフ・履歴・定期先取り・給料日・NMD は
// すべて monthRange / accountingMonth 経由で期間を解決する。
// ---------------------------------------------------------------------------

/** ユーザー設定の月開始日（1〜28。範囲外・未設定は1） */
export async function getMonthStartDay(userId: string): Promise<number> {
  const d = await db();
  const row = await d.get<{ month_start_day?: number }>(
    "SELECT month_start_day FROM users WHERE id = ?",
    userId,
  );
  const v = Math.floor(Number(row?.month_start_day ?? 1));
  return v >= 2 && v <= 28 ? v : 1;
}

export interface MonthRange {
  start: string; // 期間初日（含む）
  end: string; // 期間末日（含む）
}

/** 純粋関数版：month（'YYYY-MM'）の集計期間。startDay=1 はカレンダー月そのまま */
export function monthRangeFor(month: string, startDay: number): MonthRange {
  if (startDay <= 1) {
    return { start: `${month}-01`, end: dateStr(month, 31) };
  }
  const prev = shiftMonthBy(month, -1);
  return { start: dateStr(prev, startDay), end: dateStr(month, startDay - 1) };
}

/** 期間解決ヘルパー（DB版）：集計はすべてこれを経由する */
export async function monthRange(userId: string, month: string): Promise<MonthRange> {
  return monthRangeFor(month, await getMonthStartDay(userId));
}

/** 純粋関数版：date が属する集計上の「月」。25日開始なら 7/25→'…-08' */
export function accountingMonthFor(date: string, startDay: number): string {
  if (startDay <= 1) return date.slice(0, 7);
  return Number(date.slice(8, 10)) >= startDay ? nextMonth(date.slice(0, 7)) : date.slice(0, 7);
}

/** 今日（または指定日）が属する集計上の「今月」（DB版） */
export async function accountingMonth(userId: string, date = todayStr()): Promise<string> {
  return accountingMonthFor(date, await getMonthStartDay(userId));
}

/** 今日を含む集計月の残り日数。startDay=1 は従来のカレンダー月と同値 */
export function daysRemainingInMonth(today = todayStr(), startDay = 1): number {
  const range = monthRangeFor(accountingMonthFor(today, startDay), startDay);
  return daysBetween(today, range.end) + 1;
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
 * その job の給料が「集計月 month（期間 range）」に入るカレンダー月の候補を返す。
 * 給料日（pay_day）が range 内に落ちるカレンダー月だけが対象。
 * 開始日1（デフォルト）は候補が month のみ＝給料日は必ず月内なので従来と完全に同じ。
 */
function payMonthsInRange(job: { pay_day?: number }, month: string, range: MonthRange): string[] {
  const candidates = range.start.slice(0, 7) === month ? [month] : [shiftMonthBy(month, -1), month];
  return candidates.filter((cm) => {
    const payDate = dateStr(cm, Math.min(job.pay_day || 25, daysInMonth(cm)));
    return payDate >= range.start && payDate <= range.end;
  });
}

/**
 * その月に「支払われる」シフト収入（前作 fetchKimihanIncome の計算部を移植・給料日対応）。
 * 締め日・支払月が未設定のバイト先は従来どおり当月1日〜末日の勤務＝当月収入。
 * B9: month は集計月。締め日変更時は「給料日が期間内に落ちる支払い」を今月の収入として数える。
 */
export async function monthShiftIncome(userId: string, month: string): Promise<MonthShiftIncome> {
  const d = await db();
  const range = await monthRange(userId, month);
  const jobs = await d.all<JobRow & { pay_day: number }>(
    "SELECT id, name, weekday_rate, weekend_holiday_rate, transport_per_shift, closing_day, pay_month_offset, pay_day, pay_same_day FROM jobs WHERE user_id = ?",
    userId,
  );
  let total = 0;
  let weekdayHours = 0;
  let weekendHolidayHours = 0;
  let shiftCount = 0;
  const add = (shifts: ShiftRow[], job: JobRow) => {
    for (const s of shifts) {
      const hours = Math.max(0, s.end_min - s.start_min - s.break_min) / 60;
      if (isWeekendOrHoliday(s.date)) weekendHolidayHours += hours;
      else weekdayHours += hours;
      total += shiftPay(s, job);
      shiftCount++;
    }
  };
  const shiftsIn = (jobId: string, start: string, end: string) =>
    d.all<ShiftRow>(
      "SELECT id, job_id, date, start_min, end_min, break_min FROM shifts WHERE user_id = ? AND job_id = ? AND date >= ? AND date <= ?",
      userId,
      jobId,
      start,
      end,
    );
  for (const job of jobs) {
    if (job.pay_same_day) {
      // 当日払い：期間内に働いた分＝この月の収入
      add(await shiftsIn(job.id, range.start, range.end), job);
      continue;
    }
    for (const cm of payMonthsInRange(job, month, range)) {
      const period = payPeriodFor(job, cm);
      add(await shiftsIn(job.id, period.start, period.end), job);
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

/**
 * カレンダー月 calMonth に給料日が来る支払い一覧（カレンダーグリッド表示用・従来挙動）。
 * 当日払いは働いた日ごと。
 */
export async function calendarPaydays(userId: string, month: string): Promise<Payday[]> {
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
 * 集計月 month（B9: 締め日基準の期間）に支払われる給料日一覧。
 * 開始日1（デフォルト）はカレンダー月と期間が一致し、従来と完全に同じ結果。
 */
export async function paydays(userId: string, month: string): Promise<Payday[]> {
  const startDay = await getMonthStartDay(userId);
  if (startDay <= 1) return calendarPaydays(userId, month);
  const range = monthRangeFor(month, startDay);
  // 期間はカレンダー月2つ（前月・当月）にまたがる。両月の給料日から期間内のものだけ拾う。
  const out: Payday[] = [];
  const seen = new Set<string>();
  for (const cm of [shiftMonthBy(month, -1), month]) {
    for (const p of await calendarPaydays(userId, cm)) {
      const key = `${p.jobId}:${p.date}`;
      if (p.date < range.start || p.date > range.end || seen.has(key)) continue;
      seen.add(key);
      out.push(p);
    }
  }
  return out.sort((a, b) => a.date.localeCompare(b.date));
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
          // C12: recurring_id で元の定期にリンクする（固定費/変動費の判定に使う）
          await d.run(
            "INSERT INTO expenses (id, user_id, date, amount, category_id, memo, source, recurring_id, created_at) VALUES (?, ?, ?, ?, ?, ?, 'recurring', ?, ?)",
            uid(),
            userId,
            date,
            it.amount,
            it.category_id,
            it.name,
            it.id,
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

export interface PlannedRecurring {
  recurringId: string;
  kind: "expense" | "income";
  date: string;
  name: string;
  amount: number;
  category: string | null;
  icon: string | null;
}

export interface PlannedPayday {
  date: string;
  jobId: string;
  jobName: string;
  color: string;
  amount: number; // 0 = シフト未入力で金額未定（給料日マーカーのみ）
  periodStart: string;
  periodEnd: string;
  confirmed: boolean; // true = 入力済みシフトから計算した金額
}

export interface MonthPlan {
  expenses: PlannedRecurring[];
  incomes: PlannedRecurring[];
  paydays: PlannedPayday[];
  expenseTotal: number;
  incomeTotal: number; // 定期収入 ＋ 金額確定の給料日
}

/**
 * 未来月の「予定」：定期支出・収入（分割払い含む）と給料日を、実体化せずに計算する（読み取り専用・冪等）。
 * 当月は postRecurringForMonth が月初に一括計上済み（＝実記録側に出る）ので、
 * 二重表示を避けるため当月・過去月は常に空を返す。
 */
export async function monthPlan(userId: string, month: string): Promise<MonthPlan> {
  const plan: MonthPlan = { expenses: [], incomes: [], paydays: [], expenseTotal: 0, incomeTotal: 0 };
  if (month <= currentMonth()) return plan;
  const d = await db();

  // 定期支出・収入（分割払いは end_month 付きの定期支出として登録されている）
  const items = await d.all<{
    id: string;
    kind: string;
    name: string;
    amount: number;
    start_month: string;
    end_month: string | null;
    post_day: number;
    interval: string;
    category: string | null;
    icon: string | null;
  }>(
    `SELECT r.id, r.kind, r.name, r.amount, r.start_month, r.end_month, r.post_day, r.interval,
            c.name AS category, c.icon
     FROM recurring_items r
     LEFT JOIN categories c ON c.id = r.category_id AND c.user_id = r.user_id
     WHERE r.user_id = ? AND r.start_month <= ? AND (r.end_month IS NULL OR r.end_month >= ?)`,
    userId,
    month,
    month,
  );
  for (const it of items) {
    // 年払いは「毎年、開始月と同じ月」だけ（postRecurringForMonth と同じ判定）
    if (it.interval === "yearly" && month.slice(5) !== it.start_month.slice(5)) continue;
    const entry: PlannedRecurring = {
      recurringId: it.id,
      kind: it.kind === "income" ? "income" : "expense",
      date: dateStr(month, Math.max(1, it.post_day)),
      name: it.name,
      amount: it.amount,
      category: it.category,
      icon: it.icon,
    };
    if (entry.kind === "income") {
      plan.incomes.push(entry);
      plan.incomeTotal += it.amount;
    } else {
      plan.expenses.push(entry);
      plan.expenseTotal += it.amount;
    }
  }
  plan.expenses.sort((a, b) => a.date.localeCompare(b.date));
  plan.incomes.sort((a, b) => a.date.localeCompare(b.date));

  // 給料日：入力済みシフトがあれば金額つき、無ければ「給料日」マーカーのみ（当日払いは日が読めないので出さない）
  const confirmed = await paydays(userId, month);
  const covered = new Set(confirmed.map((p) => p.jobId));
  for (const p of confirmed) {
    plan.paydays.push({ ...p, confirmed: true });
    plan.incomeTotal += p.amount;
  }
  const jobs = await d.all<JobRow & { pay_day: number; color: string }>(
    "SELECT id, name, color, closing_day, pay_month_offset, pay_day, pay_same_day FROM jobs WHERE user_id = ?",
    userId,
  );
  for (const job of jobs) {
    if (job.pay_same_day || covered.has(job.id)) continue;
    const period = payPeriodFor(job, month);
    plan.paydays.push({
      date: dateStr(month, Math.min(job.pay_day || 25, daysInMonth(month))),
      jobId: job.id,
      jobName: job.name,
      color: job.color,
      amount: 0,
      periodStart: period.start,
      periodEnd: period.end,
      confirmed: false,
    });
  }
  plan.paydays.sort((a, b) => a.date.localeCompare(b.date));
  return plan;
}

export interface MonthSummary {
  month: string;
  incomeTotal: number; // シフト見込み ＋ 収入レコード
  expenseTotal: number; // 支出レコード（定期計上ぶん含む）
  shift: MonthShiftIncome;
}

export async function monthSummary(userId: string, month: string): Promise<MonthSummary> {
  const d = await db();
  const range = await monthRange(userId, month); // B9: 期間は締め日基準で一元解決
  const exp = (await d.get<{ s: number }>(
    "SELECT COALESCE(SUM(amount), 0) AS s FROM expenses WHERE user_id = ? AND date >= ? AND date <= ?",
    userId,
    range.start,
    range.end,
  )) as { s: number };
  const inc = (await d.get<{ s: number }>(
    "SELECT COALESCE(SUM(amount), 0) AS s FROM incomes WHERE user_id = ? AND date >= ? AND date <= ?",
    userId,
    range.start,
    range.end,
  )) as { s: number };
  const shift = await monthShiftIncome(userId, month);
  return {
    month,
    incomeTotal: inc.s + shift.total,
    expenseTotal: exp.s,
    shift,
  };
}

export interface DailyBudget {
  todayBudget: number; // 今日の予算 =（今月収入 − 貯金目標 − 今月の固定費 − 昨日までの変動支出）÷ 残り日数（今日を含む）
  spentToday: number; // 今日の変動支出合計（定期計上を除く）
  remainingToday: number; // 今日あと使える額 = 今日の予算 − 今日の変動支出（マイナス＝超過）
  spentBeforeToday: number; // 昨日までの変動支出合計（定期計上を除く）
  daysRemaining: number; // 今日を含む残り日数
  fixedTotal: number; // 今月の固定費（定期計上・分割の合計）。月初に満額を先取り済み
  monthRemaining: number; // 日割り前の土台（今月収入 − 貯金目標 − 固定費 − 昨日までの変動支出）。マイナス＝今月使える残りなし
}

// ---------------------------------------------------------------------------
// C12: 固定費/変動費の区別。
// 固定費 = 定期計上（source='recurring'）のうち、元の定期の is_fixed が 1 のもの。
// recurring_id が無い旧レコード・元の定期が削除済みのものは従来どおり固定扱い（COALESCE(...,1)）。
// 変動費 = それ以外すべて（is_fixed=0 の定期計上は「変動費」として日々の支出側に数える）。
// デフォルトは全定期 is_fixed=1 なので、旧来の source != 'recurring' 判定と完全に同じ結果になる。
// ---------------------------------------------------------------------------

/** 「固定費として扱う支出」のSQL条件（expenses の別名は e 固定・sqlite/postgres共通） */
export const FIXED_EXPENSE_COND =
  "(e.source = 'recurring' AND COALESCE((SELECT r.is_fixed FROM recurring_items r WHERE r.id = e.recurring_id), 1) = 1)";
/** 「変動費として扱う支出」のSQL条件（expenses の別名は e 固定） */
export const VARIABLE_EXPENSE_COND = `NOT ${FIXED_EXPENSE_COND}`;

/** 今日の変動支出合計（日次予算の「今日使った分」。固定費は先取り済みなので含めない） */
export async function todaySpent(userId: string, today = todayStr()): Promise<number> {
  const d = await db();
  const row = (await d.get<{ s: number }>(
    `SELECT COALESCE(SUM(e.amount), 0) AS s FROM expenses e WHERE e.user_id = ? AND e.date = ? AND ${VARIABLE_EXPENSE_COND}`,
    userId,
    today,
  )) as { s: number };
  return Number(row.s);
}

/** 今月の固定費合計（is_fixed=1 の定期・分割で expenses に計上された支出。月初に一括計上済み） */
export async function monthFixedCost(userId: string, month: string): Promise<number> {
  const d = await db();
  const range = await monthRange(userId, month); // B9: 期間内に計上された定期支出を先取り扱い
  const row = (await d.get<{ s: number }>(
    `SELECT COALESCE(SUM(e.amount), 0) AS s FROM expenses e WHERE e.user_id = ? AND e.date >= ? AND e.date <= ? AND ${FIXED_EXPENSE_COND}`,
    userId,
    range.start,
    range.end,
  )) as { s: number };
  return Number(row.s);
}

/**
 * 今日使えるお金（日次予算＋繰り越し方式）。
 * 貯金目標を先に差し引く「先取り貯金」方式：残った分だけ使えば目標が必ず貯まる。
 * 固定費（定期計上・分割）は今月分を満額先取りして土台から引き、日々の数字は変動支出だけで動かす。
 * → 家賃などの計上日に「今日あと使える額」が一気にマイナスへ崩壊しない。
 * 予算は「昨日までの変動支出」だけで割り、今日使った分は予算から満額引く。
 * → 今日使いすぎれば「今日あと使える額」が即マイナスになり、翌日の予算も自動的に減る。
 * 旧方式（今月の全支出を引いてから割る）は今日の支出が残り日数で薄まって見える楽観バイアスがあった。
 */
export function dailyBudget(
  summary: MonthSummary,
  spentToday: number,
  savingsGoal = 0,
  today = todayStr(),
  fixedTotal = 0,
  monthStartDay = 1, // B9: 締め日基準の残り日数で日割りする
): DailyBudget {
  // summary.expenseTotal は固定費込みの実額。ここから固定費と今日の変動分を除くと「昨日までの変動支出」
  const spentBeforeToday = summary.expenseTotal - fixedTotal - spentToday;
  const daysRemaining = daysRemainingInMonth(today, monthStartDay);
  const monthRemaining = summary.incomeTotal - savingsGoal - fixedTotal - spentBeforeToday;
  const todayBudget = Math.floor(monthRemaining / daysRemaining);
  return {
    todayBudget,
    spentToday,
    remainingToday: todayBudget - spentToday,
    spentBeforeToday,
    daysRemaining,
    fixedTotal,
    monthRemaining,
  };
}

export interface NextPayday {
  date: string; // 次の給料日
  amount: number; // 入力済みシフトから計算した金額（0＝シフト未入力で金額未定）
  daysUntil: number; // 今日からの日数（0＝今日）
}

/**
 * 今日以降で最初に来る給料日（ホームの「次の給料日」行・予算切れ時の案内用）。
 * 入力済みシフトから金額が出る場合のみ金額つき。シフト未入力でも給料日設定があれば日付だけ返す。
 */
export async function nextPayday(userId: string, today = todayStr()): Promise<NextPayday | null> {
  const d = await db();
  const jobs = await d.all<JobRow & { pay_day: number; color: string }>(
    "SELECT id, name, weekday_rate, weekend_holiday_rate, transport_per_shift, closing_day, pay_month_offset, pay_day, pay_same_day, color FROM jobs WHERE user_id = ?",
    userId,
  );
  if (jobs.length === 0) return null;
  const candidates: { date: string; amount: number }[] = [];
  // 当月〜2ヶ月先までの給料日から「今日以降」を拾う（給料日は最長でも翌々月には来る）
  // B9: カレンダー月ベースで走査する（給料日はカレンダー日付なので締め日設定の影響を受けない）
  let month = monthOf(today);
  for (let i = 0; i < 3; i++) {
    const confirmed = (await calendarPaydays(userId, month)).filter((p) => p.date >= today);
    for (const p of confirmed) candidates.push({ date: p.date, amount: p.amount });
    // シフト未入力で paydays に出ないバイト先も、給料日設定があれば日付だけの候補にする
    const covered = new Set(confirmed.map((p) => p.jobId));
    for (const job of jobs) {
      if (job.pay_same_day || covered.has(job.id)) continue;
      const date = dateStr(month, Math.min(job.pay_day || 25, daysInMonth(month)));
      if (date >= today) candidates.push({ date, amount: 0 });
    }
    month = nextMonth(month);
  }
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => a.date.localeCompare(b.date));
  const first = candidates[0].date;
  const amount = candidates.filter((c) => c.date === first).reduce((s, c) => s + c.amount, 0);
  const daysUntil = Math.round(
    (parseLocalDate(first).getTime() - parseLocalDate(today).getTime()) / 86_400_000,
  );
  return { date: first, amount, daysUntil };
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
  const range = await monthRange(userId, summary.month); // B9: 経過日数・残り日数も締め日基準
  const row = (await d.get<{ s: number }>(
    `SELECT COALESCE(SUM(e.amount), 0) AS s FROM expenses e WHERE e.user_id = ? AND e.date >= ? AND e.date <= ? AND ${VARIABLE_EXPENSE_COND}`,
    userId,
    range.start,
    range.end,
  )) as { s: number };
  const today = todayStr(); // JST固定（jstTodayStr）
  const totalDays = daysBetween(range.start, range.end) + 1;
  const daysPassed = Math.min(totalDays, Math.max(1, daysBetween(range.start, today) + 1));
  const avgDaily = row.s / daysPassed;
  const futureSpend = avgDaily * (totalDays - daysPassed);
  return {
    forecast: Math.round(summary.incomeTotal - summary.expenseTotal - futureSpend),
    avgDaily: Math.round(avgDaily),
  };
}

export interface NoMoneyDays {
  count: number; // 今月ここまでのノーマネーデー数
  streak: number; // 今日までの連続日数（今日未消費なら今日も含む）
}

/** ノーマネーデー：変動支出（固定費の定期計上を除く）が1件も無かった日。過去月は月全体、当月は今日まで */
export async function noMoneyDays(userId: string, month: string): Promise<NoMoneyDays> {
  const d = await db();
  const range = await monthRange(userId, month); // B9: 期間は締め日基準
  const rows = await d.all<{ date: string }>(
    `SELECT DISTINCT e.date FROM expenses e WHERE e.user_id = ? AND e.date >= ? AND e.date <= ? AND ${VARIABLE_EXPENSE_COND}`,
    userId,
    range.start,
    range.end,
  );
  const spent = new Set(rows.map((r) => r.date));
  const today = todayStr();
  const lastDate = range.end < today ? range.end : today;
  if (lastDate < range.start) return { count: 0, streak: 0 }; // 未来の集計月
  const dates: string[] = [];
  for (let dt = range.start; dt <= lastDate; dt = addDays(dt, 1)) dates.push(dt);
  let count = 0;
  for (const dt of dates) if (!spent.has(dt)) count++;
  let streak = 0;
  for (let i = dates.length - 1; i >= 0; i--) {
    if (spent.has(dates[i])) break;
    streak++;
  }
  return { count, streak };
}

export interface CategorySpend {
  category: string;
  amount: number;
  count: number;
}

// ---------------------------------------------------------------------------
// B11: 支出の検索（店名/メモの部分一致＋カテゴリ＋金額範囲。全期間・ページング）
// ---------------------------------------------------------------------------

export interface ExpenseSearchQuery {
  q?: string; // 店名/メモの部分一致
  categoryId?: string;
  min?: number | null; // 金額下限（円）
  max?: number | null; // 金額上限（円）
  offset?: number;
  limit?: number;
}

export interface ExpenseSearchResult {
  expenses: {
    id: string;
    date: string;
    amount: number;
    memo: string;
    source: string;
    category_id: string | null;
    receipt_id: string | null;
    category: string | null;
    icon: string | null;
  }[];
  total: number; // 条件に合う全件数（ページング用）
  offset: number;
  limit: number;
}

/** LIKE 用エスケープ（% _ \ をリテラル扱いに） */
function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (m) => `\\${m}`);
}

export async function searchExpenses(
  userId: string,
  query: ExpenseSearchQuery,
): Promise<ExpenseSearchResult> {
  const d = await db();
  const conds = ["e.user_id = ?"];
  const params: (string | number)[] = [userId];
  const q = (query.q ?? "").trim();
  if (q) {
    conds.push("e.memo LIKE ? ESCAPE '\\'");
    params.push(`%${escapeLike(q)}%`);
  }
  if (query.categoryId) {
    conds.push("e.category_id = ?");
    params.push(query.categoryId);
  }
  if (query.min != null && Number.isFinite(query.min)) {
    conds.push("e.amount >= ?");
    params.push(Math.round(query.min));
  }
  if (query.max != null && Number.isFinite(query.max) && query.max > 0) {
    conds.push("e.amount <= ?");
    params.push(Math.round(query.max));
  }
  const where = conds.join(" AND ");
  const limit = Math.min(Math.max(1, Math.round(query.limit ?? 50)), 100);
  const offset = Math.max(0, Math.round(query.offset ?? 0));
  const totalRow = (await d.get<{ c: number }>(
    `SELECT COUNT(*) AS c FROM expenses e WHERE ${where}`,
    ...params,
  )) as { c: number };
  const expenses = await d.all<ExpenseSearchResult["expenses"][number]>(
    `SELECT e.id, e.date, e.amount, e.memo, e.source, e.category_id, e.receipt_id, c.name AS category, c.icon
     FROM expenses e LEFT JOIN categories c ON c.id = e.category_id AND c.user_id = e.user_id
     WHERE ${where} ORDER BY e.date DESC, e.created_at DESC LIMIT ${limit} OFFSET ${offset}`,
    ...params,
  );
  return {
    expenses: expenses.map((e) => ({ ...e, amount: Number(e.amount) })),
    total: Number(totalRow.c),
    offset,
    limit,
  };
}

// ---------------------------------------------------------------------------
// C13: 袋分けポケット（カテゴリ別月予算）と繰り越し。
// carryover=1 のカテゴリは「前月の余り（予算−前月支出）」を当月予算に加算表示する。
// マイナス繰り越しはしない（前月オーバーしても当月予算は減らさない・0下限）。
// ---------------------------------------------------------------------------

export interface PocketBudget {
  id: string;
  name: string;
  icon: string;
  budget: number; // 設定した月予算（土台）
  spent: number; // 今月の支出
  carryover: number; // 1=繰り越しON
  carryoverAmount: number; // 前月の余り（0下限。carryover=0なら常に0）
}

export async function pocketBudgets(
  userId: string,
  month = currentMonth(),
): Promise<PocketBudget[]> {
  const prev = shiftMonthBy(month, -1);
  const d = await db();
  const rows = await d.all<Omit<PocketBudget, "carryoverAmount"> & { prev_spent: number }>(
    `SELECT c.id, c.name, c.icon, COALESCE(b.amount, 0) AS budget, COALESCE(b.carryover, 0) AS carryover,
            COALESCE((SELECT SUM(e.amount) FROM expenses e WHERE e.user_id = c.user_id AND e.category_id = c.id AND e.date LIKE ?), 0) AS spent,
            COALESCE((SELECT SUM(e.amount) FROM expenses e WHERE e.user_id = c.user_id AND e.category_id = c.id AND e.date LIKE ?), 0) AS prev_spent
     FROM categories c
     LEFT JOIN category_budgets b ON b.category_id = c.id AND b.user_id = c.user_id
     WHERE c.user_id = ? ORDER BY c.sort`,
    `${month}-%`,
    `${prev}-%`,
    userId,
  );
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    icon: r.icon,
    budget: Number(r.budget),
    spent: Number(r.spent),
    carryover: Number(r.carryover),
    carryoverAmount:
      Number(r.carryover) && Number(r.budget) > 0
        ? Math.max(0, Number(r.budget) - Number(r.prev_spent))
        : 0,
  }));
}

/** 月のカテゴリ別支出（レビュー用） */
export async function categoryBreakdown(userId: string, month: string): Promise<CategorySpend[]> {
  const d = await db();
  const range = await monthRange(userId, month); // B9: 期間は締め日基準
  // GROUP BY に c.name を含める（Postgres の集約規則対応。category_id ごとに c.name は一意なので結果は不変）
  return d.all<CategorySpend>(
    `SELECT COALESCE(c.name, '未分類') AS category, SUM(e.amount) AS amount, COUNT(*) AS count
     FROM expenses e LEFT JOIN categories c ON c.id = e.category_id AND c.user_id = e.user_id
     WHERE e.user_id = ? AND e.date >= ? AND e.date <= ?
     GROUP BY e.category_id, c.name ORDER BY amount DESC`,
    userId,
    range.start,
    range.end,
  );
}

// ---------------------------------------------------------------------------
// 前月比・前年同月比の比較（グラフ画面の「月」ビュー用）。
// 集計は既存の monthSummary / breakdown を再利用し、差分計算だけを純関数化する。
// prev / prevYear が null の月（記録が1件も無い月）は「比較データなし」として扱えるよう
// null を保持する。0（収支どちらかが0）は有効なデータなので null とは区別する。
// ---------------------------------------------------------------------------

export interface MonthTotals {
  income: number;
  expense: number;
}

export interface CompareMetric {
  current: number;
  prev: number | null; // null＝前月にデータなし
  prevYear: number | null; // null＝前年同月にデータなし
}

export interface CategoryDelta {
  category: string;
  icon: string;
  current: number; // 今月の支出
  prev: number; // 前月の支出
  delta: number; // current − prev（＋＝増加）
}

export interface MonthComparison {
  expense: CompareMetric;
  income: CompareMetric;
  increased: CategoryDelta[]; // 今月 vs 前月で増えたカテゴリ Top3
  decreased: CategoryDelta[]; // 今月 vs 前月で減ったカテゴリ Top3
}

interface BreakdownLite {
  category: string;
  icon: string;
  amount: number;
}

/**
 * 今月・前月・前年同月の合計とカテゴリ内訳から比較サマリーを組み立てる純関数。
 * カテゴリ増減は今月・前月の内訳を突き合わせて delta（今月−前月）を出し、
 * 増加・減少をそれぞれ絶対額の大きい順に Top3 返す。
 */
export function buildMonthComparison(
  current: MonthTotals,
  prev: MonthTotals | null,
  prevYear: MonthTotals | null,
  currentBreakdown: BreakdownLite[],
  prevBreakdown: BreakdownLite[],
): MonthComparison {
  // 前月に記録が無い（prev=null）月は、全カテゴリが「増加」に見えて誤読を招くので増減は出さない。
  const map = new Map<string, CategoryDelta>();
  const put = (b: BreakdownLite, key: "current" | "prev") => {
    const row = map.get(b.category) ?? {
      category: b.category,
      icon: b.icon,
      current: 0,
      prev: 0,
      delta: 0,
    };
    row[key] = b.amount;
    if (b.icon) row.icon = b.icon; // icon が付いている側を優先
    map.set(b.category, row);
  };
  if (prev) {
    for (const b of currentBreakdown) put(b, "current");
    for (const b of prevBreakdown) put(b, "prev");
  }
  const deltas = [...map.values()].map((r) => ({ ...r, delta: r.current - r.prev }));
  const increased = deltas
    .filter((d) => d.delta > 0)
    .sort((a, b) => b.delta - a.delta)
    .slice(0, 3);
  const decreased = deltas
    .filter((d) => d.delta < 0)
    .sort((a, b) => a.delta - b.delta)
    .slice(0, 3);
  return {
    expense: {
      current: current.expense,
      prev: prev ? prev.expense : null,
      prevYear: prevYear ? prevYear.expense : null,
    },
    income: {
      current: current.income,
      prev: prev ? prev.income : null,
      prevYear: prevYear ? prevYear.income : null,
    },
    increased,
    decreased,
  };
}
