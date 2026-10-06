import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// 개발 모드: Vite(5173)가 화면을, Node 서버(PORT, 기본 3000)가 WebSocket을 맡는다.
// 프로덕션: Node 서버 하나가 dist/와 WebSocket을 모두 제공한다.
export default defineConfig({
  root: 'client',
  plugins: [react()],
  build: {
    outDir: '../dist',
    emptyOutDir: true,
  },
  server: {
    fs: { allow: ['..'] },
    proxy: {
      '/ws': { target: `ws://localhost:${process.env.PORT ?? 3000}`, ws: true },
    },
  },
});
