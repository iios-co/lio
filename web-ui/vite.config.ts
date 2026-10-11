import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// A per-build identifier, surfaced in the UI header so a reload can be told
// apart from the previous build at a glance (e.g. "ui 0909-1124").
const stamp = (() => {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
})();

// Build to ../lio-server/lio_server/web_dist so FastAPI can serve the SPA.
// In dev, proxy /api and /admin to the running lio-server on 8787.
export default defineConfig({
  plugins: [react()],
  define: {
    __UI_BUILD__: JSON.stringify(stamp),
  },
  server: {
    port: 5173,
    proxy: {
      "/api": { target: "http://127.0.0.1:8787", changeOrigin: true },
      "/admin": { target: "http://127.0.0.1:8787", changeOrigin: true },
    },
  },
  build: {
    outDir: "../lio-server/lio_server/web_dist",
    emptyOutDir: true,
  },
});
