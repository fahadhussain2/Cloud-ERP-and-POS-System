import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/main.ts', 'src/migrate.ts'],
  format: 'esm',
  target: 'node24',
  platform: 'node',
  sourcemap: true,
  clean: true,
  // Internal packages are TypeScript source (D-071), so they are bundled, not loaded from node_modules.
  noExternal: [/^@erp\//],
});
