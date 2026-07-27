// C5: 読み取りのジョブ化（アプリを閉じても解析が続く）のAPI実証。
// 実行: BASE=http://localhost:3007 node scripts/smoke-scan-jobs.mjs
// AIの実読み取りを行うので1〜2分かかる。
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

async function req(p, init = {}) {
  const res = await fetch(`${BASE}${p}`, {
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

async function startJob(file) {
  const form = new FormData();
  const buf = fs.readFileSync(path.join(ROOT, ".data", file));
  form.set("image", new Blob([buf], { type: "image/png" }), file);
  const res = await req("/api/scan-jobs", { method: "POST", body: form });
  return { status: res.status, body: await res.json() };
}

console.log("== 認証 ==");
eq((await req("/api/scan-jobs")).status, 401, "未ログインは401");

console.log("== 準備 ==");
const email = `job-${Date.now()}@example.com`;
eq(
  (await postJson("/api/auth", { action: "register", name: "ジョブ", email, password: "password123" })).status,
  200,
  "アカウント登録",
);
eq((await json("/api/scan-jobs")).body.jobs.length, 0, "未確認ジョブは0件");

console.log("== ジョブ投入は即座に返る（＝待たされない） ==");
const t0 = Date.now();
const started = await startJob("t-6100-a.png");
const elapsed = Date.now() - t0;
eq(started.status, 200, "ジョブ開始のステータス");
eq(typeof started.body.jobId === "string" && started.body.jobId.length > 10, true, "jobIdが返る");
eq(elapsed < 8000, true, `投入は8秒未満で返る（実測${(elapsed / 1000).toFixed(1)}秒）`);

console.log("== サーバー側で解析が進み、完了する ==");
let job = null;
for (let i = 0; i < 60; i++) {
  await new Promise((r) => setTimeout(r, 2000));
  const r = await json(`/api/scan-jobs?id=${started.body.jobId}`);
  if (r.body.status !== "running") {
    job = r.body;
    break;
  }
}
eq(job?.status, "done", "ジョブが完了する");
eq(job?.scan?.total, 6100, "金額が読み取れている");
eq(typeof job?.imageHash === "string" && job.imageHash.length === 64, true, "画像ハッシュが付く");

console.log("== 未確認ジョブとして一覧に出る（閉じても迷子にならない） ==");
{
  const list = await json("/api/scan-jobs");
  eq(list.body.jobs.length, 1, "未確認ジョブ1件");
  eq(list.body.jobs[0].id, started.body.jobId, "同じジョブ");
}

console.log("== 同じ画像は解析せず即409（AIを無駄に使わない） ==");
{
  const today = new Date().toISOString().slice(0, 10);
  await postJson("/api/receipts", {
    store: job.scan.store,
    date: today,
    total: job.scan.total,
    categoryId: job.categoryId,
    items: [],
    imageHash: job.imageHash,
  });
  const dup = await startJob("t-6100-a.png");
  eq(dup.status, 409, "記録済みの画像は409");
  eq(dup.body.duplicate, true, "duplicateフラグ");
  eq(typeof dup.body.message === "string" && dup.body.message.includes("既に記録済み"), true, "理由が返る");
}

console.log("== 確認済みジョブは消せる ==");
{
  const del = await json(`/api/scan-jobs?id=${started.body.jobId}`, { method: "DELETE" });
  eq(del.status, 200, "削除のステータス");
  eq((await json("/api/scan-jobs")).body.jobs.length, 0, "一覧から消える");
}

console.log(failed === 0 ? "\n✅ 読み取りジョブ化: 全項目パス" : `\n❌ ${failed}件NG`);
process.exit(failed === 0 ? 0 : 1);
