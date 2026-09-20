import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Build/ingest e2e tests spawn DuckDB children and Docker-side work;
    // 5s default is too tight under full-suite parallelism.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
