/// <reference types="vite/client" />

// Baked in at build time (Dockerfile, W0-06): Sentry's erp-web DSN and the release (git tree hash).
interface ImportMetaEnv {
  readonly VITE_SENTRY_DSN?: string;
  readonly VITE_ERP_VERSION?: string;
}
