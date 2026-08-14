import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// In production the built SPA is served by the FastAPI backend (same origin),
// so /api/* needs no proxy. In dev, Vite proxies /api/* to the FastAPI backend
// (uvicorn on :8000) so the browser sees a single origin (no CORS).
// Set AUDIOCPP_API to point the dev server at an already-running Studio backend
// instead (e.g. http://127.0.0.1:8110, the port in the committed config.toml).
const target = process.env.AUDIOCPP_API ?? "http://127.0.0.1:8000";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target,
        changeOrigin: true,
        configure: (proxy) => {
          proxy.on("proxyReq", (proxyReq) => proxyReq.setHeader("connection", "keep-alive"));
        },
      },
    },
  },
});
