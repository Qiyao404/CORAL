import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // 默认 **/*.test.{ts,tsx} 之外，纳入 skills/_lib 的 .mjs 协议/抽取库测试
    include: ['src/**/*.test.ts', '../../skills/_lib/*.test.mjs'],
    environment: 'node',
  },
});
