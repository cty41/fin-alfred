import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./src/test/e2e",
  timeout: 60_000,
  use: { baseURL: "http://127.0.0.1:1420" },
  webServer: { command: "pnpm dev", url: "http://127.0.0.1:1420", reuseExistingServer: true, timeout: 120_000 }
});
