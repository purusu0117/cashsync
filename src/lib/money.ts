// 収支・給与・定期計上のドメインロジック（もこもこ家計簿 app.js から移植・一般化）。
// サーバー専用（db を触る）。純粋計算の部分は関数単位でテスト可能に分離。
import { isHoliday } from "@holiday-jp/holiday_jp";
import { db, uid } from "./db";

export function todayStr(): string {
  const n = new Date();
  return `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, "0")}-${String(n.getDate()).padStart(2, "0")}`;
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

/** 今日を含む残り日数（前作 daysRemainingInMonth の移植）。today はテスト用に差し替え可 */
export function daysRemainingInMonth(today = todayStr()): number {
  return daysInMonth(monthOf(today)) - Number(today.slice(8)) + 1;
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
export function monthShiftIncome(userId: string, month: string): MonthShiftIncome {
  const d = db();
  const jobs = d
    .prepare(
      "SELECT id, name, weekday_rate, weekend_holiday_rate, transport_per_shift, closing_day, pay_month_offset, pay_same_day FROM jobs WHERE user_id = ?",
    )
    .all(userId) as unknown as JobRow[];
  let total = 0;
  let weekdayHours = 0;
  let weekendHolidayHours = 0;
  let shiftCount = 0;
  const stmt = d.prepare(
    "SELECT id, job_id, date, start_min, end_min, break_min FROM shifts WHERE user_id = ? AND job_id = ? AND date >= ? AND date <= ?",
  );
  for (const job of jobs) {
    const period = payPeriodFor(job, month);
    const shifts = stmt.all(userId, job.id, period.start, period.end) as unknown as ShiftRow[];
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
export function monthWorkIncome(userId: string, month: string): MonthShiftIncome {
  const d = db();
  const jobs = new Map(
    (
      d
        .prepare(
          "SELECT id, name, weekday_rate, weekend_holiday_rate, transport_per_shift, closing_day, pay_month_offset FROM jobs WHERE user_id = ?",
        )
        .all(userId) as unknown as JobRow[]
    ).map((j) => [j.id, j]),
  );
  const shifts = d
    .prepare(
      "SELECT id, job_id, date, start_min, end_min, break_min FROM shifts WHERE user_id = ? AND date LIKE ?",
    )
    .all(userId, `${month}-%`) as unknown as ShiftRow[];
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
export function paydays(userId: string, month: string): Payday[] {
  const d = db();
  const jobs = d
    .prepare(
      "SELECT id, name, weekday_rate, weekend_holiday_rate, transport_per_shift, closing_day, pay_month_offset, pay_day, pay_same_day, color FROM jobs WHERE user_id = ?",
    )
    .all(userId) as unknown as (JobRow & { pay_day: number; color: string; name: string })[];
  const out: Payday[] = [];
  const stmt = d.prepare(
    "SELECT id, job_id, date, start_min, end_min, break_min FROM shifts WHERE user_id = ? AND job_id = ? AND date >= ? AND date <= ?",
  );
  for (const job of jobs) {
    const period = payPeriodFor(job, month);
    const shifts = stmt.all(userId, job.id, period.start, period.end) as unknown as ShiftRow[];
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
 */
export function postRecurringForMonth(userId: string, upToMonth: string) {
  const d = db();
  const items = d
    .prepare(
      `SELECT r.id, r.kind, r.name, r.amount, r.category_id, r.start_month, r.end_month, r.post_day, r.interval
       FROM recurring_items r WHERE r.user_id = ? AND r.start_month <= ?`,
    )
    .all(userId, upToMonth) as unknown as {
    id: string;
    kind: string;
    name: string;
    amount: number;
    category_id: string | null;
    start_month: string;
    end_month: string | null;
    post_day: number;
    interval: string; // 'monthly' | 'yearly'
  }[];
  if (items.length === 0) return;
  const insExp = d.prepare(
    "INSERT INTO expenses (id, user_id, date, amount, category_id, memo, source, created_at) VALUES (?, ?, ?, ?, ?, ?, 'recurring', ?)",
  );
  const insInc = d.prepare(
    "INSERT INTO incomes (id, user_id, date, amount, type, memo, created_at) VALUES (?, ?, ?, ?, 'recurring', ?, ?)",
  );
  const mark = d.prepare("INSERT INTO recurring_posts (recurring_id, month) VALUES (?, ?)");
  for (const it of items) {
    let month = it.start_month;
    let guard = 0;
    while (month <= upToMonth && (!it.end_month || month <= it.end_month) && guard++ < 120) {
      // 年払いは「毎年、開始月と同じ月」だけ計上（例：2026-07開始なら毎年7月）
      if (it.interval === "yearly" && month.slice(5) !== it.start_month.slice(5)) {
        month = nextMonth(month);
        continue;
      }
      try {
        mark.run(it.id, month); // 計上済みならPK制約でここが throw → skip
        const day = String(Math.min(Math.max(1, it.post_day), daysInMonth(month))).padStart(2, "0");
        const date = `${month}-${day}`;
        if (it.kind === "expense") {
          insExp.run(uid(), userId, date, it.amount, it.category_id, it.name, Date.now());
        } else {
          insInc.run(uid(), userId, date, it.amount, it.name, Date.now());
        }
      } catch {
        /* 計上済み */
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
export function monthPlan(userId: string, month: string): MonthPlan {
  const plan: MonthPlan = { expenses: [], incomes: [], paydays: [], expenseTotal: 0, incomeTotal: 0 };
  if (month <= currentMonth()) return plan;
  const d = db();

  // 定期支出・収入（分割払いは end_month 付きの定期支出として登録されている）
  const items = d
    .prepare(
      `SELECT r.id, r.kind, r.name, r.amount, r.start_month, r.end_month, r.post_day, r.interval,
              c.name AS category, c.icon
       FROM recurring_items r
       LEFT JOIN categories c ON c.id = r.category_id AND c.user_id = r.user_id
       WHERE r.user_id = ? AND r.start_month <= ? AND (r.end_month IS NULL OR r.end_month >= ?)`,
    )
    .all(userId, month, month) as unknown as {
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
  }[];
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
  const confirmed = paydays(userId, month);
  const covered = new Set(confirmed.map((p) => p.jobId));
  for (const p of confirmed) {
    plan.paydays.push({ ...p, confirmed: true });
    plan.incomeTotal += p.amount;
  }
  const jobs = d
    .prepare(
      "SELECT id, name, color, closing_day, pay_month_offset, pay_day, pay_same_day FROM jobs WHERE user_id = ?",
    )
    .all(userId) as unknown as (JobRow & { pay_day: number; color: string })[];
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

export function monthSummary(userId: string, month: string): MonthSummary {
  const d = db();
  const exp = d
    .prepare("SELECT COALESCE(SUM(amount), 0) AS s FROM expenses WHERE user_id = ? AND date LIKE ?")
    .get(userId, `${month}-%`) as { s: number };
  const inc = d
    .prepare("SELECT COALESCE(SUM(amount), 0) AS s FROM incomes WHERE user_id = ? AND date LIKE ?")
    .get(userId, `${month}-%`) as { s: number };
  const shift = monthShiftIncome(userId, month);
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

/** 今日の変動支出合計（日次予算の「今日使った分」。定期計上は固定費として先取り済みなので含めない） */
export function todaySpent(userId: string, today = todayStr()): number {
  const row = db()
    .prepare(
      "SELECT COALESCE(SUM(amount), 0) AS s FROM expenses WHERE user_id = ? AND date = ? AND source != 'recurring'",
    )
    .get(userId, today) as { s: number };
  return row.s;
}

/** 今月の固定費合計（定期計上・分割で expenses に計上された支出。月初に一括計上済み） */
export function monthFixedCost(userId: string, month: string): number {
  const row = db()
    .prepare(
      "SELECT COALESCE(SUM(amount), 0) AS s FROM expenses WHERE user_id = ? AND date LIKE ? AND source = 'recurring'",
    )
    .get(userId, `${month}-%`) as { s: number };
  return row.s;
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
): DailyBudget {
  // summary.expenseTotal は固定費込みの実額。ここから固定費と今日の変動分を除くと「昨日までの変動支出」
  const spentBeforeToday = summary.expenseTotal - fixedTotal - spentToday;
  const daysRemaining = daysRemainingInMonth(today);
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
export function nextPayday(userId: string, today = todayStr()): NextPayday | null {
  const d = db();
  const jobs = d
    .prepare(
      "SELECT id, name, weekday_rate, weekend_holiday_rate, transport_per_shift, closing_day, pay_month_offset, pay_day, pay_same_day, color FROM jobs WHERE user_id = ?",
    )
    .all(userId) as unknown as (JobRow & { pay_day: number; color: string })[];
  if (jobs.length === 0) return null;
  const candidates: { date: string; amount: number }[] = [];
  // 当月〜2ヶ月先までの給料日から「今日以降」を拾う（給料日は最長でも翌々月には来る）
  let month = monthOf(today);
  for (let i = 0; i < 3; i++) {
    const confirmed = paydays(userId, month).filter((p) => p.date >= today);
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
export function monthForecast(userId: string, summary: MonthSummary): MonthForecast {
  const d = db();
  const row = d
    .prepare(
      "SELECT COALESCE(SUM(amount), 0) AS s FROM expenses WHERE user_id = ? AND date LIKE ? AND source != 'recurring'",
    )
    .get(userId, `${summary.month}-%`) as { s: number };
  const daysPassed = new Date().getDate();
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
export function noMoneyDays(userId: string, month: string): NoMoneyDays {
  const rows = db()
    .prepare(
      "SELECT DISTINCT date FROM expenses WHERE user_id = ? AND date LIKE ? AND source != 'recurring'",
    )
    .all(userId, `${month}-%`) as unknown as { date: string }[];
  const spent = new Set(rows.map((r) => r.date));
  const lastDay = month < currentMonth() ? daysInMonth(month) : Number(todayStr().slice(8));
  let count = 0;
  for (let d = 1; d <= lastDay; d++) {
    if (!spent.has(`${month}-${String(d).padStart(2, "0")}`)) count++;
  }
  let streak = 0;
  for (let d = lastDay; d >= 1; d--) {
    if (spent.has(`${month}-${String(d).padStart(2, "0")}`)) break;
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
export function categoryBreakdown(userId: string, month: string): CategorySpend[] {
  return db()
    .prepare(
      `SELECT COALESCE(c.name, '未分類') AS category, SUM(e.amount) AS amount, COUNT(*) AS count
       FROM expenses e LEFT JOIN categories c ON c.id = e.category_id AND c.user_id = e.user_id
       WHERE e.user_id = ? AND e.date LIKE ?
       GROUP BY e.category_id ORDER BY amount DESC`,
    )
    .all(userId, `${month}-%`) as unknown as CategorySpend[];
}
