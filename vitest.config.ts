import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    coverage: {
      provider: "v8",
      reporter: ["text", "text-summary", "html", "lcov"],
      include: [
        "apps/api/src/**/*.ts",
        "apps/bot/src/**/*.ts",
        "apps/email-worker/src/**/*.ts",
        "packages/*/src/**/*.ts"
      ],
      exclude: ["**/dist/**", "**/*.d.ts", "**/*.config.ts", "**/node_modules/**"]
    }
  }
});
