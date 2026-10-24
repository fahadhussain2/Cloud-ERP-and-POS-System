/// <reference types="vitest/config" />
import { sentryVitePlugin } from '@sentry/vite-plugin';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// With a Sentry token (CI only), source maps are uploaded to Sentry's erp-web project and deleted from dist (D-086).
const sentryToken = process.env['SENTRY_AUTH_TOKEN'];

export default defineConfig({
  plugins: [
    react(),
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
  test: {
    environment: 'jsdom',
  },
});
