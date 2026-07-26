// iPhoneショートカット用のワンショットAPI：
// スクショを multipart で受け取り → AI読取 → そのまま支出として自動保存 → 結果メッセージを返す。
// 認証は Authorization: Bearer <api_token>（設定画面で表示・Shortcutsにコピペ）。
// ショートカット側はこの後「写真を削除」まで行う＝大翔の要望（読取→記録→スクショ削除）の実現手段。
import { promises as fs } from "fs";
import os from "os";
import path from "path";
import { askClaudeReceipt } from "@/lib/ai";
import { userFromBearer } from "@/lib/auth";
import { db, uid } from "@/lib/db";
import { fmtYen } from "@/lib/format";
import {
  DUPLICATE_SHORTCUT_MESSAGE,
  duplicateExpenseExists,
  duplicateIncomeExists,
  learnedCategoryId,
} from "@/lib/merchant";
import { todayStr } from "@/lib/money";

export const dynamic = "force-dynamic";
export const maxDuration = 180;

export async function POST(request: Request) {
  let tmp = "";
  try {
    // 注意: ok は boolean ではなく文字列 "true"/"false" で返す。
    // iOSショートカットのif文は JSON の boolean をテキスト "true" と比較すると一致しないため。
    const user = userFromBearer(request);
    if (!user) {
      return Response.json(
        { ok: "false", message: "認証エラー：設定画面のトークンをショートカットに設定してください。" },
        { status: 401 },
      );
    }
    const form = await request.formData();
    const file = form.get("image");
    if (!(file instanceof File)) {
      return Response.json({ ok: "false", message: "画像がありません。" }, { status: 400 });
    }
    const buf = Buffer.from(await file.arrayBuffer());
    const dir = path.join(os.tmpdir(), "cashsync-scan");
    await fs.mkdir(dir, { recursive: true });
    const ext = file.type.includes("png") ? "png" : "jpg";
    tmp = path.join(dir, `${globalThis.crypto.randomUUID()}.${ext}`);
    await fs.writeFile(tmp, buf);

    const d = db();
    const categories = d
      .prepare("SELECT id, name FROM categories WHERE user_id = ? ORDER BY sort")
      .all(user.id) as unknown as { id: string; name: string }[];
    const scan = await askClaudeReceipt(
      tmp,
      categories.map((c) => c.name),
    );
    if (!scan.total || scan.total <= 0) {
      return Response.json(
        { ok: "false", message: "金額を読み取れませんでした。写真を確認してください。" },
        { status: 422 },
      );
    }
    const date = scan.date || todayStr();

    // 受け取り画面（PayPay受け取り・給与振込等）は収入として記録
    if (scan.kind === "income") {
      const memo = scan.store || "スクショ収入";
      // 同じスクショを2回読ませた等の二重登録ガード。
      // ショートカットは対話できないので常にブロック（本当に2回ならアプリのスキャン画面から確認つきで記録できる）。
      if (duplicateIncomeExists(user.id, date, scan.total, memo)) {
        return Response.json(
          { ok: "false", message: DUPLICATE_SHORTCUT_MESSAGE },
          { status: 409 },
        );
      }
      d.prepare(
        "INSERT INTO incomes (id, user_id, date, amount, type, memo, created_at) VALUES (?, ?, ?, ?, 'other', ?, ?)",
      ).run(uid(), user.id, date, scan.total, memo, Date.now());
      return Response.json({
        ok: "true",
        message: `💰${fmtYen(scan.total)}（${scan.store || "受け取り"}）を収入として記録しました`,
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
      const l = learnedCategoryId(user.id, scan.store);
      if (l) {
        categoryId = l;
        categoryLabel = categories.find((c) => c.id === l)?.name ?? categoryLabel;
        learned = true;
      }
    }
    // 同じスクショを2回読ませた等の二重登録ガード。
    // ショートカットは対話できないので常にブロック（本当に2回ならアプリのスキャン画面から確認つきで記録できる）。
    if (duplicateExpenseExists(user.id, date, scan.total, scan.store)) {
      return Response.json(
        { ok: "false", message: DUPLICATE_SHORTCUT_MESSAGE },
        { status: 409 },
      );
    }
    const receiptId = uid();
    // レシートと支出は必ずセットで保存（片方だけ残る中途半端な状態を防ぐ）
    d.exec("BEGIN");
    try {
      d.prepare(
        "INSERT INTO receipts (id, user_id, store, taken_date, total, items_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      ).run(receiptId, user.id, scan.store, date, scan.total, JSON.stringify(scan.items), Date.now());
      d.prepare(
        "INSERT INTO expenses (id, user_id, date, amount, category_id, memo, source, receipt_id, created_at) VALUES (?, ?, ?, ?, ?, ?, 'receipt', ?, ?)",
      ).run(uid(), user.id, date, scan.total, categoryId, scan.store, receiptId, Date.now());
      d.exec("COMMIT");
    } catch (e) {
      d.exec("ROLLBACK");
      throw e;
    }

    return Response.json({
      ok: "true",
      message: `${fmtYen(scan.total)}（${scan.store || "店名不明"}／${categoryLabel}${learned ? "📌学習済み" : ""}）を記録しました`,
      store: scan.store,
      total: scan.total,
      category: learned ? categoryLabel : scan.category,
      date,
    });
  } catch (e) {
    console.error("[shortcut-scan] failed:", e); // server.logに残す（原因調査用）
    return Response.json(
      { ok: "false", message: `読み取りに失敗しました：${e instanceof Error ? e.message : "エラー"}` },
      { status: 500 },
    );
  } finally {
    if (tmp) await fs.rm(tmp, { force: true }).catch(() => {});
  }
}
