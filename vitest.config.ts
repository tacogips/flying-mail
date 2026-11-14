import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: [
      "packages/*/src/**/*.test.ts",
      "apps/api/src/**/*.test.ts",
      "apps/cli/src/**/*.test.ts",
    ],
    exclude: ["**/node_modules/**", "**/dist/**"],
  },
});
