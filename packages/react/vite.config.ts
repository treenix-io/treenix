// import tailwindcss from '@tailwindcss/vite'; // disabled — using CDN in index.html
import react from '@vitejs/plugin-react';
import { readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig } from 'vite';
import treenixPlugin from './src/vite-plugin-treenix';

const projectRoot = process.env.INIT_CWD || process.cwd();
const apiPort = process.env.VITE_API_PORT || '3211';

export default defineConfig({
  resolve: {
    conditions: ['development'],
    dedupe: ['react', 'react-dom'],
  },
  plugins: [
    treenixPlugin({ modsDirs: [resolve(projectRoot, 'mods')] }),
    // tailwindcss(), // disabled — using CDN in index.html
    react({ babel: { plugins: ['babel-plugin-react-compiler'] } }),
  ],
  publicDir: 'public',
  optimizeDeps: {
    include: [
      ...readdirSync(resolve(projectRoot, 'node_modules/@flowgram.ai')).map(d => `@flowgram.ai/${d}`),
      'inversify',
      'reflect-metadata',
    ],
  },
  server: {
    port: 3210,
    host: '0.0.0.0',
    allowedHosts: ['treenix.pro', 'frp.treenix.pro', 'dev.treenix.pro'],
    proxy: {
      '/trpc/': { target: `http://127.0.0.1:${apiPort}`, changeOrigin: true },
      '/api/': { target: `http://127.0.0.1:${apiPort}`, changeOrigin: true },
    },
  },
});
