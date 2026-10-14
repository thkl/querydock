import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  resolve: {
    alias: {
      '@querydock/contracts': fileURLToPath(new URL('../../packages/contracts/src/index.ts', import.meta.url)),
    },
  },
  test: {
    include: ['apps/server/test/**/*.spec.ts'],
    environment: 'node',
    clearMocks: true,
    restoreMocks: true,
  },
});
