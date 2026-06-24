/**
 * admin-screenshots.spec.js
 * 管理画面（settings.html / kanri.html）のスクリーンショット自動取得。
 * スルーテストのエビデンスとして使用する。
 *
 * 【事前準備】
 *   node auth-setup.js  → admin-auth-state.json を生成してから実行
 *
 * 【実行方法】
 *   npm run screenshots
 *
 * 【出力先】
 *   e2e/screenshots/admin/  以下に日時フォルダを作成して保存
 */

const { test, expect } = require('@playwright/test');
const path = require('path');
const fs   = require('fs');
require('dotenv').config({ path: path.join(__dirname, '../.env.test') });

// ---------------------------------------------------------------
// 設定
// ---------------------------------------------------------------
const GAS_ADMIN_URL  = process.env.GAS_ADMIN_URL;
const GAS_KANRI_URL  = GAS_ADMIN_URL ? `${GAS_ADMIN_URL}?page=kanri` : '';
const AUTH_STATE     = path.join(__dirname, '../admin-auth-state.json');
const TIMESTAMP      = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const SCREENSHOTS_DIR = path.join(__dirname, '../screenshots/admin', TIMESTAMP);

// ---------------------------------------------------------------
// セットアップ
// ---------------------------------------------------------------
test.beforeAll(() => {
  if (!GAS_ADMIN_URL) throw new Error('.env.test に GAS_ADMIN_URL が設定されていません。');
  if (!fs.existsSync(AUTH_STATE)) {
    throw new Error(
      'admin-auth-state.json が存在しません。\n' +
      '先に「node auth-setup.js」を実行してGoogleログインを完了してください。'
    );
  }
  fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });
  console.log(`\nスクリーンショット保存先: ${SCREENSHOTS_DIR}\n`);
});

// 保存済み認証状態を全テストで使用
test.use({
  storageState: AUTH_STATE,
  viewport: { width: 1440, height: 900 },
});

// ---------------------------------------------------------------
// ヘルパー
// ---------------------------------------------------------------
async function capture(page, filename, options = {}) {
  const filepath = path.join(SCREENSHOTS_DIR, filename);
  await page.screenshot({ path: filepath, fullPage: options.fullPage ?? true });
  console.log(`  ✓ ${filename}`);
  return filepath;
}

async function waitForAdminPage(page, url) {
  await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });
  // 認証リダイレクト中なら待機
  if (page.url().includes('accounts.google.com')) {
    throw new Error('認証が切れています。node auth-setup.js を再実行してください。');
  }
}

// ---------------------------------------------------------------
// 設定画面 (settings.html)
// ---------------------------------------------------------------
test.describe('設定画面スクリーンショット', () => {

  test('SC-S-01: 設定画面 全体表示', async ({ page }) => {
    await waitForAdminPage(page, GAS_ADMIN_URL);
    await capture(page, 'SC-S-01_settings-fullpage.png', { fullPage: true });
  });

  test('SC-S-02: 設定画面 ページ上部（基本設定）', async ({ page }) => {
    await waitForAdminPage(page, GAS_ADMIN_URL);
    await page.evaluate(() => window.scrollTo(0, 0));
    await capture(page, 'SC-S-02_settings-top.png', { fullPage: false });
  });

  test('SC-S-03: 設定画面 メニュー設定セクション', async ({ page }) => {
    await waitForAdminPage(page, GAS_ADMIN_URL);
    const menuSection = page.locator('[id*="menu"], [class*="menu"], section').filter({ hasText: 'メニュー' }).first();
    if (await menuSection.count() > 0) {
      await menuSection.scrollIntoViewIfNeeded();
      await page.waitForTimeout(500);
    }
    await capture(page, 'SC-S-03_settings-menu.png', { fullPage: false });
  });

  test('SC-S-04: 設定画面 担当者設定セクション', async ({ page }) => {
    await waitForAdminPage(page, GAS_ADMIN_URL);
    const staffSection = page.locator('[id*="staff"], section').filter({ hasText: '担当者' }).first();
    if (await staffSection.count() > 0) {
      await staffSection.scrollIntoViewIfNeeded();
      await page.waitForTimeout(500);
    }
    await capture(page, 'SC-S-04_settings-staff.png', { fullPage: false });
  });

  test('SC-S-05: 設定画面 予約設定セクション（一括予約設定含む）', async ({ page }) => {
    await waitForAdminPage(page, GAS_ADMIN_URL);
    const bookingSection = page.locator('section, div').filter({ hasText: '一括予約' }).first();
    if (await bookingSection.count() > 0) {
      await bookingSection.scrollIntoViewIfNeeded();
      await page.waitForTimeout(500);
    }
    await capture(page, 'SC-S-05_settings-booking.png', { fullPage: false });
  });

  test('SC-S-06: 設定画面 リマインダー設定セクション', async ({ page }) => {
    await waitForAdminPage(page, GAS_ADMIN_URL);
    const reminderSection = page.locator('section, div').filter({ hasText: 'リマインダー' }).first();
    if (await reminderSection.count() > 0) {
      await reminderSection.scrollIntoViewIfNeeded();
      await page.waitForTimeout(500);
    }
    await capture(page, 'SC-S-06_settings-reminder.png', { fullPage: false });
  });

});

// ---------------------------------------------------------------
// 予約管理画面 (kanri.html)
// ---------------------------------------------------------------
test.describe('予約管理画面スクリーンショット', () => {

  test('SC-K-01: 予約管理画面 全体表示', async ({ page }) => {
    await waitForAdminPage(page, GAS_KANRI_URL);
    await capture(page, 'SC-K-01_kanri-fullpage.png', { fullPage: true });
  });

  test('SC-K-02: 予約管理画面 ページ上部（予約一覧）', async ({ page }) => {
    await waitForAdminPage(page, GAS_KANRI_URL);
    await page.evaluate(() => window.scrollTo(0, 0));
    await capture(page, 'SC-K-02_kanri-top.png', { fullPage: false });
  });

  test('SC-K-03: 予約管理画面 顧客一覧エリア', async ({ page }) => {
    await waitForAdminPage(page, GAS_KANRI_URL);
    const customerSection = page.locator('[id*="customer"], section, div').filter({ hasText: '顧客' }).first();
    if (await customerSection.count() > 0) {
      await customerSection.scrollIntoViewIfNeeded();
      await page.waitForTimeout(500);
    }
    await capture(page, 'SC-K-03_kanri-customers.png', { fullPage: false });
  });

});

// ---------------------------------------------------------------
// テスト結果サマリー
// ---------------------------------------------------------------
test.afterAll(() => {
  const files = fs.existsSync(SCREENSHOTS_DIR)
    ? fs.readdirSync(SCREENSHOTS_DIR).filter(f => f.endsWith('.png'))
    : [];
  console.log(`\n========================================`);
  console.log(` スクリーンショット取得完了`);
  console.log(`========================================`);
  console.log(` 保存数: ${files.length} 件`);
  console.log(` 保存先: ${SCREENSHOTS_DIR}`);
  console.log(`========================================\n`);
});
