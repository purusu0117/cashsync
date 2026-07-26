import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "CashSync",
    short_name: "CashSync",
    description: "レシートを撮るだけ、入力3秒の家計簿",
    start_url: "/",
    display: "standalone",
    background_color: "#ece7dd",
    theme_color: "#ece7dd",
    icons: [
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png" },
    ],
    shortcuts: [
      {
        name: "レシートを撮る",
        url: "/scan",
        icons: [{ src: "/icons/icon-192.png", sizes: "192x192" }],
      },
      { name: "手入力", url: "/add" },
    ],
  };
}
