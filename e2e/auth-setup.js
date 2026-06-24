/**
 * auth-setup.js
 * Google管理画面へのログイン状態を保存するセットアップスクリプト。
 *
 * 【使い方】（初回のみ実行）
 *   cd e2e
 *   node auth-setup.js
 *
 * ブラウザが開くので管理用Googleアカウントでログインしてください。
 * ログイン完了を検出すると自動で admin-auth-state.json に保存されます。
 */

const { chromium } = require('@playwright/test');
const path = require('path');
const fs   = require('fs');
require('dotenv').config({ path: path.join(__dirname, '.env.test') });

const AUTH_STATE_PATH = path.join(__dirname, 'admin-auth-state.json');
const GAS_ADMIN_URL   = process.env.GAS_ADMIN_URL;

if (!GAS_ADMIN_URL) {
  console.error('[ERROR] .env.test に GAS_ADMIN_URL が設定されていません。');
  console.error('  例: GAS_ADMIN_URL=https://script.google.com/macros/s/AKfy.../exec');
  process.exit(1);
}

(async () => {
  console.log('');
  console.log('==============================================');
  console.log(' Google管理画面 認証状態セットアップ');
  console.log('==============================================');
  console.log('');
  console.log('[1] ブラウザを開いて管理画面に移動します...');

  const browser = await chromium.launch({
    headless: false,
    slowMo: 200,
    args: ['--start-maximized'],
  });

  const context = await browser.newContext({ viewport: null });
  const page    = await context.newPage();

  await page.goto(GAS_ADMIN_URL, { waitUntil: 'domcontentloaded' });

  console.log('[2] Googleアカウントでログインしてください（最大3分待機します）');
  console.log('    ログインが完了すると自動的に次のステップに進みます。');
  console.log('');

  // 設定画面の特徴的な要素が出るまで待機
  // GASの管理画面には <form> や save ボタンが含まれる
  try {
    await page.waitForFunction(
      () => {
        const url = window.location.href;
        // Google認証ページから外れていれば認証完了とみなす
        return !url.includes('accounts.google.com') &&
               !url.includes('signin') &&
               document.readyState === 'complete';
      },
      { timeout: 180000, polling: 2000 }
    );

    // 追加で2秒待機（ページの完全ロードを確保）
    await page.waitForTimeout(2000);

    console.log('[3] ログイン確認！認証状態を保存中...');
    await context.storageState({ path: AUTH_STATE_PATH });

    const stat = fs.statSync(AUTH_STATE_PATH);
    console.log(`    保存先: ${AUTH_STATE_PATH}`);
    console.log(`    ファイルサイズ: ${(stat.size / 1024).toFixed(1)} KB`);
    console.log('');
    console.log('[完了] npm run screenshots でスクリーンショット撮影を開始できます。');
  } catch (e) {
    console.error('[ERROR] タイムアウトまたはログイン検出に失敗しました。');
    console.error('  もう一度実行して3分以内にログインしてください。');
  }

  await browser.close();
  console.log('');
})();
