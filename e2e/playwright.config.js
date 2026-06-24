// @ts-check
const { defineConfig, devices } = require('@playwright/test');
const path = require('path');
require('dotenv').config({ path: '.env.test' });

module.exports = defineConfig({
  testDir: './tests',
  timeout: 60000,
  expect: { timeout: 10000 },
  fullyParallel: false,
  retries: 1,
  reporter: [
    ['list'],
    ['html', { open: 'never' }]
  ],
  use: {
    baseURL: process.env.LIFF_BASE_URL || 'https://your-github-pages-url.github.io/reservation-liff-app',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'on-first-retry',
  },
  projects: [
    // API・LIFF テスト（認証不要）
    {
      name: 'chromium',
      testIgnore: '**/admin-screenshots.spec.js',
      use: { ...devices['Desktop Chrome'] },
    },
    {
      name: 'Mobile Safari',
      testIgnore: '**/admin-screenshots.spec.js',
      use: { ...devices['iPhone 13'] },
    },
    // 管理画面スクリーンショット（Google認証状態を使用）
    {
      name: 'admin-screenshots',
      testMatch: '**/admin-screenshots.spec.js',
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 1440, height: 900 },
        storageState: path.join(__dirname, 'admin-auth-state.json'),
      },
    },
  ],
});
