import { defineConfig } from "vitest/config";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@fin-alfred/core": path.join(root, "packages/core/src/index.ts"),
      "@fin-alfred/provider-akshare": path.join(root, "packages/provider-akshare/src/index.ts"),
      "@fin-alfred/gateway": path.join(root, "packages/gateway/src/server.ts"),
    },
  },
  test: { include: ["packages/*/test/**/*.test.ts"] },
});
