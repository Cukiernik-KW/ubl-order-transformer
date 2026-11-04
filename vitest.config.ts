import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      // Process entrypoint (wiring, signals, listen): verified by running the container, not unit tests.
      exclude: ["src/server.ts"],
      reporter: ["text", "html"],
      // CI fails if coverage drops. 90%, not 100%: wiring isn't worth chasing.
      thresholds: { lines: 90, branches: 90, functions: 90, statements: 90 },
    },
  },
});
