/// <reference types="vitest/config" />
import { sentryVitePlugin } from '@sentry/vite-plugin';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

// With a Sentry token (CI only), source maps are uploaded to Sentry's erp-web project and deleted from dist (D-086).
const sentryToken = process.env['SENTRY_AUTH_TOKEN'];
// The API on the same origin, as behind the edge proxy (D-065); locally and in E2E it runs on its own port.
// The Host header is kept, as Caddy keeps it: the API checks Origin against it (CSRF defence).
const api = { '/api': { target: process.env['API_URL'] ?? 'http://127.0.0.1:3000', changeOrigin: false } };

export default defineConfig({
  plugins: [
    react(),
    // The app shell works offline (POS spec §8). 'prompt': a new version waits until no bill is open (pwa/update.ts).
    VitePWA({
      registerType: 'prompt',
      injectRegister: false,
      manifest: {
        // Shown by Chrome when installing; the app's own text comes from translation keys.
        name: 'POS',
        short_name: 'POS',
        start_url: '/',
        scope: '/',
        display: 'standalone',
        background_color: '#ffffff',
        theme_color: '#0b5cad',
        icons: [
          { src: '/icons/pos-192.png', sizes: '192x192', type: 'image/png' },
          { src: '/icons/pos-512.png', sizes: '512x512', type: 'image/png' },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,wasm,png}'],
        // SQLite's .wasm is about 870 kB.
        maximumFileSizeToCacheInBytes: 4 * 1024 * 1024,
        navigateFallback: '/index.html',
        navigateFallbackDenylist: [/^\/api\//],
      },
    }),
    ...(sentryToken
      ? [
          sentryVitePlugin({
            org: process.env['SENTRY_ORG'] ?? '',
            project: 'erp-web',
            authToken: sentryToken,
            release: { name: process.env['VITE_ERP_VERSION'] ?? 'dev' },
            sourcemaps: { filesToDeleteAfterUpload: ['dist/**/*.map'] },
            telemetry: false,
          }),
        ]
      : []),
  ],
  build: { sourcemap: sentryToken ? 'hidden' : false },
  // SQLite WASM loads its .wasm file relative to itself: pre-bundling would break that (D-089).
  optimizeDeps: { exclude: ['@sqlite.org/sqlite-wasm'] },
  worker: { format: 'es' },
  server: { proxy: api },
  preview: { proxy: api },
  test: {
    environment: 'jsdom',
  },
});
