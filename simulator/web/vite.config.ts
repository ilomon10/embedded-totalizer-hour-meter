// vite.config.ts: the simulator's web UI (React + Tailwind), built into web/dist and
// served by `hour-meter-sim --web`. In development, `deno task web:dev` proxies the
// WebSocket to a simulator started with `deno task start --web 8080`.
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  root: import.meta.dirname,
  plugins: [react(), tailwindcss()],
  build: { outDir: 'dist', emptyOutDir: true },
  server: { proxy: { '/api': { target: 'ws://127.0.0.1:8080', ws: true } } },
});
