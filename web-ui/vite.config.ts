import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Build to ../lio-server/lio_server/web_dist so FastAPI can serve the SPA.
// In dev, proxy /api and /admin to the running lio-server on 8787.
export default defineConfig({
  plugins: [react()],
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
