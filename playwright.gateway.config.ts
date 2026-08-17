import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./src/test/gateway-e2e",
  timeout: 90_000,
  use: { baseURL: "http://127.0.0.1:1420" },
  webServer: {
    command: "node scripts/gateway-dev.mjs",
    url: "http://127.0.0.1:43117/health",
    reuseExistingServer: false,
    timeout: 600_000,
    env: {
      ...process.env,
      FIN_ALFRED_BOOTSTRAP_TOKEN: "gateway-e2e-bootstrap",
      FIN_ALFRED_NO_OPEN: "1",
      FIN_ALFRED_TEST_DATA_DIR: "target/gateway-e2e-data",
    },
  },
});
