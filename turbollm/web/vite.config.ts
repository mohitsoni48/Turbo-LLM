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
    rollupOptions: {
      output: {
        manualChunks: {
          // Core React runtime — cached separately from app logic.
          vendor: ['react', 'react-dom', 'react-router-dom'],
          // Radix UI primitives — large but stable; cache-friendly.
          radix: [
            '@radix-ui/react-alert-dialog',
            '@radix-ui/react-collapsible',
            '@radix-ui/react-dialog',
            '@radix-ui/react-dropdown-menu',
            '@radix-ui/react-popover',
            '@radix-ui/react-scroll-area',
            '@radix-ui/react-separator',
            '@radix-ui/react-slot',
            '@radix-ui/react-switch',
            '@radix-ui/react-tabs',
            '@radix-ui/react-tooltip',
          ],
        },
      },
    },
  },
})
