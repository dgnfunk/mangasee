import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";
export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: "prompt",
      injectRegister: "auto",
      manifest: {
        name: "MangaSee",
        short_name: "MangaSee",
        description: "Your personal manga reading room",
        start_url: "/",
        scope: "/",
        display: "standalone",
        background_color: "#141916",
        theme_color: "#141916",
        icons: [
          { src: "/icon-192.png", sizes: "192x192", type: "image/png" },
          {
            src: "/icon-512.png",
            sizes: "512x512",
            type: "image/png",
            purpose: "any maskable",
          },
        ],
      },
      workbox: {
        globPatterns: ["**/*.{js,css,html,png,svg,woff2}"],
        navigateFallback: "/index.html",
        navigateFallbackDenylist: [/^\/api/],
        importScripts: ["/offline-worker.js"],
        maximumFileSizeToCacheInBytes: 4000000,
      },
    }),
  ],
  server: { proxy: { "/api": "http://127.0.0.1:3000" } },
  build: { chunkSizeWarningLimit: 1000 },
});
