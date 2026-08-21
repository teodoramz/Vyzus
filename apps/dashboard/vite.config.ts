import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Dev server proxies /api and /ws to the API (see infra/nginx.conf for the
// production equivalent). The dashboard itself only ever uses relative URLs.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:3000',
        changeOrigin: true,
      },
      '/ws': {
        target: 'ws://localhost:3000',
        ws: true,
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
    // Vite otherwise inlines a small modulepreload polyfill into index.html.
    // That single inline <script> is the only thing standing between this app
    // and a `script-src 'self'` CSP (infra/nginx-common.conf), and the polyfill
    // only serves browsers too old to run the ES modules the build emits
    // anyway. Dropping it buys a real CSP for nothing.
    modulePreload: { polyfill: false },
  },
});
