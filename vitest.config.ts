import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    // Tests touch real temp directories and one loopback HTTP server; keeping
    // files in a single fork avoids surprising cross-file port contention.
    pool: "forks",
    maxWorkers: 1,
  },
});
