import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { resolve } from 'node:path';

export default defineConfig({
  envDir: false,
  cacheDir: resolve(import.meta.dirname, '../../temp/editor-vite-cache'),
  resolve: { conditions: ['development'], dedupe: ['react', 'react-dom'] },
  plugins: [
    {
      name: 'technical-mods',
      resolveId(id) {
        if (id === 'virtual:mod-clients') return '\0technical-mod-clients';
      },
      load(id) {
        if (id === '\0technical-mod-clients') return 'export {}';
      },
    },
    react(),
    tailwindcss(),
  ],
  build: {
    rollupOptions: { input: ['technical-editor.html'] },
    emptyOutDir: false,
    outDir: '../../temp/technical-editor-dist-1791653206819593000',
  },
});
