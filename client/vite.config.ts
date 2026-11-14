import { defineConfig } from 'vite';

const target = `http://localhost:${process.env.PORT ?? 8080}`;

export default defineConfig({
  // read VITE_* from the repo-root .env
  envDir: '..',
  server: {
    port: 5173,
    headers: { 'Cache-Control': 'no-store' },
    proxy: {
      '/api': target,
      '/data': target,
      '/ws': { target, ws: true },
    },
  },
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 2000,
  },
});
