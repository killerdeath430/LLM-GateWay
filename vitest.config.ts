import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
    // Tests never call real providers (decision D11). Live smoke tests will live in
    // tests/live/ and only run when LIVE_TESTS=1 is set.
    exclude: ["tests/live/**", "node_modules/**"],
  },
});
