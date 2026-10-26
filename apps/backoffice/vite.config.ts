/// <reference types="vitest/config" />
import { sentryVitePlugin } from '@sentry/vite-plugin';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// With a Sentry token (CI only), source maps are uploaded to Sentry's erp-web project and deleted from dist (D-086).
const sentryToken = process.env['SENTRY_AUTH_TOKEN'];
// The API on the same origin, as behind the edge proxy (D-065); locally and in E2E it runs on its own port.
// The Host header is kept, as Caddy keeps it: the API checks Origin against it (CSRF defence).
const api = { '/api': { target: process.env['API_URL'] ?? 'http://127.0.0.1:3000', changeOrigin: false } };

export default defineConfig({
  plugins: [
    react(),
    // Styles: Tailwind on the prototype's tokens (D-066, @erp/ui/theme.css), as on the counter (W1-04).
    tailwindcss(),
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
  server: { proxy: api },
  preview: { proxy: api },
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test-setup.ts'],
  },
});
