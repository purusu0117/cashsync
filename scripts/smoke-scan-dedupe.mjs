// スクショ一括取り込みの修正検証（2026-07-27・大翔の報告「同額2枚が無言で消えた」対応）。
// 実行: BASE=http://localhost:3007 node scripts/smoke-scan-dedupe.mjs
// 前提: 検証用の空DBで next start しておく。AIの読み取りを実際に走らせるので数分かかる。
//  - 同じ金額・同じ店の【別の画像】は2件とも記録される（以前は2枚目が409で無言で消えていた）
//  - まったく同じ画像を再送したときだけ409。メッセージに既存記録の内容が入る
//  - 記録できたら通知のON/OFFが保存できる
import fs from "node:fs";
import path from "node:path";

const BASE = process.env.BASE ?? "http://localhost:3007";
const ROOT = process.cwd();
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
  for (const c of res.headers.getSetCookie?.() ?? []) {
    if (c.startsWith("cashsync_session=") && !c.startsWith("cashsync_session=;")) {
      cookie = c.split(";")[0];
    }
  }
  return res;
}
const json = async (p, init) => {
  const res = await req(p, init);
  const text = await res.text();
  try {
    return { status: res.status, body: JSON.parse(text) };
  } catch {
    return { status: res.status, body: text };
  }
};
const postJson = (p, data) =>
  json(p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(data) });

/** ショートカット経由のスキャン（Bearerトークン・AI読取→自動保存） */
async function shortcutScan(token, file) {
  const form = new FormData();
  const buf = fs.readFileSync(path.join(ROOT, ".data", file));
  form.set("image", new Blob([buf], { type: "image/png" }), file);
  const res = await fetch(`${BASE}/api/shortcut-scan`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
    body: form,
  });
  return { status: res.status, body: await res.json() };
}

console.log("== 準備：登録＋トークン取得 ==");
const email = `dedupe-${Date.now()}@example.com`;
eq(
  (await postJson("/api/auth", { action: "register", name: "重複テスト", email, password: "password123" }))
    .status,
  200,
  "アカウント登録",
);
const profile = await json("/api/profile");
const token = profile.body.apiToken;
eq(typeof token === "string" && token.length > 10, true, "APIトークン取得");
eq(profile.body.recordPush, true, "「記録できたら通知」は既定ON");

console.log("== 同じ金額・同じ店の【別の画像】は2件とも記録される ==");
const a = await shortcutScan(token, "t-6100-a.png");
eq(a.status, 200, "1枚目 ¥6,100 のステータス");
eq(a.body.ok, "true", "1枚目 ok");
eq(a.body.total, 6100, "1枚目の金額");
const b = await shortcutScan(token, "t-6100-b.png");
eq(b.status, 200, "2枚目 ¥6,100（別画像）のステータス ← 以前は409で無言で消えていた");
eq(b.body.ok, "true", "2枚目 ok");
eq(b.body.total, 6100, "2枚目の金額");
const c = await shortcutScan(token, "t-3680.png");
eq(c.status, 200, "3枚目 ¥3,680 のステータス");
eq(c.body.ok, "true", "3枚目 ok");

console.log("== 同じ画像の再送だけは弾く（理由つきメッセージ） ==");
const again = await shortcutScan(token, "t-6100-a.png");
eq(again.status, 409, "同一画像の再送は409");
eq(again.body.ok, "false", "ok=false（ショートカットは写真を消さない）");
eq(typeof again.body.message === "string" && again.body.message.includes("既に記録済み"), true, "理由がメッセージに入る");
eq(again.body.message.includes("6,100"), true, "既存記録の金額がメッセージに入る");

console.log("== 記録件数の確認 ==");
{
  const today = new Date().toISOString().slice(0, 10);
  const r = await json(`/api/expenses?month=${today.slice(0, 7)}`);
  const scanned = r.body.expenses.filter((e) => e.source === "receipt");
  eq(scanned.length, 3, "3枚ぶん記録されている（6100×2・3680×1）");
  eq(
    scanned.filter((e) => e.amount === 6100).length,
    2,
    "同額の別の支払いが2件とも残っている",
  );
}

console.log("== 「記録できたら通知」のON/OFF ==");
eq((await postJson("/api/profile", { recordPush: false })).status, 200, "OFFにする");
eq((await json("/api/profile")).body.recordPush, false, "OFFが保存される");
eq((await postJson("/api/profile", { recordPush: true })).status, 200, "ONに戻す");
eq((await json("/api/profile")).body.recordPush, true, "ONが保存される");

console.log(failed === 0 ? "\n✅ スクショ重複判定の修正: 全項目パス" : `\n❌ ${failed}件NG`);
process.exit(failed === 0 ? 0 : 1);
