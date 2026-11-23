import { defineConfig } from 'vitest/config';

// 前端单元测试（纯逻辑：事件窗口 / 事件归并等）。独立的 vitest 配置 —
// 不复用 vite.config.ts（那是构建配置，会把产物写到 server/public）。
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.{ts,tsx}'],
  },
});
