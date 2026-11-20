import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    coverage: {
      include: ["src/**/*.ts"],
      reporter: ["text"],
      thresholds: { 100: true, perFile: true },
    },
  },
});
