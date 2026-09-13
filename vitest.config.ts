import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// Tests import the packages from source. Alias the workspace name to the source entry so the CLI
// and MCP packages and the tests share one module instance (otherwise `instanceof` checks fail
// against a second copy loaded from dist).
export default defineConfig({
  resolve: {
    alias: {
      '@verdict/core': fileURLToPath(new URL('./packages/core/src/index.ts', import.meta.url)),
    },
  },
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
  },
});
