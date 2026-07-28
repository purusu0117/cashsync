// iPhoneショートカット用のワンショットAPI：
// スクショを multipart で受け取り → AI読取 → そのまま支出として自動保存 → 結果メッセージを返す。
// 認証は Authorization: Bearer <api_token>（設定画面で表示・Shortcutsにコピペ）。
// ショートカット側はこの後「写真を削除」まで行う＝大翔の要望（読取→記録→スクショ削除）の実現手段。
import { promises as fs } from "fs";
import os from "os";
import path from "path";
import { EMAIL_UNVERIFIED_MESSAGE, emailVerificationRequired, isUserVerified } from "@/lib/account";
import { askClaudeReceipt } from "@/lib/ai";
import { checkAndCountUsage, getUserPlan, limitMessage } from "@/lib/aiUsage";
import { userFromBearer } from "@/lib/auth";
import { db, uid } from "@/lib/db";
import { fmtYen } from "@/lib/format";
import { imageHashOf, learnedCategoryId, recordedImage } from "@/lib/merchant";
import { todayStr } from "@/lib/money";
import { pushRecordResult } from "@/lib/push";

export const dynamic = "force-dynamic";
export const maxDuration = 180;

export async function POST(request: Request) {
  let tmp = "";
  try {
    // 注意: ok は boolean ではなく文字列 "true"/"false" で返す。
    // iOSショートカットのif文は JSON の boolean をテキスト "true" と比較すると一致しないため。
    const user = await userFromBearer(request);
    if (!user) {
      return Response.json(
        { ok: "false", message: "認証エラー：設定画面のトークンをショートカットに設定してください。" },
        { status: 401 },
      );
    }
    // 不正対策①（フラグ制御）: 確認必須ON時のみ、未確認ユーザーのAIコスト系を拒否（既存ユーザーは確認済み扱い）。
    if (emailVerificationRequired() && !(await isUserVerified(user.id))) {
      return Response.json({ ok: "false", message: EMAIL_UNVERIFIED_MESSAGE }, { status: 403 });
    }
    const plan = await getUserPlan(user.id);
    const usage = await checkAndCountUsage(user.id, plan, "scans");
    if (!usage.allowed) {
      return Response.json(
        { ok: "false", error: "limit", message: limitMessage("scans", plan) },
        { status: 429 },
      );
    }
    const form = await request.formData();
    const file = form.get("image");
    if (!(file instanceof File)) {
      return Response.json({ ok: "false", message: "画像がありません。" }, { status: 400 });
    }
    const buf = Buffer.from(await file.arrayBuffer());
    // 同じ画像を2回送ったときだけ弾く（同じ店・同じ金額の"別の支払い"は正常に記録する）
    const hash = imageHashOf(buf);
    const already = await recordedImage(user.id, hash);
    if (already) {
      const msg = `⚠️このスクショは既に記録済みです（${already.date} ${fmtYen(already.amount)}${already.memo ? `／${already.memo}` : ""}）。重複しないよう記録しませんでした。`;
      await pushRecordResult(user.id, "CashSync 記録しませんでした", msg);
      return Response.json({ ok: "false", message: msg }, { status: 409 });
    }
    const dir = path.join(os.tmpdir(), "cashsync-scan");
    await fs.mkdir(dir, { recursive: true });
    const ext = file.type.includes("png") ? "png" : "jpg";
    tmp = path.join(dir, `${globalThis.crypto.randomUUID()}.${ext}`);
    await fs.writeFile(tmp, buf);

    const d = await db();
    const categories = await d.all<{ id: string; name: string }>(
      "SELECT id, name FROM categories WHERE user_id = ? ORDER BY sort",
      user.id,
    );
    const scan = await askClaudeReceipt(
      tmp,
      categories.map((c) => c.name),
      plan,
    );
    if (!scan.total || scan.total <= 0) {
      const msg = "金額を読み取れませんでした。写真を確認してください。";
      await pushRecordResult(user.id, "CashSync 読み取れませんでした", `⚠️${msg}`);
      return Response.json({ ok: "false", message: msg }, { status: 422 });
    }
    const date = scan.date || todayStr();

    // 受け取り画面（PayPay受け取り・給与振込等）は収入として記録
    if (scan.kind === "income") {
      const memo = scan.store || "スクショ収入";
      await d.run(
        "INSERT INTO incomes (id, user_id, date, amount, type, memo, image_hash, created_at) VALUES (?, ?, ?, ?, 'other', ?, ?, ?)",
        uid(),
        user.id,
        date,
        scan.total,
        memo,
        hash,
        Date.now(),
      );
      const message = `${fmtYen(scan.total)}（${scan.store || "受け取り"}）を収入として記録しました`;
      await pushRecordResult(user.id, "CashSync 収入を記録しました", `✅${message}`);
      return Response.json({
        ok: "true",
        message,
        store: scan.store,
        total: scan.total,
        category: "",
        date,
      });
    }

    // マーチャント学習：この店で過去にユーザーが確定したカテゴリがあれば、AIの提案より優先
    let categoryId = categories.find((c) => c.name === scan.category)?.id ?? null;
    let categoryLabel = scan.category || "カテゴリなし";
    let learned = false;
    if (scan.store) {
      const l = await learnedCategoryId(user.id, scan.store);
      if (l) {
        categoryId = l;
        categoryLabel = categories.find((c) => c.id === l)?.name ?? categoryLabel;
        learned = true;
      }
    }
    const receiptId = uid();
    // レシートと支出は必ずセットで保存（片方だけ残る中途半端な状態を防ぐ）
    await d.transaction(async (tx) => {
      await tx.run(
        "INSERT INTO receipts (id, user_id, store, taken_date, total, items_json, image_hash, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        receiptId,
        user.id,
        scan.store,
        date,
        scan.total,
        JSON.stringify(scan.items),
        hash,
        Date.now(),
      );
      await tx.run(
        "INSERT INTO expenses (id, user_id, date, amount, category_id, memo, source, receipt_id, created_at) VALUES (?, ?, ?, ?, ?, ?, 'receipt', ?, ?)",
        uid(),
        user.id,
        date,
        scan.total,
        categoryId,
        scan.store,
        receiptId,
        Date.now(),
      );
    });

    const message = `${fmtYen(scan.total)}（${scan.store || "店名不明"}／${categoryLabel}${learned ? "・学習済み" : ""}）を記録しました`;
    await pushRecordResult(user.id, "CashSync 記録しました", `✅${message}`);
    return Response.json({
      ok: "true",
      message,
      store: scan.store,
      total: scan.total,
      category: learned ? categoryLabel : scan.category,
      date,
    });
  } catch (e) {
    console.error("[shortcut-scan] failed:", e); // server.logに残す（原因調査用）
    const failUser = await userFromBearer(request);
    if (failUser) {
      await pushRecordResult(
        failUser.id,
        "CashSync 記録できませんでした",
        `⚠️読み取りに失敗しました：${e instanceof Error ? e.message : "エラー"}。写真は消さずに残しています。`,
      ).catch(() => {});
    }
    return Response.json(
      { ok: "false", message: `読み取りに失敗しました：${e instanceof Error ? e.message : "エラー"}` },
      { status: 500 },
    );
  } finally {
    if (tmp) await fs.rm(tmp, { force: true }).catch(() => {});
  }
}
