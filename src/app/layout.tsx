import type { Metadata, Viewport } from "next";
import { DotGothic16, Zen_Kaku_Gothic_New } from "next/font/google";
import "./globals.css";

// ドット印字（感熱紙のレシート印字）＝ブランドの署名フォント
const dotGothic = DotGothic16({
  weight: "400",
  subsets: ["latin"],
  preload: false,
  variable: "--font-dot-gothic",
});

const zenKaku = Zen_Kaku_Gothic_New({
  weight: ["400", "500", "700"],
  subsets: ["latin"],
  preload: false,
  variable: "--font-zen",
});

export const metadata: Metadata = {
  title: "CashSync",
  description: "レシートを撮るだけ、入力3秒の家計簿",
  manifest: "/manifest.webmanifest",
  appleWebApp: { capable: true, statusBarStyle: "default", title: "CashSync" },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  themeColor: "#ece7dd",
  // これが無いと env(safe-area-inset-*) が常に0になり、ノッチ／ステータスバーの下に
  // コンテンツが潜り込んで一番上の要素がタップできなくなる（2026-07-27 大翔の実機報告）
  viewportFit: "cover",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="ja" className={`${dotGothic.variable} ${zenKaku.variable} h-full antialiased`}>
      <body className="min-h-full paper-texture">{children}</body>
    </html>
  );
}
