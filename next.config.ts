import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // pg はネイティブ依存（pg-native）の条件requireを含むためバンドルせずNode解決に任せる
  // （sharp は Next のデフォルト外部化リストに含まれる）
  serverExternalPackages: ["pg"],
};

export default nextConfig;
