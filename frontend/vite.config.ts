import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// In production the built SPA is served by the FastAPI backend (same origin),
// so /api/* needs no proxy. In dev, Vite proxies /api/* to the FastAPI backend
// (uvicorn on :8000) so the browser sees a single origin (no CORS).
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: "http://127.0.0.1:8000",
        changeOrigin: true,
        configure: (proxy) => {
          proxy.on("proxyReq", (proxyReq) => proxyReq.setHeader("connection", "keep-alive"));
        },
      },
    },
  },
});
