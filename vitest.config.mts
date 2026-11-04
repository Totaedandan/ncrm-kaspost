import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    // DB tests need a running Postgres: use `pnpm test:integration` for them.
    exclude: ['**/node_modules/**', '**/*.db.test.ts'],
    environment: 'node',
    coverage: { provider: 'v8', include: ['src/**/*.ts'], exclude: ['src/main.ts'] },
  },
});
