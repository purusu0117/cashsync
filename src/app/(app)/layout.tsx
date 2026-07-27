import { redirect } from "next/navigation";
import AppLock from "@/components/AppLock";
import BottomNav from "@/components/BottomNav";
import { currentUser } from "@/lib/auth";

export const dynamic = "force-dynamic";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const user = await currentUser();
  if (!user) redirect("/login");
  return (
    <div className="mx-auto max-w-md min-h-dvh px-4 pt-4 pb-24">
      {children}
      <BottomNav />
      {/* B8: アプリロック（設定でONにした端末のみ。起動時・復帰時に全画面で覆う） */}
      <AppLock />
    </div>
  );
}
