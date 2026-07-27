import { AuthError, requireUser, unauthorized } from "@/lib/auth";
import { JOB_COLORS, db, uid } from "@/lib/db";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const user = await requireUser();
    const d = await db();
    // shift_count: バイト先削除時の「シフト◯件も削除されます」表示用（B7）
    const jobs = await d.all(
      `SELECT j.id, j.name, j.weekday_rate, j.weekend_holiday_rate, j.transport_per_shift,
              j.calendar_keywords, j.calendar_exclude, j.color, j.closing_day,
              j.pay_month_offset, j.pay_day, j.pay_same_day,
              (SELECT COUNT(*) FROM shifts s WHERE s.job_id = j.id AND s.user_id = j.user_id) AS shift_count
       FROM jobs j WHERE j.user_id = ?`,
      user.id,
    );
    return Response.json({ jobs });
  } catch (e) {
    if (e instanceof AuthError) return unauthorized();
    return Response.json({ error: String(e) }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const user = await requireUser();
    const body = (await request.json()) as {
      id?: string;
      name?: string;
      weekdayRate?: number;
      weekendHolidayRate?: number;
      transportPerShift?: number;
      calendarKeywords?: string;
      calendarExclude?: string;
      closingDay?: number;
      payMonthOffset?: number;
      payDay?: number;
      paySameDay?: boolean;
    };
    const d = await db();
    if (body.id) {
      // 部分更新：bodyに無い項目は「すべて」既存値を保持する。
      // （以前は未指定項目をデフォルトで上書きし、カレンダー同期のたびに給料日設定が消えるバグがあった）
      const cur = await d.get<{
        name: string;
        weekday_rate: number;
        weekend_holiday_rate: number;
        transport_per_shift: number;
        calendar_keywords: string;
        calendar_exclude: string;
        closing_day: number;
        pay_month_offset: number;
        pay_day: number;
        pay_same_day: number;
      }>(
        "SELECT name, weekday_rate, weekend_holiday_rate, transport_per_shift, calendar_keywords, calendar_exclude, closing_day, pay_month_offset, pay_day, pay_same_day FROM jobs WHERE id = ? AND user_id = ?",
        body.id,
        user.id,
      );
      if (!cur) return Response.json({ error: "バイト先が見つかりません。" }, { status: 404 });
      const name = body.name !== undefined ? body.name.trim() : cur.name;
      const weekday =
        body.weekdayRate !== undefined ? Math.round(Number(body.weekdayRate)) : cur.weekday_rate;
      if (!name || !Number.isFinite(weekday) || weekday <= 0) {
        return Response.json({ error: "名前と平日時給は必須です。" }, { status: 400 });
      }
      const weekend =
        body.weekendHolidayRate !== undefined
          ? Math.round(Number(body.weekendHolidayRate)) || weekday
          : cur.weekend_holiday_rate;
      const transport =
        body.transportPerShift !== undefined
          ? Math.max(0, Math.round(Number(body.transportPerShift) || 0))
          : cur.transport_per_shift;
      const keywords =
        body.calendarKeywords !== undefined ? body.calendarKeywords.trim() : cur.calendar_keywords;
      const excludes =
        body.calendarExclude !== undefined ? body.calendarExclude.trim() : cur.calendar_exclude;
      const closingDay =
        body.closingDay !== undefined
          ? Math.min(Math.max(1, Math.round(Number(body.closingDay) || 31)), 31)
          : cur.closing_day;
      const payOffset =
        body.payMonthOffset !== undefined ? (Number(body.payMonthOffset) === 1 ? 1 : 0) : cur.pay_month_offset;
      const payDay =
        body.payDay !== undefined
          ? Math.min(Math.max(1, Math.round(Number(body.payDay) || 25)), 31)
          : cur.pay_day;
      const paySameDay = body.paySameDay !== undefined ? (body.paySameDay ? 1 : 0) : cur.pay_same_day;
      await d.run(
        "UPDATE jobs SET name = ?, weekday_rate = ?, weekend_holiday_rate = ?, transport_per_shift = ?, calendar_keywords = ?, calendar_exclude = ?, closing_day = ?, pay_month_offset = ?, pay_day = ?, pay_same_day = ? WHERE id = ? AND user_id = ?",
        name,
        weekday,
        weekend,
        transport,
        keywords,
        excludes,
        closingDay,
        payOffset,
        payDay,
        paySameDay,
        body.id,
        user.id,
      );
      return Response.json({ ok: true, id: body.id });
    }
    // 新規作成
    const name = (body.name ?? "").trim();
    const weekday = Math.round(Number(body.weekdayRate));
    if (!name || !Number.isFinite(weekday) || weekday <= 0) {
      return Response.json({ error: "名前と平日時給は必須です。" }, { status: 400 });
    }
    const weekend = Math.round(Number(body.weekendHolidayRate)) || weekday;
    const transport = Math.max(0, Math.round(Number(body.transportPerShift) || 0));
    const keywords = (body.calendarKeywords ?? "").trim();
    const excludes = (body.calendarExclude ?? "").trim();
    const closingDay = Math.min(Math.max(1, Math.round(Number(body.closingDay) || 31)), 31);
    const payOffset = body.payMonthOffset === 1 ? 1 : 0;
    const payDay = Math.min(Math.max(1, Math.round(Number(body.payDay) || 25)), 31);
    const id = uid();
    // 掛け持ちでも見分けられるよう、作成順にパレットから色を自動割り当て
    const count = (
      (await d.get<{ c: number }>("SELECT COUNT(*) AS c FROM jobs WHERE user_id = ?", user.id)) as {
        c: number;
      }
    ).c;
    const color = JOB_COLORS[count % JOB_COLORS.length];
    await d.run(
      "INSERT INTO jobs (id, user_id, name, weekday_rate, weekend_holiday_rate, transport_per_shift, calendar_keywords, calendar_exclude, color, closing_day, pay_month_offset, pay_day, pay_same_day) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      id,
      user.id,
      name,
      weekday,
      weekend,
      transport,
      keywords,
      excludes,
      color,
      closingDay,
      payOffset,
      payDay,
      body.paySameDay ? 1 : 0,
    );
    return Response.json({ ok: true, id });
  } catch (e) {
    if (e instanceof AuthError) return unauthorized();
    return Response.json({ error: String(e) }, { status: 500 });
  }
}

export async function DELETE(request: Request) {
  try {
    const user = await requireUser();
    const id = new URL(request.url).searchParams.get("id");
    if (!id) return Response.json({ error: "id required" }, { status: 400 });
    const d = await db();
    await d.run("DELETE FROM shifts WHERE job_id = ? AND user_id = ?", id, user.id);
    await d.run("DELETE FROM jobs WHERE id = ? AND user_id = ?", id, user.id);
    return Response.json({ ok: true });
  } catch (e) {
    if (e instanceof AuthError) return unauthorized();
    return Response.json({ error: String(e) }, { status: 500 });
  }
}
