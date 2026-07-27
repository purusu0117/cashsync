// シフトタブは廃止し、機能はカレンダータブに統合済み。
// 旧URL・ブックマークからの流入はカレンダーへ寄せる（サーバー側で 307 リダイレクト）。
import { redirect } from "next/navigation";

export default function ShiftsPage() {
  redirect("/calendar");
}
