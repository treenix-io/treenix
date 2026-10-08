import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import { defineConfig } from 'vite'

export default defineConfig({
  envDir: false,
  cacheDir: resolve(import.meta.dirname, '../../../temp/native-vite', randomUUID()),
  resolve: { conditions: ['development'], dedupe: ['react', 'react-dom'] },
  plugins: [tailwindcss(), react()],
  build: { rollupOptions: { input: 'native.html' }, outDir: 'dist-native', emptyOutDir: false },
  server: { host: '127.0.0.1', port: 4881, strictPort: true, proxy: {
    '/auth/': 'http://127.0.0.1:4882', '/twp': 'http://127.0.0.1:4882',
  } },
})
