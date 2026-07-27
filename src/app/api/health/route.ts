import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json({
    hasDatabaseUrl: !!process.env.DATABASE_URL,
    hasAnthropicKey: !!process.env.ANTHROPIC_API_KEY,
    // 通知まわりの設定漏れを一目で見分けるため（値そのものは出さない）
    hasApnsKey: !!process.env.APNS_KEY_BASE64,
    hasApnsKeyId: !!process.env.APNS_KEY_ID,
    hasApnsTeamId: !!process.env.APNS_TEAM_ID,
    hasVapid: !!process.env.VAPID_PUBLIC_KEY && !!process.env.VAPID_PRIVATE_KEY,
    hasCronSecret: !!process.env.CRON_SECRET,
    node: process.version,
    now: new Date().toISOString(),
  });
}
