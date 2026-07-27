// Batch5 の API 実証（起動中のサーバーに実際にHTTPで叩いて確認する）。
// 実行: BASE=http://localhost:3007 node scripts/smoke-batch5.mjs
// 前提: 検証用の空DBで next start しておく（CASHSYNC_DB_PATH=.data/smoke-batch5.db）。
const BASE = process.env.BASE ?? "http://localhost:3007";
let cookie = "";
let failed = 0;

function eq(actual, expected, label) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a === b) console.log(`  ok  ${label} = ${a}`);
  else {
    failed++;
    console.error(`  NG  ${label}: got ${a}, want ${b}`);
  }
}

async function req(path, init = {}) {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { ...(init.headers ?? {}), ...(cookie ? { cookie } : {}) },
    redirect: "manual",
  });
  const setCookie = res.headers.getSetCookie?.() ?? [];
  for (const c of setCookie) if (c.startsWith("cashsync_session=") && !c.startsWith("cashsync_session=;")) cookie = c.split(";")[0];
  return res;
}
const json = async (path, init) => {
  const res = await req(path, init);
  const text = await res.text();
  try {
    return { status: res.status, body: JSON.parse(text) };
  } catch {
    return { status: res.status, body: text };
  }
};
const postJson = (path, data) =>
  json(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(data),
  });

// ---------------------------------------------------------------------------
console.log("== 未ログインは401 ==");
eq((await req("/api/export")).status, 401, "GET /api/export（未ログイン）");
eq((await req("/api/expenses?search=1&q=x")).status, 401, "GET /api/expenses?search=1（未ログイン）");
eq((await req("/api/import", { method: "POST" })).status, 401, "POST /api/import（未ログイン）");
eq((await req("/api/import/commit", { method: "POST" })).status, 401, "POST /api/import/commit（未ログイン）");

console.log("== 登録 ==");
const email = `smoke-${Date.now()}@example.com`;
{
  const r = await postJson("/api/auth", {
    action: "register",
    name: "スモーク",
    email,
    password: "password123",
  });
  eq(r.status, 200, "アカウント登録");
  eq(Boolean(cookie), true, "セッションクッキー取得");
}

console.log("== C2: CSVインポート（プレビュー→確定） ==");
const csv = [
  "計算対象,日付,内容,金額（円）,保有金融機関,大項目,中項目,メモ,振替,ID",
  "1,2026/06/01,ローソン,-540,現金,食費,食料品,,0,a1",
  "1,2026/06/02,バイト代,30000,銀行,収入,給与,,0,a2",
  "1,2026/06/03,西友,-1280,現金,食費,食料品,,0,a3",
  "0,2026/06/04,対象外,-100,現金,食費,,,0,a4",
  "1,2026/06/05,口座間移動,-20000,銀行,振替,,,1,a5",
  "1,2026/06/06,ユニクロ,-3900,カード,衣服,,,0,a6",
].join("\n");
let previewRows = [];
{
  const form = new FormData();
  form.set("file", new Blob([csv], { type: "text/csv" }), "mf.csv");
  const r = await json("/api/import", { method: "POST", body: form });
  eq(r.status, 200, "POST /api/import ステータス");
  eq(r.body.format, "moneyforward", "形式の自動判定");
  eq(r.body.rows.length, 4, "プレビュー行数（計算対象0・振替はスキップ）");
  eq(r.body.skipped, 2, "スキップ数");
  eq(r.body.rows[0].memo, "ローソン", "メモ");
  eq(Boolean(r.body.rows[0].categoryId), true, "カテゴリが自動解決される（食費）");
  eq(Boolean(r.body.rows.find((x) => x.memo === "ユニクロ").categoryId), true, "衣服→洋服も解決される");
  previewRows = r.body.rows;
}
{
  const r = await postJson("/api/import/commit", { rows: previewRows });
  eq(r.status, 200, "POST /api/import/commit ステータス");
  eq(r.body.expenses, 3, "取り込んだ支出件数");
  eq(r.body.incomes, 1, "取り込んだ収入件数");
}
{
  const r = await json("/api/expenses?month=2026-06");
  eq(r.status, 200, "取り込んだ月の支出が読める");
  eq(r.body.expenses.length, 3, "6月の支出3件");
  eq(r.body.expenses.every((e) => e.source === "import"), true, "source=import で記録されている");
}
{
  // 不正な行は弾き、正常な行だけ入る（1トランザクション）
  const r = await postJson("/api/import/commit", {
    rows: [
      { date: "2026-06-10", kind: "expense", amount: 100, memo: "正常" },
      { date: "bad-date", kind: "expense", amount: 100, memo: "日付不正" },
      { date: "2026-06-11", kind: "expense", amount: -5, memo: "金額不正" },
    ],
  });
  eq(r.body.expenses, 1, "不正行を除いて登録");
  eq(r.body.invalid, 2, "不正行数を返す");
  eq((await postJson("/api/import/commit", { rows: [] })).status, 400, "空配列は400");
}

console.log("== B11: 検索API ==");
{
  const r = await json("/api/expenses?search=1&q=ローソン");
  eq(r.status, 200, "GET /api/expenses?search=1 ステータス");
  eq(r.body.total, 1, "「ローソン」1件");
  eq(r.body.expenses[0].amount, 540, "金額");
  eq((await json("/api/expenses?search=1&q=")).body.total, 4, "空クエリは全件（4件）");
  eq((await json("/api/expenses?search=1&min=1000")).body.total, 2, "金額下限で絞り込み");
  eq((await json("/api/expenses?search=1&min=1000&max=2000")).body.total, 1, "金額範囲");
  const paged = await json("/api/expenses?search=1&limit=2&offset=0");
  eq(paged.body.expenses.length, 2, "limitが効く");
  eq(paged.body.total, 4, "totalは全件");
}

console.log("== B10: エクスポートAPI ==");
{
  const res = await req("/api/export");
  // fetch の text() は仕様上BOMを取り除くので、BOMの有無はバイト列で確認する
  const bytes = new Uint8Array(await res.arrayBuffer());
  const text = new TextDecoder("utf-8", { ignoreBOM: true }).decode(bytes);
  eq(res.status, 200, "GET /api/export ステータス");
  eq([bytes[0], bytes[1], bytes[2]], [0xef, 0xbb, 0xbf], "先頭がUTF-8 BOM（Excelで文字化けしない）");
  eq(res.headers.get("content-type"), "text/csv; charset=utf-8", "Content-Type");
  eq(/attachment; filename="cashsync-\d{8}\.csv"/.test(res.headers.get("content-disposition") ?? ""), true, "ダウンロード用ヘッダ");
  eq(text.startsWith("﻿日付,種別,金額,カテゴリ,メモ,入力方法"), true, "BOM＋ヘッダ");
  eq(text.trimEnd().split("\r\n").length, 6, "行数＝ヘッダ1＋支出4＋収入1");
  eq(text.includes("ローソン"), true, "取り込んだ明細が含まれる");
  const period = await (await req("/api/export?start=2026-06-01&end=2026-06-02")).text();
  eq(period.trimEnd().split("\r\n").length, 3, "期間指定で絞り込める（ヘッダ＋2件）");
}

console.log("== C13: 袋分け予算の繰り越しAPI ==");
{
  const cats = (await json("/api/categories")).body.categories;
  const food = cats.find((c) => c.name === "食費");
  eq((await postJson("/api/budgets", { categoryId: food.id, amount: 5000, carryover: true })).status, 200, "予算を繰り越しONで保存");
  const r = await json("/api/budgets");
  const p = r.body.pockets.find((x) => x.id === food.id);
  eq(p.budget, 5000, "予算が保存されている");
  eq(p.carryover, 1, "繰り越しフラグON");
  eq(typeof p.carryoverAmount, "number", "繰り越し額が返る");
  await postJson("/api/budgets", { categoryId: food.id, amount: 5000, carryover: false });
  eq((await json("/api/budgets")).body.pockets.find((x) => x.id === food.id).carryover, 0, "繰り越しOFFに戻せる");
}

console.log("== C12: 固定費/変動費の切り替えAPI ==");
{
  const add = await postJson("/api/recurring", {
    kind: "expense",
    name: "テスト家賃",
    amount: 50000,
    startMonth: "2026-07",
    postDay: 1,
  });
  eq(add.status, 200, "定期支出の追加");
  const list = await json("/api/recurring");
  const item = list.body.items.find((x) => x.name === "テスト家賃");
  eq(item.is_fixed, 1, "既定は固定費（is_fixed=1）");
  const put = await json("/api/recurring", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id: item.id, isFixed: false }),
  });
  eq(put.status, 200, "PUT で変動費に切り替え");
  eq((await json("/api/recurring")).body.items.find((x) => x.id === item.id).is_fixed, 0, "変動費になった");
  const bad = await json("/api/recurring", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id: item.id }),
  });
  eq(bad.status, 400, "isFixed 無しは400");
}

console.log("== C14: 年間ビュー（stats months=12） ==");
{
  const r = await json("/api/stats?months=12&before=2026-12");
  eq(r.status, 200, "GET /api/stats?months=12 ステータス");
  eq(r.body.series.length, 12, "12ヶ月分の系列");
  eq(r.body.series[0].month, "2026-01", "先頭は1月");
  eq(r.body.series[11].month, "2026-12", "末尾は12月");
  eq(r.body.series.find((s) => s.month === "2026-06").expense > 0, true, "6月に取り込んだ支出が反映される");
  eq((await json("/api/stats?months=999")).body.series.length, 24, "months は24ヶ月で頭打ち");
  eq(typeof r.body.breakdown, "object", "カテゴリ内訳も返る");
}

console.log("== C15: 未来月の予定（履歴が使う plan） ==");
{
  const r = await json("/api/calendar?month=2026-09");
  eq(r.status, 200, "GET /api/calendar（未来月）");
  eq(Array.isArray(r.body.plan?.expenses ?? r.body.plan?.items ?? []), true, "予定データが返る");
  eq(Boolean(r.body.plan), true, "plan が含まれる");
}

console.log(failed === 0 ? "\n✅ Batch5 API実証: 全項目パス" : `\n❌ Batch5 API実証: ${failed}件NG`);
process.exit(failed === 0 ? 0 : 1);
