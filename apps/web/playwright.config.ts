import { defineConfig, devices } from '@playwright/test';
import { resolve } from 'node:path';

const repositoryRoot = resolve(__dirname, '../..');
const baseURL = 'http://127.0.0.1:4200';

export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? 'github' : 'list',
  use: {
    ...devices['Desktop Chrome'],
    baseURL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  webServer: {
    command: 'pnpm --filter @querydock/contracts build && pnpm --filter @querydock/web exec ng serve --host 127.0.0.1 --port 4200',
    cwd: repositoryRoot,
    url: baseURL,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
