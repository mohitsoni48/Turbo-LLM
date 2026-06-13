import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// The daemon embeds the built assets (../internal/webui/dist) so it ships as one
// binary. In dev, `npm run dev` proxies API calls to the running daemon on :8080.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    proxy: {
      '/api': 'http://127.0.0.1:6996',
      '/healthz': 'http://127.0.0.1:6996',
      '/v1': 'http://127.0.0.1:6996',
    },
  },
  build: {
    outDir: '../src/webdist',
    // Wipe the output dir on each build. webdist is purely generated (served by
    // the daemon and copied into dist/ at package build) — without this, vite
    // leaves stale hashed chunks behind every build, bloating the npm package.
    emptyOutDir: true,
  },
})
