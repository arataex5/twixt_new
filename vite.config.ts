import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";
import pkg from "./package.json" with { type: "json" };

// GitHub Pages: https://arataex5.github.io/twixt_new/  → base "/twixt_new/"
// Capacitor(APK) 用ビルド: CAP_BUILD=1 で相対パス "./"
const isCap = !!process.env.CAP_BUILD;

export default defineConfig({
  base: isCap ? "./" : "/twixt_new/",
  define: { __APP_VERSION__: JSON.stringify(pkg.version) },
  plugins: [
    react(),
    VitePWA({
      registerType: "autoUpdate",
      disable: isCap, // APK では Service Worker 不要(assets 同梱)
      includeAssets: ["icon-192.png", "icon-512.png"],
      manifest: {
        name: "TWIXT",
        short_name: "TWIXT",
        description: "TWIXT 対戦アプリ",
        display: "standalone",
        orientation: "portrait",
        theme_color: "#1e1e1e",
        background_color: "#17181c",
        lang: "ja",
        icons: [
          { src: "icon-192.png", sizes: "192x192", type: "image/png" },
          { src: "icon-512.png", sizes: "512x512", type: "image/png", purpose: "any maskable" },
        ],
      },
      workbox: {
        globPatterns: ["**/*.{js,css,html,png,svg,wasm,onnx}"],
        maximumFileSizeToCacheInBytes: 50 * 1024 * 1024,
      },
    }),
  ],
  // onnxruntime-web: wasm を bundle に含めず public/ort/ のものを使う
  resolve: { conditions: ["onnxruntime-web-use-extern-wasm"] },
  worker: { format: "es" },
  build: { target: "es2022", chunkSizeWarningLimit: 2000 },
});
