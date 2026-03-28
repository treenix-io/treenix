import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  retries: 0,
  use: {
    baseURL: 'http://localhost:3210',
    browserName: 'firefox',
  },
  projects: [
    { name: 'firefox', use: { browserName: 'firefox' } },
  ],
});
