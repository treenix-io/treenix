import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import tsconfigPaths from 'vite-tsconfig-paths';
import modsPlugin from './vite-plugin-mods';

const apiPort = process.env.VITE_API_PORT || '3211';

export default defineConfig({
  plugins: [
    modsPlugin(),
    tsconfigPaths(),
    tailwindcss(),
    react({ babel: { plugins: ['babel-plugin-react-compiler'] } }),
  ],
  root: 'src',
  publicDir: '../public',
  optimizeDeps: {
    include: [
      '@flowgram.ai/free-layout-editor',
      '@flowgram.ai/editor',
      '@flowgram.ai/core',
      '@flowgram.ai/renderer',
      '@flowgram.ai/document',
      '@flowgram.ai/materials-plugin',
      '@flowgram.ai/free-lines-plugin',
      '@flowgram.ai/free-layout-core',
      '@flowgram.ai/free-stack-plugin',
      '@flowgram.ai/free-hover-plugin',
      '@flowgram.ai/free-auto-layout-plugin',
      '@flowgram.ai/select-box-plugin',
      '@flowgram.ai/node',
      '@flowgram.ai/node-core-plugin',
      '@flowgram.ai/playground-react',
      'inversify',
      'reflect-metadata',
    ],
  },
  server: {
    port: 3210,
    host: '0.0.0.0',
    allowedHosts: ['*.trycloudflare.com', 'treenity.pro', '*.treenity.pro'],
    proxy: {
      '/trpc/': { target: `http://127.0.0.1:${apiPort}`, changeOrigin: true },
      '/api/': { target: `http://127.0.0.1:${apiPort}`, changeOrigin: true },
    },
  },
});
