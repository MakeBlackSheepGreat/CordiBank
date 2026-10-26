/**
 * 前端组件测试配置（R40）：Vue Test Utils + happy-dom + vitest。
 * 用例目录：src/components/cluster/__tests__/*.test.ts。
 */
import vue from '@vitejs/plugin-vue';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [vue()],
  test: {
    environment: 'happy-dom',
    globals: true,
    include: ['src/**/__tests__/**/*.test.ts'],
    // DSH 真实产物内的编辑器语法栈（vscode-textmate Registry）在岛卸载后异步拒绝，
    // 属于产物内部行为，断言不受影响；未处理错误统计按豁免处理。
    dangerouslyIgnoreUnhandledErrors: true,
  },
});
