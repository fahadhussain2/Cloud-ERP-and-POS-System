import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

// The building blocks are tested in jsdom, like the screens that use them.
export default defineConfig({
  plugins: [react()],
  test: { environment: 'jsdom' },
});
