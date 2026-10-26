import { defineConfig } from "vitest/config";

/** 测试配置：只跑 tests 根目录的用例，覆盖率面向 src。 */
export default defineConfig({
  test: {
    environment: "node",
    testTimeout: 30000,
    include: ["tests/**/*.test.ts"],
    coverage: {
      provider: "v8",
      include: ["src/bank/**", "src/core/**"],
      reporter: ["text", "json-summary"],
    },
  },
});
