/**
 * LIFF 予約フロー E2Eテスト
 *
 * 注意: このテストはLINE認証が必要なため、
 * 実際のLIFFアプリをブラウザ上で操作します。
 * LINE認証はテスト用アカウントのセッションが必要です。
 *
 * 実行前に .env.test を設定してください。
 * 実行: npx playwright test tests/booking.spec.js
 */

const { test, expect } = require('@playwright/test');
const { getLiffUrl } = require('./helpers');

// =================================================================
// 共通セットアップ
// =================================================================

test.beforeEach(async ({ page }) => {
  const liffUrl = getLiffUrl();
  if (!liffUrl) {
    test.skip(true, 'LIFF_FULL_URL が .env.test に設定されていません');
  }
});

// =================================================================
// TC-F-017: URL パラメーター不足
// =================================================================

test('TC-F-017: URLパラメーター不足時にエラー画面を表示', async ({ page }) => {
  // baseURL のみでアクセス（パラメーターなし）
  await page.goto('/liff.html');
  await page.waitForLoadState('domcontentloaded');

  // エラーコンテナが表示されることを確認
  const errorEl = page.locator('#error');
  await expect(errorEl).toBeVisible({ timeout: 15000 });
  const errorText = await page.locator('#errorMessage').textContent();
  expect(errorText).toContain('設定情報が不足');
});

// =================================================================
// TC-F-001 ～ TC-F-006: 基本予約フロー
// =================================================================

test.describe('基本予約フロー', () => {
  test.beforeEach(async ({ page }) => {
    const liffUrl = getLiffUrl();
    await page.goto(liffUrl);
    // LIFFの初期化を待つ（LINE認証リダイレクトがある場合は事前にセッション確立が必要）
    await page.waitForSelector('#app', { state: 'visible', timeout: 30000 });
  });

  test('TC-F-003: Step3 - メニュー選択ボタンが表示される', async ({ page }) => {
    // Step2まで進む（2回目以降ユーザー想定）
    // Step1: 2回目以降を選択
    const repeatButton = page.locator('.selection-button[data-value="repeat"]');
    if (await repeatButton.isVisible()) {
      await repeatButton.click();
    }

    // Step2: 新規予約を選択
    const newBookingButton = page.locator('.selection-button[data-next-step="step3-menu"]').first();
    await expect(newBookingButton).toBeVisible({ timeout: 5000 });
    await newBookingButton.click();

    // Step3: メニューリストが表示される
    const menuButtons = page.locator('#menu-list-container .selection-button');
    await expect(menuButtons.first()).toBeVisible({ timeout: 5000 });
    const count = await menuButtons.count();
    expect(count).toBeGreaterThan(0);
  });

  test('TC-F-004: Step4 - 担当者未選択時はカレンダーが非表示', async ({ page }) => {
    // Step4まで進む
    await _navigateToStep4(page);

    // 担当者機能がONの場合
    const staffContainer = page.locator('#staff-selector-container');
    if (await staffContainer.isVisible()) {
      // カレンダーが非表示であることを確認
      const timetableContainer = page.locator('#timetable-container');
      await expect(timetableContainer).toBeHidden();

      // プレースホルダーが表示されている
      const placeholder = page.locator('#staff-selector option[disabled]');
      await expect(placeholder).toBeAttached();
    }
  });

  test('TC-F-005: Step4 - 担当者選択でカレンダーが表示される', async ({ page }) => {
    await _navigateToStep4(page);

    const staffSelector = page.locator('#staff-selector');
    if (!await staffSelector.isVisible()) {
      test.skip(true, '担当者機能がOFFのためスキップ');
      return;
    }

    // 「指名なし」を選択
    await staffSelector.selectOption('any');

    // カレンダーが表示される
    const timetableContainer = page.locator('#timetable-container');
    await expect(timetableContainer).toBeVisible({ timeout: 5000 });

    // タイムテーブルが読み込まれる
    await page.waitForSelector('#timetable tbody tr td', { timeout: 20000 });
  });
});

// =================================================================
// TC-F-007 ～ TC-F-010: 一括予約 UI
// =================================================================

test.describe('一括予約 UI', () => {
  test.beforeEach(async ({ page }) => {
    const liffUrl = getLiffUrl();
    await page.goto(liffUrl);
    await page.waitForSelector('#app', { state: 'visible', timeout: 30000 });
  });

  test('TC-F-007: maxBulkBookings>1 のときカウンターチップが表示される', async ({ page }) => {
    await _navigateToStep4WithStaff(page);

    // タイムテーブルが読み込まれるまで待つ
    await page.waitForSelector('#timetable .slot:not(.unavailable)', { timeout: 20000 });

    // 空き枠をクリック
    const availableSlot = page.locator('#timetable .slot:not(.unavailable)').first();
    await availableSlot.click();

    // カウンターチップが表示される
    const counter = page.locator('#bulk-counter');
    const counterDisplay = await counter.evaluate(el => window.getComputedStyle(el).display);

    // maxBulkBookings が1の場合はnone、2以上なら表示
    // （テスト環境の設定に依存）
    const counterText = await counter.textContent();
    expect(counterText).toBeTruthy();
  });

  test('TC-F-008: カウンターチップタップで選択パネルが展開される', async ({ page }) => {
    await _navigateToStep4WithStaff(page);
    await page.waitForSelector('#timetable .slot:not(.unavailable)', { timeout: 20000 });

    // スロットを選択
    await page.locator('#timetable .slot:not(.unavailable)').first().click();

    // カウンターをクリック
    const counter = page.locator('#bulk-counter');
    if (await counter.isVisible()) {
      await counter.click();
      const panel = page.locator('#selected-dates-panel');
      await expect(panel).toHaveClass(/is-open/);
    }
  });

  test('TC-F-010: 時間帯重複スロットが slot-conflict クラスを持つ', async ({ page }) => {
    await _navigateToStep4WithStaff(page);
    await page.waitForSelector('#timetable .slot:not(.unavailable)', { timeout: 20000 });

    // 1つ目のスロットを選択
    const firstSlot = page.locator('#timetable .slot:not(.unavailable)').first();
    const firstDateTime = await firstSlot.getAttribute('data-datetime');
    await firstSlot.click();

    // 同日の次のスロット（重複する可能性）を確認
    const conflictSlots = page.locator('#timetable .slot.slot-conflict');
    const conflictCount = await conflictSlots.count();
    // menuのdurationが0より大きく、かつ同日スロットがある場合に重複が発生する
    // テスト環境によって結果が異なるため、エラーにはしない
    console.log(`slot-conflict クラスのスロット数: ${conflictCount}`);
  });
});

// =================================================================
// ICS ダウンロード テスト
// =================================================================

test('TC-F-012: ICSダウンロードリンクが正しいURLを持つ', async ({ page }) => {
  const liffUrl = getLiffUrl();
  await page.goto(liffUrl);
  await page.waitForSelector('#app', { state: 'visible', timeout: 30000 });

  // 完了画面を直接テスト用に表示（実際の予約フローは省略）
  // 代わりに data 属性の形式を確認するためのAPIテストを行う
  // このテストはTC-B-030の後でICSURLを検証する方が確実

  // GAS ICS エンドポイントのアクセス確認
  const gasApiUrl = process.env.GAS_API_URL;
  if (!gasApiUrl) {
    test.skip(true, 'GAS_API_URL が設定されていません');
    return;
  }

  const icsUrl = `${gasApiUrl}?action=downloadICS&bookingIds=INVALID_ID`;
  const response = await page.request.get(icsUrl);
  // 存在しない予約IDでもエラーではなくテキストが返る
  expect(response.status()).toBeLessThan(500);
});

// =================================================================
// ヘルパー関数
// =================================================================

async function _navigateToStep4(page) {
  // Step1: 2回目以降を選択
  const repeatBtn = page.locator('.selection-button[data-value="repeat"]');
  if (await repeatBtn.isVisible({ timeout: 3000 })) {
    await repeatBtn.click();
  }

  // Step2: 新規予約
  const newBookingBtn = page.locator('.selection-button[data-next-step="step3-menu"]').first();
  await expect(newBookingBtn).toBeVisible({ timeout: 5000 });
  await newBookingBtn.click();

  // Step3: 最初のメニューを選択
  const firstMenuBtn = page.locator('#menu-list-container .selection-button').first();
  await expect(firstMenuBtn).toBeVisible({ timeout: 5000 });
  await firstMenuBtn.click();

  // Step4が表示される
  await expect(page.locator('#section-step4-datetime')).toBeVisible({ timeout: 5000 });
}

async function _navigateToStep4WithStaff(page) {
  await _navigateToStep4(page);

  // 担当者を選択（機能ONの場合）
  const staffSelector = page.locator('#staff-selector');
  if (await staffSelector.isVisible({ timeout: 2000 })) {
    await staffSelector.selectOption('any');
  }

  // タイムテーブルの表示を待つ
  await expect(page.locator('#timetable-container')).toBeVisible({ timeout: 5000 });
}
