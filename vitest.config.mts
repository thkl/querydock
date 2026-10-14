import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@querydock/contracts': fileURLToPath(new URL('./packages/contracts/src/index.ts', import.meta.url)),
    },
  },
  test: {
    include: ['tests/**/*.spec.ts', 'apps/server/test/**/*.spec.ts', 'apps/web/test/**/*.spec.ts'],
    environment: 'node',
    clearMocks: true,
    restoreMocks: true,
  },
});
