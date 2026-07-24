import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/core/compare/**/*.test.ts"],
  },
});
