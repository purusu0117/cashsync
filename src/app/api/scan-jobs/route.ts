// C5: AI読み取りのジョブ化。
//
// 従来は「画像をPOST → 20〜40秒レスポンスを待つ」だったため、アプリを閉じると読み取りが消えていた。
// ここでは画像を受け取ったら即 jobId を返し、解析は after()（レスポンス後も走る）で継続する。
// 画面を閉じてもサーバー側で完了し、結果はDBに残るので次に開いたときに確認できる。
//
//  POST   /api/scan-jobs        … 画像を渡してジョブ開始 → { jobId }
//  GET    /api/scan-jobs?id=…   … 1件の状態取得（running / done / failed）
//  GET    /api/scan-jobs        … 未確認の完了ジョブ一覧（ホームの案内カード用）
//  DELETE /api/scan-jobs?id=…   … 確認済み・破棄でジョブを消す
import { promises as fs } from "fs";
import os from "os";
import path from "path";
import { after } from "next/server";
import { askClaudeReceipt } from "@/lib/ai";
import { checkAndCountUsage, getUserPlan, limitResponseBody } from "@/lib/aiUsage";
import { AuthError, requireUser, unauthorized } from "@/lib/auth";
import { db, uid } from "@/lib/db";
import { fmtYen } from "@/lib/format";
import { imageHashOf, learnedCategoryId, recordedImage } from "@/lib/merchant";
import { pushRecordResult } from "@/lib/push";

export const dynamic = "force-dynamic";
export const maxDuration = 180;

export async function POST(request: Request) {
  try {
    const user = await requireUser();
    const plan = await getUserPlan(user.id);
    const usage = await checkAndCountUsage(user.id, plan, "scans");
    if (!usage.allowed) {
      return Response.json(limitResponseBody("scans", usage, plan), { status: 429 });
    }
    const form = await request.formData();
    const file = form.get("image");
    if (!(file instanceof File)) {
      return Response.json({ error: "画像がありません。" }, { status: 400 });
    }
    const buf = Buffer.from(await file.arrayBuffer());
    const hash = imageHashOf(buf);

    // 同じ画像を既に記録済みなら、解析にAIを使わず即座に知らせる
    const already = await recordedImage(user.id, hash);
    if (already) {
      return Response.json(
        {
          duplicate: true,
          message: `このスクショは既に記録済みです（${already.date} ${fmtYen(already.amount)}${already.memo ? `／${already.memo}` : ""}）。`,
        },
        { status: 409 },
      );
    }

    const d = await db();
    const jobId = uid();
    const now = Date.now();
    await d.run(
      "INSERT INTO scan_jobs (id, user_id, status, image_hash, created_at, updated_at) VALUES (?, ?, 'running', ?, ?, ?)",
      jobId,
      user.id,
      hash,
      now,
      now,
    );

    // 画像は一時ファイルへ。after() の中で読んで消す
    const dir = path.join(os.tmpdir(), "cashsync-scan");
    await fs.mkdir(dir, { recursive: true });
    const ext = file.type.includes("png") ? "png" : "jpg";
    const tmp = path.join(dir, `${jobId}.${ext}`);
    await fs.writeFile(tmp, buf);

    // ここがポイント：レスポンスを返した後もこの処理は続く（アプリを閉じてもサーバーで完走する）
    after(async () => {
      const dd = await db();
      try {
        const categories = await dd.all<{ id: string; name: string }>(
          "SELECT id, name FROM categories WHERE user_id = ? ORDER BY sort",
          user.id,
        );
        const scan = await askClaudeReceipt(
          tmp,
          categories.map((c) => c.name),
          plan,
        );
        let categoryId = categories.find((c) => c.name === scan.category)?.id ?? null;
        let learned = false;
        if (scan.kind === "expense" && scan.store) {
          const l = await learnedCategoryId(user.id, scan.store);
          if (l) {
            categoryId = l;
            learned = true;
          }
        }
        const ok = !!scan.total || !!(scan.store ?? "").trim();
        await dd.run(
          "UPDATE scan_jobs SET status = ?, result_json = ?, error = ?, updated_at = ? WHERE id = ?",
          ok ? "done" : "failed",
          JSON.stringify({ scan, categoryId, learned, imageHash: hash }),
          ok ? null : "読み取れませんでした",
          Date.now(),
          jobId,
        );
        // 画面を閉じていても気づけるように通知する（設定でOFFにできる）
        if (ok) {
          await pushRecordResult(
            user.id,
            "CashSync 読み取りが終わりました",
            `${fmtYen(scan.total)}（${scan.store || "店名不明"}）。アプリを開いて確認・記録してください`,
          ).catch(() => {});
        } else {
          await pushRecordResult(
            user.id,
            "CashSync 読み取れませんでした",
            "⚠️金額を読み取れませんでした。写真を確認して撮り直してください",
          ).catch(() => {});
        }
      } catch (e) {
        console.error("[scan-jobs] failed:", e);
        await dd
          .run(
            "UPDATE scan_jobs SET status = 'failed', error = ?, updated_at = ? WHERE id = ?",
            e instanceof Error ? e.message : "読み取りに失敗しました",
            Date.now(),
            jobId,
          )
          .catch(() => {});
        await pushRecordResult(
          user.id,
          "CashSync 読み取れませんでした",
          "⚠️読み取りに失敗しました。もう一度お試しください",
        ).catch(() => {});
      } finally {
        await fs.rm(tmp, { force: true }).catch(() => {});
      }
    });

    return Response.json({ jobId });
  } catch (e) {
    if (e instanceof AuthError) return unauthorized();
    return Response.json({ error: e instanceof Error ? e.message : "scan failed" }, { status: 500 });
  }
}

export async function GET(request: Request) {
  try {
    const user = await requireUser();
    const id = new URL(request.url).searchParams.get("id");
    const d = await db();
    if (id) {
      const row = await d.get<{
        id: string;
        status: string;
        result_json: string | null;
        error: string | null;
      }>("SELECT id, status, result_json, error FROM scan_jobs WHERE id = ? AND user_id = ?", id, user.id);
      if (!row) return Response.json({ error: "not found" }, { status: 404 });
      return Response.json({
        id: row.id,
        status: row.status,
        error: row.error,
        ...(row.result_json ? JSON.parse(row.result_json) : {}),
      });
    }
    // 未確認の完了ジョブ（ホームの「読み取り結果があります」カード用）
    const rows = await d.all<{ id: string; status: string; result_json: string | null; created_at: number }>(
      "SELECT id, status, result_json, created_at FROM scan_jobs WHERE user_id = ? AND status = 'done' ORDER BY created_at DESC LIMIT 5",
      user.id,
    );
    return Response.json({
      jobs: rows.map((r) => ({
        id: r.id,
        createdAt: Number(r.created_at),
        ...(r.result_json ? JSON.parse(r.result_json) : {}),
      })),
    });
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
    await d.run("DELETE FROM scan_jobs WHERE id = ? AND user_id = ?", id, user.id);
    return Response.json({ ok: true });
  } catch (e) {
    if (e instanceof AuthError) return unauthorized();
    return Response.json({ error: String(e) }, { status: 500 });
  }
}
