import { execSync } from 'node:child_process';

export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? 'postgresql://postgres:postgres@localhost:5433/ncrm_kazpost_test';

/** Applies the real migrations to the test database once per run (docker compose up -d postgres-test). */
export default function setup(): void {
  process.env.TEST_DATABASE_URL = TEST_DATABASE_URL;
  execSync('pnpm prisma migrate deploy', {
    stdio: 'pipe',
    env: { ...process.env, DATABASE_URL: TEST_DATABASE_URL },
  });
}
