import { defineConfig } from "vitest/config";
import { resolve } from "node:path";
const root = import.meta.dirname;

// Separate config: integration tests hit Solana devnet, so they need a long timeout
// and are never part of the default `npm test` run.
export default defineConfig({
  test: {
    include: ["tests/integration/**/*.test.ts"],
    setupFiles: ["tests/setup-env.ts"],
    testTimeout: 120_000,
    hookTimeout: 120_000,
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
