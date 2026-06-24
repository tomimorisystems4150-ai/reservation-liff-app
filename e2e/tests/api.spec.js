/**
 * GAS API エンドポイント テスト
 * LINE認証不要のAPIを直接テストする
 *
 * 実行: npx playwright test tests/api.spec.js
 */

const { test, expect } = require('@playwright/test');
const { callGasApi, getFutureDateTime, getFutureDate } = require('./helpers');

const TEST_LINE_USER_ID = `test_pw_${Date.now()}`;
const TEST_CUSTOMER_NAME = '__Playwright__テスト太郎';

// =================================================================
// TC-B-001 ～ TC-B-002: getInitData
// =================================================================

test.describe('getInitData', () => {
  test('TC-B-001: 正常系 - 必要なフィールドが含まれる', async ({ request }) => {
    const res = await callGasApi(request, 'getInitData', { lineUserId: TEST_LINE_USER_ID });

    expect(res.success).toBe(true);
    expect(res.data).toHaveProperty('shopName');
    expect(res.data).toHaveProperty('serviceMenus');
    expect(res.data).toHaveProperty('isStaffFeatureEnabled');
    expect(res.data).toHaveProperty('bookingTimeUnit');
    expect(res.data).toHaveProperty('bookingLookaheadDays');
    expect(res.data).toHaveProperty('isRegistered');
    expect(res.data).toHaveProperty('maxBulkBookings');
    expect(Array.isArray(res.data.serviceMenus)).toBe(true);
    expect(typeof res.data.maxBulkBookings).toBe('number');
  });

  test('TC-B-002: 未登録ユーザーは isRegistered=false', async ({ request }) => {
    const res = await callGasApi(request, 'getInitData', { lineUserId: `unregistered_${Date.now()}` });
    expect(res.success).toBe(true);
    expect(res.data.isRegistered).toBe(false);
  });
});

// =================================================================
// TC-B-010 ～ TC-B-012: registerCustomer
// =================================================================

test.describe('registerCustomer', () => {
  test('TC-B-010: 正常系 - 新規顧客登録', async ({ request }) => {
    const uniqueId = `test_reg_${Date.now()}`;
    const res = await callGasApi(request, 'registerCustomer', {
      lineUserId: uniqueId,
      customerName: TEST_CUSTOMER_NAME,
      gender: '女性',
      ageGroup: '30代',
    });

    expect(res.success).toBe(true);
    expect(res.data['LINE User ID']).toBe(uniqueId);
    expect(res.data['性別']).toBe('女性');
    expect(res.data['年代']).toBe('30代');
    expect(res.data['ステータス']).toBe('有効');
  });

  test('TC-B-011: 重複登録はエラーなく既存データを返す（べき等性）', async ({ request }) => {
    const uniqueId = `test_idem_${Date.now()}`;

    await callGasApi(request, 'registerCustomer', {
      lineUserId: uniqueId,
      customerName: TEST_CUSTOMER_NAME,
      gender: '男性',
      ageGroup: '40代',
    });

    const res2 = await callGasApi(request, 'registerCustomer', {
      lineUserId: uniqueId,
      customerName: TEST_CUSTOMER_NAME,
      gender: '男性',
      ageGroup: '40代',
    });

    expect(res2.success).toBe(true);
    expect(res2.data['LINE User ID']).toBe(uniqueId);
  });

  test('TC-B-012: customerName が空文字はエラー', async ({ request }) => {
    const res = await callGasApi(request, 'registerCustomer', {
      lineUserId: `test_empty_${Date.now()}`,
      customerName: '',
      gender: '女性',
      ageGroup: '30代',
    });

    expect(res.success).toBe(false);
    expect(res.message).toBeTruthy();
  });
});

// =================================================================
// TC-B-020 ～ TC-B-023: getAvailableSlots
// =================================================================

test.describe('getAvailableSlots', () => {
  test('TC-B-020: 正常系 - 7日分の空き枠が返る', async ({ request }) => {
    const futureDate = getFutureDate(7);
    const res = await callGasApi(request, 'getAvailableSlots', {
      date: futureDate,
      duration: 30,
      staffEmail: null,
    });

    expect(res.success).toBe(true);
    const keys = Object.keys(res.data);
    expect(keys).toHaveLength(7);
    keys.forEach(key => {
      expect(Array.isArray(res.data[key])).toBe(true);
    });
  });

  test('TC-B-021: 指名あり - 担当者別空き枠が返る', async ({ request }) => {
    // まず initData で担当者情報を取得
    const initRes = await callGasApi(request, 'getInitData', { lineUserId: TEST_LINE_USER_ID });
    if (!initRes.data.isStaffFeatureEnabled || !initRes.data.staffs?.length) {
      test.skip(true, '担当者機能がOFFのためスキップ');
      return;
    }

    const staffEmail = initRes.data.staffs[0].email;
    const res = await callGasApi(request, 'getAvailableSlots', {
      date: getFutureDate(7),
      duration: 30,
      staffEmail,
    });

    expect(res.success).toBe(true);
    expect(Object.keys(res.data)).toHaveLength(7);
  });
});

// =================================================================
// TC-B-030 ～ TC-B-031: createBooking
// =================================================================

test.describe('createBooking', () => {
  let createdBookingId = null;

  test('TC-B-030: 正常系 - 予約作成成功', async ({ request }) => {
    const initRes = await callGasApi(request, 'getInitData', { lineUserId: TEST_LINE_USER_ID });
    const menu = initRes.data.serviceMenus[0];

    const res = await callGasApi(request, 'createBooking', {
      bookingData: {
        lineUserId: TEST_LINE_USER_ID,
        userName: TEST_CUSTOMER_NAME,
        menuName: menu.name,
        duration: menu.duration,
        startDateTime: getFutureDateTime(10),
        staffEmail: 'any',
        staffName: '',
      },
    });

    expect(res.success).toBe(true);
    expect(res.data.bookingId).toBeTruthy();
    expect(res.data.bookingId).toMatch(/^BK/);
    expect(res.data.shopName).toBeTruthy();
    createdBookingId = res.data.bookingId;
  });

  test('TC-B-999: 無効なアクションはエラーを返す', async ({ request }) => {
    const res = await callGasApi(request, 'invalidAction_xyz_playwright');
    expect(res.success).toBe(false);
    expect(res.message).toContain('無効');
  });
});

// =================================================================
// TC-B-040 ～ TC-B-042: createBulkBookings
// =================================================================

test.describe('createBulkBookings', () => {
  test('TC-B-040: 正常系 - 2件の一括予約', async ({ request }) => {
    const initRes = await callGasApi(request, 'getInitData', { lineUserId: TEST_LINE_USER_ID });
    const maxBulk = initRes.data.maxBulkBookings;

    if (maxBulk < 2) {
      test.skip(true, `maxBulkBookings=${maxBulk} のためスキップ`);
      return;
    }

    const menu = initRes.data.serviceMenus[0];
    const base = {
      lineUserId: TEST_LINE_USER_ID,
      userName: TEST_CUSTOMER_NAME,
      menuName: menu.name,
      duration: menu.duration,
      staffEmail: 'any',
      staffName: '',
    };

    const res = await callGasApi(request, 'createBulkBookings', {
      bookingDataList: [
        { ...base, startDateTime: getFutureDateTime(20) },
        { ...base, startDateTime: getFutureDateTime(21) },
      ],
    });

    expect(res.success).toBe(true);
    expect(Array.isArray(res.data)).toBe(true);
    expect(res.data).toHaveLength(2);
    res.data.forEach(r => {
      expect(r.bookingId).toMatch(/^BK/);
    });
  });

  test('TC-B-041: 上限超過はエラーを返す', async ({ request }) => {
    const initRes = await callGasApi(request, 'getInitData', { lineUserId: TEST_LINE_USER_ID });
    const maxBulk = initRes.data.maxBulkBookings;
    const menu = initRes.data.serviceMenus[0];

    const overLimitList = Array.from({ length: maxBulk + 1 }, (_, i) => ({
      lineUserId: TEST_LINE_USER_ID,
      userName: TEST_CUSTOMER_NAME,
      menuName: menu.name,
      duration: menu.duration,
      startDateTime: getFutureDateTime(40 + i),
      staffEmail: 'any',
      staffName: '',
    }));

    const res = await callGasApi(request, 'createBulkBookings', { bookingDataList: overLimitList });
    expect(res.success).toBe(false);
    expect(res.message).toContain('上限');
  });
});
