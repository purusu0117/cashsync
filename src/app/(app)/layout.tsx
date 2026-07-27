import { redirect } from "next/navigation";
import AppLock from "@/components/AppLock";
import BottomNav from "@/components/BottomNav";
import NativeAds from "@/components/NativeAds";
import NativePurchases from "@/components/NativePurchases";
import { getUserPlan } from "@/lib/aiUsage";
import { currentUser } from "@/lib/auth";

export const dynamic = "force-dynamic";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const user = await currentUser();
  if (!user) redirect("/login");
  const plan = await getUserPlan(user.id);
  return (
    <div className="mx-auto max-w-md min-h-dvh px-4 pt-4 pb-24">
      {/* ネイティブアプリ＋freeプランのときだけ上部AdMobバナー（Webでは何もしない） */}
      <NativeAds plan={plan} />
      {/* ネイティブアプリ＋RevenueCatキー設定済みのときだけ課金SDKを初期化（Webでは何もしない） */}
      <NativePurchases userId={user.id} />
      {children}
      <BottomNav />
      {/* B8: アプリロック（設定でONにした端末のみ。起動時・復帰時に全画面で覆う） */}
      <AppLock />
    </div>
  );
}
