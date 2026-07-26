// カレンダー自動同期の差分適用。クライアントが読み取った候補一覧を渡すと、
// その月・そのバイト先の source='calendar' シフトと突き合わせて追加/更新/削除する。
// 手入力（source='manual'）のシフトには一切触らない。
import { AuthError, requireUser, unauthorized } from "@/lib/auth";
import { db, uid } from "@/lib/db";

export const dynamic = "force-dynamic";

interface Candidate {
  date: string;
  startMin: number;
  endMin: number;
}

export async function POST(request: Request) {
  try {
    const user = await requireUser();
    const body = (await request.json()) as {
      jobId?: string;
      month?: string;
      candidates?: Candidate[];
    };
    if (!body.jobId || !body.month || !/^\d{4}-\d{2}$/.test(body.month)) {
      return Response.json({ error: "jobId と month は必須です。" }, { status: 400 });
    }
    const d = db();
    const job = d
      .prepare("SELECT id FROM jobs WHERE id = ? AND user_id = ?")
      .get(body.jobId, user.id);
    if (!job) return Response.json({ error: "バイト先が見つかりません。" }, { status: 400 });
    const candidates = (body.candidates ?? [])
      .map((c) => ({
        ...c,
        // 日跨ぎシフト（22:00〜翌2:00等）は翌日扱いに正規化
        endMin: c.endMin <= c.startMin ? c.endMin + 1440 : c.endMin,
      }))
      .filter(
        (c) =>
          /^\d{4}-\d{2}-\d{2}$/.test(c.date) &&
          c.date.startsWith(body.month!) &&
          Number.isFinite(c.startMin) &&
          Number.isFinite(c.endMin) &&
          c.endMin > c.startMin,
      );
    const existing = d
      .prepare(
        "SELECT id, date, start_min, end_min, source FROM shifts WHERE user_id = ? AND job_id = ? AND date LIKE ?",
      )
      .all(user.id, body.jobId, `${body.month}-%`) as unknown as {
      id: string;
      date: string;
      start_min: number;
      end_min: number;
      source: string;
    }[];
    const manualDates = new Set(existing.filter((s) => s.source === "manual").map((s) => s.date));
    const calByDate = new Map(existing.filter((s) => s.source === "calendar").map((s) => [s.date, s]));
    const candByDate = new Map(candidates.map((c) => [c.date, c]));

    let added = 0;
    let updated = 0;
    let removed = 0;
    const ins = d.prepare(
      "INSERT INTO shifts (id, user_id, job_id, date, start_min, end_min, break_min, source) VALUES (?, ?, ?, ?, ?, ?, 0, 'calendar')",
    );

    for (const [date, c] of candByDate) {
      if (manualDates.has(date)) continue; // 手入力優先
      const ex = calByDate.get(date);
      if (!ex) {
        ins.run(uid(), user.id, body.jobId, date, Math.round(c.startMin), Math.round(c.endMin));
        added++;
      } else if (ex.start_min !== Math.round(c.startMin) || ex.end_min !== Math.round(c.endMin)) {
        d.prepare("UPDATE shifts SET start_min = ?, end_min = ? WHERE id = ?").run(
          Math.round(c.startMin),
          Math.round(c.endMin),
          ex.id,
        );
        updated++;
      }
    }
    // カレンダーから消えた予定（シフト取り消し）を削除
    for (const [date, ex] of calByDate) {
      if (!candByDate.has(date)) {
        d.prepare("DELETE FROM shifts WHERE id = ?").run(ex.id);
        removed++;
      }
    }
    return Response.json({ ok: true, added, updated, removed });
  } catch (e) {
    if (e instanceof AuthError) return unauthorized();
    return Response.json({ error: String(e) }, { status: 500 });
  }
}
