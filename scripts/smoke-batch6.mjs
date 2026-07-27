// Batch6 C3（記録リマインダー）の API 実証。
// 実行: BASE=http://localhost:3007 CRON_KEY=test-cron-key node scripts/smoke-batch6.mjs
// 前提: 検証用の空DB＋同じ CRON_KEY で next start しておくこと。
const BASE = process.env.BASE ?? "http://localhost:3007";
const CRON_KEY = process.env.CRON_KEY ?? "test-cron-key";
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

console.log("== cronキーの保護 ==");
eq((await req("/api/push/reminder")).status, 403, "キー無しは403");
eq((await req("/api/push/reminder?key=wrong")).status, 403, "誤ったキーは403");

console.log("== 登録＋リマインダー設定 ==");
const email = `smoke6-${Date.now()}@example.com`;
eq(
  (await postJson("/api/auth", { action: "register", name: "スモーク6", email, password: "password123" }))
    .status,
  200,
  "アカウント登録",
);
eq((await json("/api/profile")).body.reminderHour, -1, "既定はOFF（-1）");
eq((await postJson("/api/profile", { reminderHour: 99 })).status, 400, "範囲外(99)は400");
eq((await postJson("/api/profile", { reminderHour: -2 })).status, 400, "範囲外(-2)は400");
eq((await postJson("/api/profile", { reminderHour: 21 })).status, 200, "21時に設定");
eq((await json("/api/profile")).body.reminderHour, 21, "設定が読める");

console.log("== 時刻が一致したときだけ対象になる ==");
eq((await json(`/api/push/reminder?key=${CRON_KEY}&hour=20`)).body.targets, 0, "20時では対象外");
eq((await json(`/api/push/reminder?key=${CRON_KEY}&hour=21`)).body.targets, 0, "通知未購読なら対象外");

console.log("== 購読ありで対象になる／記録済みならスキップ ==");
await postJson("/api/push", {
  endpoint: "https://example.invalid/push/smoke6",
  keys: { p256dh: "BExampleKeyForSmokeTestOnly000000000000000000000000000000000000000000000000000000000000000", auth: "c21va2UtdGVzdA" },
});
{
  const r = await json(`/api/push/reminder?key=${CRON_KEY}&hour=21`);
  eq(r.body.targets, 1, "21時に対象1人");
  eq(r.body.skippedRecorded, 0, "今日まだ記録なし → スキップされない");
}
{
  // 今日の支出を1件記録すると、リマインドの対象から外れる
  const today = new Date().toISOString().slice(0, 10);
  eq(
    (await postJson("/api/expenses", { date: today, amount: 500, memo: "リマインドテスト" })).status,
    200,
    "今日の支出を記録",
  );
  const r = await json(`/api/push/reminder?key=${CRON_KEY}&hour=21`);
  eq(r.body.targets, 1, "対象ユーザーには入る");
  eq(r.body.skippedRecorded, 1, "記録済みなので送信対象から外れる");
  eq(r.body.notified, 0, "送信は0（記録済みユーザーには送らない）");
}

console.log("== OFFに戻せる ==");
eq((await postJson("/api/profile", { reminderHour: -1 })).status, 200, "OFFに設定");
eq((await json(`/api/push/reminder?key=${CRON_KEY}&hour=21`)).body.targets, 0, "OFFなら対象外");

console.log(failed === 0 ? "\n✅ Batch6 C3 API実証: 全項目パス" : `\n❌ Batch6 C3 API実証: ${failed}件NG`);
process.exit(failed === 0 ? 0 : 1);
