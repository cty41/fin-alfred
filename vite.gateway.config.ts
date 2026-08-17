import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: {
    host: "127.0.0.1",
    port: 1420,
    strictPort: true,
    proxy: {
      "/api": { target: "http://127.0.0.1:43117" },
      "/mcp": { target: "http://127.0.0.1:43117" },
      "/health": { target: "http://127.0.0.1:43117" },
    },
    watch: { ignored: ["**/target/**", "**/node_modules/**"] },
  },
});
