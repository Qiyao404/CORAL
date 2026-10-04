import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  // M4-3：产物直接输出到 server/public（coral CLI 单命令托管）
  build: { outDir: '../server/public', emptyOutDir: true },
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:3001',
        changeOrigin: true,
      },
      '/ws': {
        target: 'ws://localhost:3001',
        ws: true,
      },
    },
  },
});
