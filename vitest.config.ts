import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    include: ["tests/**/*.test.ts"],
    // With HARBOR_PG_URL every integration file truncates and reseeds the same database, so the
    // files must not run in parallel against it.
    fileParallelism: !process.env.HARBOR_PG_URL,
  },
});
