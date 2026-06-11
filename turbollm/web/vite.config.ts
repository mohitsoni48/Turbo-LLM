import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// The daemon embeds the built assets (../internal/webui/dist) so it ships as one
// binary. In dev, `npm run dev` proxies API calls to the running daemon on :8080.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    proxy: {
      '/api': 'http://127.0.0.1:8080',
      '/healthz': 'http://127.0.0.1:8080',
      '/v1': 'http://127.0.0.1:8080',
    },
  },
  build: {
    outDir: '../src/webdist',
    emptyOutDir: false,
  },
})
