import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: '.',
  testMatch: /.*\.spec\.mjs/,
  timeout: 90_000,
  expect: { timeout: 15_000 },
  retries: 1,
  use: {
    baseURL: process.env.QA_JIRA_URL,
    storageState: process.env.QA_STORAGE_STATE_FILE || undefined,
    headless: true,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure'
  },
  reporter: [['line'], ['html', { outputFolder: 'playwright-report', open: 'never' }]]
});
