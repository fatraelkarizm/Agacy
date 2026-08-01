import { defineConfig } from "vitest/config";
import { resolve } from "node:path";
const root = import.meta.dirname;

export default defineConfig({
  test: {
    // Integration tests hit devnet and are slow; run them explicitly via `npm run test:integration`.
    exclude: ["tests/integration/**", "node_modules/**"],
    testTimeout: 10_000,
  },
  resolve: {
    alias: {
      "@dto": resolve(root, "server/dto"),
      "@data": resolve(root, "server/data"),
      "@services": resolve(root, "server/services"),
      "@agent": resolve(root, "agent"),
    },
  },
});
