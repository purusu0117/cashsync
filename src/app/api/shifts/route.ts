import { AuthError, requireUser, unauthorized } from "@/lib/auth";
import { db, uid } from "@/lib/db";
import { type JobRow, type ShiftRow, currentMonth, monthWorkIncome, shiftPay } from "@/lib/money";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const user = await requireUser();
    const month = new URL(request.url).searchParams.get("month") ?? currentMonth();
    const d = db();
    const shifts = d
      .prepare(
        `SELECT s.id, s.job_id, s.date, s.start_min, s.end_min, s.break_min, s.source, j.name AS job_name, j.color AS job_color
         FROM shifts s LEFT JOIN jobs j ON j.id = s.job_id
         WHERE s.user_id = ? AND s.date LIKE ? ORDER BY s.date`,
      )
      .all(user.id, `${month}-%`) as unknown as (ShiftRow & { source: string; job_name: string })[];
    const jobs = new Map(
      (
        d
          .prepare(
            "SELECT id, name, weekday_rate, weekend_holiday_rate, transport_per_shift, closing_day, pay_month_offset FROM jobs WHERE user_id = ?",
          )
          .all(user.id) as unknown as JobRow[]
      ).map((j) => [j.id, j]),
    );
    const withPay = shifts.map((s) => {
      const job = jobs.get(s.job_id);
      return { ...s, pay: job ? shiftPay(s, job) : 0 };
    });
    // シフト画面は「この月に働いた分の稼ぎ」を返す（実際の支払月はホーム/カレンダー側で給料日ベース表示）
    return Response.json({ shifts: withPay, income: monthWorkIncome(user.id, month) });
  } catch (e) {
    if (e instanceof AuthError) return unauthorized();
    return Response.json({ error: String(e) }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const user = await requireUser();
    const body = (await request.json()) as {
      jobId?: string;
      date?: string;
      startMin?: number;
      endMin?: number;
      breakMin?: number;
      source?: string;
    };
    if (!body.jobId || !body.date || !/^\d{4}-\d{2}-\d{2}$/.test(body.date)) {
      return Response.json({ error: "バイト先と日付は必須です。" }, { status: 400 });
    }
    const job = db()
      .prepare("SELECT id FROM jobs WHERE id = ? AND user_id = ?")
      .get(body.jobId, user.id);
    if (!job) return Response.json({ error: "バイト先が見つかりません。" }, { status: 400 });
    const start = Math.round(Number(body.startMin));
    let end = Math.round(Number(body.endMin));
    if (!Number.isFinite(start) || !Number.isFinite(end) || start === end) {
      return Response.json({ error: "時間帯が不正です。" }, { status: 400 });
    }
    if (end < start) end += 1440; // 22:00〜翌2:00 のような日跨ぎシフトは翌日扱い
    const id = uid();
    db()
      .prepare(
        "INSERT INTO shifts (id, user_id, job_id, date, start_min, end_min, break_min, source) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        id,
        user.id,
        body.jobId,
        body.date,
        start,
        end,
        Math.max(0, Math.round(Number(body.breakMin) || 0)),
        body.source === "calendar" ? "calendar" : "manual",
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
    db().prepare("DELETE FROM shifts WHERE id = ? AND user_id = ?").run(id, user.id);
    return Response.json({ ok: true });
  } catch (e) {
    if (e instanceof AuthError) return unauthorized();
    return Response.json({ error: String(e) }, { status: 500 });
  }
}
