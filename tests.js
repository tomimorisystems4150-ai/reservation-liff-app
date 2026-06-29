/**
 * @fileoverview GASバックエンド自動テストスイート
 *
 * 【実行方法】
 *   GASエディタ: runAllGASTests() を実行
 *   API経由:     doPost に {"action":"runTests"} を送信（結果をJSONで返す）
 *
 * テスト実行後、スプレッドシートの「テスト結果」シートに証跡を自動保存します。
 *
 * 【LINE ID Token 検証とテスト】
 * Config に lineLoginChannelId が未設定の場合、API テストは idToken なしで動作（移行モード）。
 * lineLoginChannelId 設定後は TC-SEC-002 が有効になり、実 LIFF 経由の E2E 確認が別途必要。
 */

// =================================================================
// テストランナー（外部公開）
// =================================================================

/**
 * 全テストを実行し、結果をシートに保存してオブジェクトで返す。
 * GASエディタから直接実行する場合はこの関数を呼び出す。
 * @returns {{summary: Object, results: Object[]}}
 */
function runAllGASTests() {
  Logger.log('========================================');
  Logger.log('  GAS テストスイート 開始');
  Logger.log('========================================');

  // 前回実行が中断された場合の残骸を除去してから開始
  cleanupTestData_();

  const startTime = new Date();
  const results = [];
  results.push(...runAPITests_());
  results.push(...runSecurityTests_());
  results.push(...runLogicTests_());
  results.push(...runBatchTests_());
  results.push(...runErrorLogIntegrationTests_());
  results.push(...runPerformanceTests_());
  const endTime = new Date();

  const passed  = results.filter(r => r.passed).length;
  const failed  = results.filter(r => !r.passed);
  const elapsed = Math.round((endTime - startTime) / 1000);

  const summary = {
    total:     results.length,
    passed:    passed,
    failed:    failed.length,
    elapsedSec: elapsed,
    executedAt: startTime.toISOString(),
  };

  Logger.log('----------------------------------------');
  Logger.log(`テスト結果: ${passed} / ${results.length} 件 合格（${elapsed}秒）`);
  if (failed.length > 0) {
    Logger.log('【失敗したテスト】');
    failed.forEach(r => Logger.log(`  ✗ ${r.name}\n    → ${r.error}`));
  } else {
    Logger.log('全テスト合格 ✓');
  }
  Logger.log('========================================');

  // 証跡をシートに保存
  saveTestResults_(summary, results);

  // テストデータを自動クリーンアップ
  cleanupTestData_();
  Logger.log('テストデータを削除しました。');

  return { summary, results };
}

function runAPITests() {
  const results = runAPITests_();
  _printResults(results);
}

function runLogicTests() {
  const results = runLogicTests_();
  _printResults(results);
}

function _printResults(results) {
  const passed = results.filter(r => r.passed).length;
  const failed = results.filter(r => !r.passed);
  Logger.log(`結果: ${passed}/${results.length} 合格`);
  failed.forEach(r => Logger.log(`  ✗ ${r.name}: ${r.error}`));
}

// =================================================================
// テスト証跡保存
// =================================================================

const TEST_RESULT_SHEET_NAME = 'テスト結果';

/**
 * テスト結果を「テスト結果」シートに追記する（証跡保存）。
 * @param {{total,passed,failed,elapsedSec,executedAt}} summary
 * @param {{name, passed, error, metrics}[]} results
 */
function saveTestResults_(summary, results) {
  try {
    let sheet = getSpreadsheet_().getSheetByName(TEST_RESULT_SHEET_NAME);
    if (!sheet) {
      sheet = getSpreadsheet_().insertSheet(TEST_RESULT_SHEET_NAME);
      sheet.appendRow(['実行日時', '合計', '合格', '失敗', '実行時間(秒)', 'テストID', '結果', 'エラー内容', '性能指標(avg/max ms)']);
      sheet.setFrozenRows(1);
      sheet.getRange(1, 1, 1, 9).setFontWeight('bold');
      sheet.setColumnWidth(1, 160);
      sheet.setColumnWidth(6, 220);
      sheet.setColumnWidth(8, 300);
      sheet.setColumnWidth(9, 180);
    } else {
      // 既存シートに性能指標カラムが未追加なら追加
      const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
      if (!headers.includes('性能指標(avg/max ms)')) {
        sheet.getRange(1, sheet.getLastColumn() + 1).setValue('性能指標(avg/max ms)');
        sheet.setColumnWidth(sheet.getLastColumn(), 180);
      }
    }

    const executedAt = new Date(summary.executedAt);

    results.forEach((r, idx) => {
      const isFirst = (idx === 0);
      const perfCol = r.metrics
        ? `avg:${r.metrics.avg}ms / max:${r.metrics.max}ms`
        : '';

      sheet.appendRow([
        isFirst ? executedAt    : '',
        isFirst ? summary.total : '',
        isFirst ? summary.passed : '',
        isFirst ? summary.failed : '',
        isFirst ? summary.elapsedSec : '',
        r.name,
        r.passed ? '✓ 合格' : '✗ 失敗',
        r.error || '',
        perfCol,
      ]);

      // 失敗行を赤背景でハイライト
      if (!r.passed) {
        const lastRow = sheet.getLastRow();
        sheet.getRange(lastRow, 6, 1, 4).setBackground('#fce8e6');
      }
    });

    // サマリー行の背景色
    const firstDataRow = sheet.getLastRow() - results.length + 1;
    const bgColor = summary.failed === 0 ? '#e6f4ea' : '#fff3e0';
    sheet.getRange(firstDataRow, 1, 1, 5).setBackground(bgColor);

    Logger.log(`テスト証跡を「${TEST_RESULT_SHEET_NAME}」シートに保存しました。`);
  } catch (e) {
    Logger.log(`テスト証跡の保存に失敗: ${e.message}`);
  }
}

// =================================================================
// テストユーティリティ
// =================================================================

function assert_(condition, message) {
  if (!condition) throw new Error(message || 'アサーション失敗');
}

function assertEqual_(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(`${label || ''}: 期待値 [${expected}] 実際 [${actual}]`);
  }
}

function assertContains_(str, substring, label) {
  if (!str.includes(substring)) {
    throw new Error(`${label || ''}: 「${str}」に「${substring}」が含まれていません`);
  }
}

function runTest_(name, fn) {
  try {
    fn();
    Logger.log(`  ✓ ${name}`);
    return { name, passed: true };
  } catch (e) {
    Logger.log(`  ✗ ${name}: ${e.message}`);
    return { name, passed: false, error: e.message };
  }
}

const TEST_LINE_USER_ID = 'test_auto_' + new Date().getTime();
const TEST_CUSTOMER_NAME = '__テスト太郎__';

// =================================================================
// API テスト
// =================================================================

function runAPITests_() {
  Logger.log('\n--- API テスト ---');
  const results = [];

  // TC-B-001: getInitData 正常系
  results.push(runTest_('TC-B-001: getInitData - 正常系', () => {
    const response = _callDoPost({ action: 'getInitData', lineUserId: TEST_LINE_USER_ID });
    assert_(response.success, `success=falseが返った: ${response.message}`);
    assert_(response.data.shopName !== undefined, 'shopNameが含まれていない');
    assert_(Array.isArray(response.data.serviceMenus), 'serviceMenusが配列でない');
    assert_(typeof response.data.isRegistered === 'boolean', 'isRegisteredがboolean以外');
    assert_(typeof response.data.maxBulkBookings === 'number', 'maxBulkBookingsが数値でない');
    assert_(typeof response.data.alternateBookingGuide === 'string', 'alternateBookingGuideが文字列でない');
    assertEqual_(response.data.isRegistered, false, 'isRegistered (新規ユーザー)');
  }));

  // TC-B-002: getInitData 登録済みユーザー
  results.push(runTest_('TC-B-002: getInitData - 登録済みユーザー', () => {
    // 先に顧客登録
    registerCustomer(TEST_LINE_USER_ID, TEST_CUSTOMER_NAME, '女性', '30代');
    const response = _callDoPost({ action: 'getInitData', lineUserId: TEST_LINE_USER_ID });
    assert_(response.success, `success=false: ${response.message}`);
    assertEqual_(response.data.isRegistered, true, 'isRegistered (登録済みユーザー)');
  }));

  // TC-B-010: registerCustomer 正常系
  results.push(runTest_('TC-B-010: registerCustomer - 正常系', () => {
    const uniqueId = 'test_reg_' + new Date().getTime();
    const response = _callDoPost({
      action: 'registerCustomer',
      lineUserId: uniqueId,
      customerName: TEST_CUSTOMER_NAME,
      gender: '女性',
      ageGroup: '30代',
    });
    assert_(response.success, `success=false: ${response.message}`);
    assert_(response.data['LINE User ID'] === uniqueId, 'LINE User IDが一致しない');
    assertEqual_(response.data['性別'], '女性', '性別');
    assertEqual_(response.data['年代'], '30代', '年代');
    assertEqual_(response.data['ステータス'], '有効', 'ステータス');

    const customer = findCustomerByUserId_(uniqueId);
    assert_(customer !== null, '顧客マスタに登録されていない');
  }));

  // TC-B-011: registerCustomer 重複登録（べき等性）
  results.push(runTest_('TC-B-011: registerCustomer - 重複登録（べき等性）', () => {
    const sheetBefore = getCustomerSheet_();
    const rowsBefore = sheetBefore.getLastRow();

    const response = _callDoPost({
      action: 'registerCustomer',
      lineUserId: TEST_LINE_USER_ID,
      customerName: TEST_CUSTOMER_NAME,
      gender: '女性',
      ageGroup: '30代',
    });
    assert_(response.success, `success=false: ${response.message}`);

    const rowsAfter = sheetBefore.getLastRow();
    assertEqual_(rowsAfter, rowsBefore, '重複登録で行数が増加した');
  }));

  // TC-B-012: registerCustomer 必須項目なし
  results.push(runTest_('TC-B-012: registerCustomer - customerName空文字', () => {
    const response = _callDoPost({
      action: 'registerCustomer',
      lineUserId: 'test_empty_name',
      customerName: '',
      gender: '女性',
      ageGroup: '30代',
    });
    assert_(!response.success, 'success=trueが返った（エラーになるべき）');
    assert_(response.message, 'エラーメッセージが空');
  }));

  // TC-B-013: registerCustomer 性別未指定
  results.push(runTest_('TC-B-013: registerCustomer - 性別未指定', () => {
    const response = _callDoPost({
      action: 'registerCustomer',
      lineUserId: 'test_no_gender_' + new Date().getTime(),
      customerName: TEST_CUSTOMER_NAME,
      ageGroup: '30代',
    });
    assert_(!response.success, 'success=trueが返った（エラーになるべき）');
    assertContains_(response.message, '性別', 'エラーメッセージ');
  }));

  // TC-B-020: getAvailableSlots 正常系
  results.push(runTest_('TC-B-020: getAvailableSlots - 基本取得', () => {
    const futureDate = _getFutureWeekdayDate(7);
    const response = _callDoPost({
      action: 'getAvailableSlots',
      date: futureDate,
      duration: 60,
      staffEmail: null
    });
    assert_(response.success, `success=false: ${response.message}`);
    assert_(typeof response.data === 'object', 'dataがオブジェクトでない');
    const keys = Object.keys(response.data);
    assert_(keys.length === 7, `7日分のデータでない（${keys.length}件）`);
    keys.forEach(k => assert_(Array.isArray(response.data[k]), `${k}が配列でない`));
  }));

  // TC-B-030: createBooking 正常系
  results.push(runTest_('TC-B-030: createBooking - 単一予約作成', () => {
    const slot = _getTestSlot(7);
    const response = _callDoPost({
      action: 'createBooking',
      bookingData: {
        lineUserId: TEST_LINE_USER_ID,
        userName: TEST_CUSTOMER_NAME,
        menuName: _getFirstMenuName(),
        duration: 30,
        startDateTime: slot,
        staffEmail: 'any',
        staffName: ''
      }
    });
    assert_(response.success, `success=false: ${response.message}`);
    assert_(response.data.bookingId, '予約IDが返っていない');
    assertContains_(response.data.bookingId, 'BK', '予約IDがBKで始まらない');

    // 予約シートに1行追加されていることを確認
    const configs = getConfigs();
    const sheet = getReservationSheet(configs);
    const data = sheet.getDataRange().getValues();
    const h = data[0];
    const bkIdCol = h.indexOf('予約ID');
    const found = data.slice(1).some(row => row[bkIdCol] === response.data.bookingId);
    assert_(found, '予約シートに該当予約が見つからない');
  }));

  // TC-B-031: createBooking 満席スロット
  results.push(runTest_('TC-B-031: createBooking - 満席スロット（上限=1を強制確認）', () => {
    const configs = getConfigs();
    const savedMax = configs.maxConcurrentBookings;

    // 上限を1に設定して同じスロットに2件試みる
    const slot = _getTestSlot(14); // 14日後
    const bookingData = {
      lineUserId: TEST_LINE_USER_ID,
      userName: TEST_CUSTOMER_NAME,
      menuName: _getFirstMenuName(),
      duration: 30,
      startDateTime: slot,
      staffEmail: 'any',
      staffName: ''
    };

    // 1件目: 成功
    const res1 = _callDoPost({ action: 'createBooking', bookingData });
    assert_(res1.success, `1件目が失敗: ${res1.message}`);

    // maxConcurrentBookingsを一時的に1に強制するため、指名ありルートを使う（指名ありは上限=1固定）
    // 担当者機能ONの場合のみテスト可能
    if (configs.isStaffFeatureEnabled && configs.staffs && configs.staffs.length > 0) {
      const staffEmail = configs.staffs[0].email;
      const res2 = _callDoPost({
        action: 'createBooking',
        bookingData: { ...bookingData, staffEmail, staffName: configs.staffs[0].name, startDateTime: slot }
      });
      // 同スロットへの2件目（指名あり）は失敗するはず
      const res3 = _callDoPost({
        action: 'createBooking',
        bookingData: { ...bookingData, staffEmail, staffName: configs.staffs[0].name, startDateTime: slot }
      });
      assert_(!res3.success, '満席スロットへの予約がエラーにならなかった');
    } else {
      Logger.log('    (担当者機能OFFのためスキップ)');
    }
  }));

  // TC-B-040: createBulkBookings 正常系
  results.push(runTest_('TC-B-040: createBulkBookings - 複数日程一括予約', () => {
    const configs = getConfigs();
    const maxBulk = parseInt(configs.maxBulkBookings || 1, 10);
    if (maxBulk < 2) {
      Logger.log('    (maxBulkBookings<2のためスキップ)');
      return;
    }

    const base = {
      lineUserId: TEST_LINE_USER_ID,
      userName: TEST_CUSTOMER_NAME,
      menuName: _getFirstMenuName(),
      duration: 30,
      staffEmail: 'any',
      staffName: ''
    };
    const slots = [_getTestSlot(21), _getTestSlot(22)];
    const bookingDataList = slots.map(s => ({ ...base, startDateTime: s }));

    const response = _callDoPost({ action: 'createBulkBookings', bookingDataList });
    assert_(response.success, `success=false: ${response.message}`);
    assert_(Array.isArray(response.data), 'dataが配列でない');
    assertEqual_(response.data.length, 2, '返却件数');
    response.data.forEach((r, i) => {
      assert_(r.bookingId, `${i}件目の予約IDが空`);
    });
  }));

  // TC-B-041: createBulkBookings 上限超過
  results.push(runTest_('TC-B-041: createBulkBookings - 上限超過', () => {
    const configs = getConfigs();
    const maxBulk = parseInt(configs.maxBulkBookings || 1, 10);
    const base = {
      lineUserId: TEST_LINE_USER_ID,
      userName: TEST_CUSTOMER_NAME,
      menuName: _getFirstMenuName(),
      duration: 30,
      staffEmail: 'any',
      staffName: ''
    };
    // maxBulk+1 件のリストを送信
    const overLimitList = Array.from({ length: maxBulk + 1 }, (_, i) =>
      ({ ...base, startDateTime: _getTestSlot(30 + i) })
    );

    const response = _callDoPost({ action: 'createBulkBookings', bookingDataList: overLimitList });
    assert_(!response.success, 'success=trueが返った（上限超過でエラーになるべき）');
    assertContains_(response.message, '上限', 'エラーメッセージに「上限」が含まれない');
  }));

  // TC-B-050: getMyBookings
  results.push(runTest_('TC-B-050: getMyBookings - 未来予約一覧', () => {
    const slot = _getTestSlot(28);
    const createResp = _callDoPost({
      action: 'createBooking',
      bookingData: {
        lineUserId: TEST_LINE_USER_ID,
        userName: TEST_CUSTOMER_NAME,
        menuName: _getFirstMenuName(),
        duration: 30,
        startDateTime: slot,
        staffEmail: 'any',
        staffName: '',
      },
    });
    assert_(createResp.success, `予約作成失敗: ${createResp.message}`);

    const response = _callDoPost({
      action: 'getMyBookings',
      lineUserId: TEST_LINE_USER_ID,
    });
    assert_(response.success, `success=false: ${response.message}`);
    assert_(Array.isArray(response.data.bookings), 'bookingsが配列でない');
    const found = response.data.bookings.some(b => b.bookingId === createResp.data.bookingId);
    assert_(found, '作成した予約が一覧に含まれない');
  }));

  // TC-B-051: cancelBookingByUser
  results.push(runTest_('TC-B-051: cancelBookingByUser - 本人キャンセル', () => {
    const slot = _getTestSlot(35);
    const createResp = _callDoPost({
      action: 'createBooking',
      bookingData: {
        lineUserId: TEST_LINE_USER_ID,
        userName: TEST_CUSTOMER_NAME,
        menuName: _getFirstMenuName(),
        duration: 30,
        startDateTime: slot,
        staffEmail: 'any',
        staffName: '',
      },
    });
    assert_(createResp.success, `予約作成失敗: ${createResp.message}`);

    const response = _callDoPost({
      action: 'cancelBookingByUser',
      lineUserId: TEST_LINE_USER_ID,
      bookingId: createResp.data.bookingId,
    });
    assert_(response.success, `success=false: ${response.message}`);
    assertEqual_(response.data.bookingId, createResp.data.bookingId, 'bookingId');

    const configs = getConfigs();
    const sheet = getReservationSheet(configs);
    const data = sheet.getDataRange().getValues();
    const h = data[0];
    const bkIdCol = h.indexOf('予約ID');
    const statusCol = h.indexOf('ステータス');
    const row = data.slice(1).find(r => r[bkIdCol] === createResp.data.bookingId);
    assert_(row, '予約行が見つからない');
    assertEqual_(row[statusCol], 'キャンセル', 'ステータス');
  }));

  // TC-B-052: rescheduleBookingByUser
  results.push(runTest_('TC-B-052: rescheduleBookingByUser - 日時変更', () => {
    const oldSlot = _getTestSlot(42);
    const newSlot = _getTestSlot(43);
    const createResp = _callDoPost({
      action: 'createBooking',
      bookingData: {
        lineUserId: TEST_LINE_USER_ID,
        userName: TEST_CUSTOMER_NAME,
        menuName: _getFirstMenuName(),
        duration: 30,
        startDateTime: oldSlot,
        staffEmail: 'any',
        staffName: '',
      },
    });
    assert_(createResp.success, `予約作成失敗: ${createResp.message}`);

    const response = _callDoPost({
      action: 'rescheduleBookingByUser',
      lineUserId: TEST_LINE_USER_ID,
      bookingId: createResp.data.bookingId,
      newStartDateTime: newSlot,
    });
    assert_(response.success, `success=false: ${response.message}`);
    assertEqual_(response.data.bookingId, createResp.data.bookingId, 'bookingId');
    assert_(response.data.startTime, 'startTimeが空');

    const configs = getConfigs();
    const sheet = getReservationSheet(configs);
    const data = sheet.getDataRange().getValues();
    const h = data[0];
    const bkIdCol = h.indexOf('予約ID');
    const startCol = h.indexOf('予約日時');
    const row = data.slice(1).find(r => r[bkIdCol] === createResp.data.bookingId);
    assert_(row, '予約行が見つからない');
    const savedStart = new Date(row[startCol]).toISOString();
    assertEqual_(savedStart, new Date(newSlot).toISOString(), '予約日時');
  }));

  // TC-B-053: getAvailableSlots - excludeBookingId（予約変更UI用）
  results.push(runTest_('TC-B-053: getAvailableSlots - excludeBookingId', () => {
    const configs = getConfigs();
    const slot = _getTestSlot(45);
    const slotDate = new Date(slot);
    const dateStr = Utilities.formatDate(slotDate, 'JST', 'yyyy-MM-dd');
    const staffEmail = configs.isStaffFeatureEnabled && configs.staffs && configs.staffs.length > 0
      ? configs.staffs[0].email
      : null;

    const createResp = _callDoPost({
      action: 'createBooking',
      bookingData: {
        lineUserId: TEST_LINE_USER_ID,
        userName: TEST_CUSTOMER_NAME,
        menuName: _getFirstMenuName(),
        duration: 30,
        startDateTime: slot,
        staffEmail: staffEmail || 'any',
        staffName: staffEmail ? configs.staffs[0].name : '',
      },
    });
    assert_(createResp.success, `予約作成失敗: ${createResp.message}`);

    const withoutExclude = _callDoPost({
      action: 'getAvailableSlots',
      date: dateStr,
      duration: 30,
      staffEmail: staffEmail,
    });
    assert_(withoutExclude.success, withoutExclude.message);
    assert_(
      !(withoutExclude.data[dateStr] || []).includes('14:00'),
      '通常取得: 自分の予約時刻が空きとして返された'
    );

    const withExclude = _callDoPost({
      action: 'getAvailableSlots',
      date: dateStr,
      duration: 30,
      staffEmail: staffEmail,
      excludeBookingId: createResp.data.bookingId,
    });
    assert_(withExclude.success, withExclude.message);
    assert_(
      (withExclude.data[dateStr] || []).includes('14:00'),
      'excludeBookingId指定: 自分の予約時刻が空きとして返されない'
    );
  }));

  // TC-B: 無効なアクション
  results.push(runTest_('TC-B-999: 無効なアクション', () => {
    const response = _callDoPost({ action: 'invalidAction_xyz' });
    assert_(!response.success, 'success=trueが返った（無効なアクションでエラーになるべき）');
    assertContains_(response.message, '無効', 'エラーメッセージに「無効」が含まれない');
  }));

  return results;
}

// =================================================================
// セキュリティ API テスト（LINE ID Token 検証）
// =================================================================

function runSecurityTests_() {
  Logger.log('\n--- セキュリティ API テスト ---');
  const results = [];

  results.push(runTest_('TC-SEC-001: 移行モード（lineLoginChannelId 未設定）', () => {
    const configs = getConfigs();
    if (isLineIdTokenVerificationEnabled_(configs)) {
      Logger.log('  skip: lineLoginChannelId が設定済み');
      return;
    }
    const response = _callDoPost({ action: 'getInitData', lineUserId: TEST_LINE_USER_ID });
    assert_(response.success, `success=false: ${response.message}`);
  }));

  results.push(runTest_('TC-SEC-002: ID Token 欠落時は拒否（channel 設定時）', () => {
    const configs = getConfigs();
    if (!isLineIdTokenVerificationEnabled_(configs)) {
      Logger.log('  skip: lineLoginChannelId 未設定');
      return;
    }
    const response = _callDoPost({ action: 'getInitData', lineUserId: TEST_LINE_USER_ID });
    assert_(!response.success, 'idToken なしで success=true');
    assertEqual_(response.code, 'LINE_AUTH_FAILED', 'エラーコード');
  }));

  results.push(runTest_('TC-SEC-003: 偽 idToken は拒否（channel 設定時）', () => {
    const configs = getConfigs();
    if (!isLineIdTokenVerificationEnabled_(configs)) {
      Logger.log('  skip: lineLoginChannelId 未設定');
      return;
    }
    const response = _callDoPost({
      action: 'getInitData',
      lineUserId: TEST_LINE_USER_ID,
      idToken: 'invalid.test.token',
    });
    assert_(!response.success, '偽 idToken で success=true');
    assertEqual_(response.code, 'LINE_AUTH_FAILED', 'エラーコード');
  }));

  return results;
}

// =================================================================
// ロジック テスト
// =================================================================

function runLogicTests_() {
  Logger.log('\n--- ロジック テスト ---');
  const results = [];

  // TC-L-001: 満席タイムテーブル更新（updateTimetableSlots_）
  results.push(runTest_('TC-L-001: updateTimetableSlots_ - スロット追加', () => {
    const sheet = getSpreadsheet_().getSheetByName('満席タイムテーブル');
    if (!sheet) {
      Logger.log('    (満席タイムテーブルシートなしのためスキップ)');
      return;
    }
    const rowsBefore = sheet.getLastRow();
    const testDate = new Date(_getTestSlot(35));
    updateTimetableSlots_(testDate, new Date(testDate.getTime() + 30 * 60000), 30);
    const rowsAfter = sheet.getLastRow();
    assert_(rowsAfter >= rowsBefore, 'スロット追加後に行数が減少した');
  }));

  // TC-L-001b: 予約シートから満席タイムテーブル再構築
  results.push(runTest_('TC-L-001b: rebuildTimetableFromReservations_ - 予約数集計', () => {
    const sheet = getSpreadsheet_().getSheetByName('満席タイムテーブル');
    if (!sheet) {
      Logger.log('    (満席タイムテーブルシートなしのためスキップ)');
      return;
    }
    rebuildTimetableFromReservations_();
    const slotMap = readTimetableSlotMap_(sheet);
    assert_(slotMap instanceof Map, 'slotMap が Map ではない');
  }));

  // TC-L-002: 顧客検索
  results.push(runTest_('TC-L-002: findCustomerByUserId_ - 登録済みユーザー', () => {
    const customer = findCustomerByUserId_(TEST_LINE_USER_ID);
    assert_(customer !== null, `顧客が見つからない: ${TEST_LINE_USER_ID}`);
    assertEqual_(customer['LINE User ID'], TEST_LINE_USER_ID, 'LINE User ID');
  }));

  // TC-L-003: 顧客検索 - 未登録ユーザー
  results.push(runTest_('TC-L-003: findCustomerByUserId_ - 未登録ユーザー', () => {
    const customer = findCustomerByUserId_('never_registered_user_xyz_12345');
    assert_(customer === null, 'nullでない（登録されていないはず）');
  }));

  // TC-L-003b: 当日予約案内文の正規化
  results.push(runTest_('TC-L-003b: normalizeAlternateBookingGuide_ - 100文字制限', () => {
    assertEqual_(normalizeAlternateBookingGuide_('  案内文  '), '案内文', 'trim');
    assertEqual_(normalizeAlternateBookingGuide_('a'.repeat(120)).length, 100, '最大100文字');
    assertEqual_(normalizeAlternateBookingGuide_(null), '', 'null');
  }));

  // TC-L-003c: public Config サブセット（秘密情報除外）
  results.push(runTest_('TC-L-003c: buildPublicConfigSubset_ - 秘密情報除外', () => {
    const subset = buildPublicConfigSubset_({
      shopName: 'テスト店',
      lineChannelAccessToken: 'secret-token',
      lineChannelSecret: 'secret',
      serviceMenus: [{ name: 'カット', duration: 60 }],
    });
    assertEqual_(subset.shopName, 'テスト店', 'shopName');
    assert_(subset.lineChannelAccessToken === undefined, 'lineChannelAccessToken が含まれている');
    assert_(subset.lineChannelSecret === undefined, 'lineChannelSecret が含まれている');
    assert_(Array.isArray(subset.serviceMenus), 'serviceMenus');
  }));

  // TC-L-003d: 必須シートヘッダー検証
  results.push(runTest_('TC-L-003d: validateRequiredSheetHeaders_ - 予約シート', () => {
    validateRequiredSheetHeaders_(['reservation']);
  }));

  // TC-L-003e: ScriptCache 無効化
  results.push(runTest_('TC-L-003e: invalidateScriptCaches_ - 例外なし', () => {
    invalidateScriptCaches_();
  }));

  // TC-L-003g: 1時間前リマインド窓（分単位・45〜75分前）
  results.push(runTest_('TC-L-003g: isHourReminderWindowMatch_ - 境界', () => {
    const appt = new Date(2026, 5, 27, 15, 30, 0);
    assert_(isHourReminderWindowMatch_(new Date(2026, 5, 27, 14, 30, 44), appt),
      '14:30:44 実行で 15:30 予約は対象');
    assert_(isHourReminderWindowMatch_(new Date(2026, 5, 27, 14, 15, 59), appt),
      '14:15 実行で 15:30 予約は対象');
    assert_(!isHourReminderWindowMatch_(new Date(2026, 5, 27, 15, 0, 0), appt),
      '15:00 実行（30分前）は対象外');
    assert_(!isHourReminderWindowMatch_(new Date(2026, 5, 27, 13, 30, 0), appt),
      '13:30 実行（120分前）は対象外');
  }));

  // TC-L-003f: 顧客検索キャッシュ
  results.push(runTest_('TC-L-003f: findCustomerByUserId_ - ScriptCache', () => {
    const uniqueId = 'test_cust_cache_' + new Date().getTime();
    registerCustomer(uniqueId, TEST_CUSTOMER_NAME, '女性', '30代');
    const first = findCustomerByUserId_(uniqueId);
    assert_(first !== null, '顧客が見つからない');
    assertEqual_(first['顧客名'], TEST_CUSTOMER_NAME, '顧客名');
    const second = findCustomerByUserId_(uniqueId);
    assert_(second !== null, 'キャッシュヒット後に顧客が見つからない');
    invalidateCustomerLookupCache_(uniqueId);
    const third = findCustomerByUserId_(uniqueId);
    assert_(third !== null, 'purge 後に顧客が見つからない');
  }));

  // TC-L-003g: registerCustomer 後のキャッシュ purge
  results.push(runTest_('TC-L-003g: registerCustomer - キャッシュ purge', () => {
    const uniqueId = 'test_cust_purge_' + new Date().getTime();
    registerCustomer(uniqueId, TEST_CUSTOMER_NAME, '女性', '30代');
    findCustomerByUserId_(uniqueId);
    const again = registerCustomer(uniqueId, TEST_CUSTOMER_NAME, '女性', '30代');
    assert_(again !== null, '再登録（べき等）が失敗');
    assertEqual_(again['ステータス'], '有効', 'ステータス');
  }));

  // TC-L-003h: トリガー自動設定（冪等）
  results.push(runTest_('TC-L-003h: ensureTriggersConfigured_ - 冪等実行', () => {
    const first = ensureTriggersConfigured_();
    assert_(first.success !== false, '1回目が失敗: ' + (first.message || ''));
    const second = ensureTriggersConfigured_();
    assert_(second.success !== false, '2回目が失敗');
    assert_(second.skipped === true, '2回目は skipped であるべき');
  }));

  // TC-L-004: 予約ID生成の一意性
  results.push(runTest_('TC-L-004: generateBookingId - 一意性', () => {
    const ids = new Set();
    for (let i = 0; i < 50; i++) {
      ids.add(generateBookingId());
      Utilities.sleep(1);
    }
    assertEqual_(ids.size, 50, '重複した予約IDが生成された');
  }));

  // TC-L-005: getBlockCalendarIds_ - 担当者機能OFF
  results.push(runTest_('TC-L-005: getBlockCalendarIds_ - 担当者機能OFF', () => {
    const mockConfigs = {
      isStaffFeatureEnabled: false,
      block_input_calendar_id: 'test_cal_id_123',
      staff_block_calendar_id_map: {}
    };
    const ids = getBlockCalendarIds_(mockConfigs, null, false);
    assertEqual_(ids.length, 1, 'カレンダーID数');
    assertEqual_(ids[0], 'test_cal_id_123', 'カレンダーID');
  }));

  // TC-L-006: getBlockCalendarIds_ - 担当者指名あり
  results.push(runTest_('TC-L-006: getBlockCalendarIds_ - 担当者指名あり', () => {
    const mockConfigs = {
      isStaffFeatureEnabled: true,
      block_input_calendar_id: 'shared_cal',
      staff_block_calendar_id_map: { 'staff@example.com': 'staff_cal_id' }
    };
    const ids = getBlockCalendarIds_(mockConfigs, 'staff@example.com', true);
    assertEqual_(ids.length, 2, 'カレンダーID数');
    assertEqual_(ids[0], 'shared_cal', 'カレンダーID（店舗共有）');
    assertEqual_(ids[1], 'staff_cal_id', 'カレンダーID（担当者個別）');
  }));

  // TC-L-006b: resolveStaffBlockCalendarId_ - メール大文字小文字差異
  results.push(runTest_('TC-L-006b: resolveStaffBlockCalendarId_ - 大文字小文字', () => {
    const map = { 'Staff@Example.com': 'staff_cal_id' };
    assertEqual_(resolveStaffBlockCalendarId_(map, 'staff@example.com'), 'staff_cal_id', 'カレンダーID');
  }));

  // TC-L-006c: getAllBlockCalendarIds_ - 全カレンダー収集
  results.push(runTest_('TC-L-006c: getAllBlockCalendarIds_ - 全カレンダー', () => {
    const mockConfigs = {
      isStaffFeatureEnabled: true,
      block_input_calendar_id: 'shared_cal',
      staff_block_calendar_id_map: {
        'staff1@example.com': 'staff1_cal',
        'staff2@example.com': 'staff2_cal'
      }
    };
    const ids = getAllBlockCalendarIds_(mockConfigs);
    assertEqual_(ids.length, 3, 'カレンダーID数');
    assertEqual_(ids.includes('shared_cal'), true, '店舗共有');
    assertEqual_(ids.includes('staff2_cal'), true, '担当者2');
  }));

  // TC-L-007: getBlockCalendarIds_ - 担当者指名なし（担当者機能ON）
  results.push(runTest_('TC-L-007: getBlockCalendarIds_ - 担当者指名なし（担当者機能ON）', () => {
    const mockConfigs = {
      isStaffFeatureEnabled: true,
      block_input_calendar_id: 'shared_cal',
      staff_block_calendar_id_map: { 'staff@example.com': 'staff_cal_id' }
    };
    const ids = getBlockCalendarIds_(mockConfigs, 'any', false);
    assertEqual_(ids.length, 1, 'カレンダーID数');
    assertEqual_(ids[0], 'shared_cal', 'カレンダーID（共有）');
  }));

  // TC-L-008: getConfigs - 必須キーの確認
  results.push(runTest_('TC-L-008: getConfigs - 必須キーの存在確認', () => {
    const configs = getConfigs();
    const requiredKeys = ['bookingTimeUnit', 'maxConcurrentBookings', 'maxBulkBookings'];
    requiredKeys.forEach(key => {
      assert_(configs[key] !== undefined, `設定キー「${key}」が見つからない`);
    });
  }));

  // TC-L-009: 定休日判定
  results.push(runTest_('TC-L-009: isWeeklyHoliday_ - 定休日判定', () => {
    const saturday = new Date('2026-06-20T12:00:00');
    assert_(isWeeklyHoliday_(saturday, [6]) === true, '土曜が定休日');
    assert_(isWeeklyHoliday_(saturday, [0, 1]) === false, '土曜は日・月定休ではない');
    assert_(isWeeklyHoliday_(saturday, []) === false, '定休日未設定');
  }));

  // TC-L-010: 非稼働時間判定
  results.push(runTest_('TC-L-010: isSlotInNonOperatingHours_ - 昼休み', () => {
    const periods = [{ start: '12:00', end: '13:00' }];
    assert_(isSlotInNonOperatingHours_('2026-06-19', '12:00', periods) === true, '12:00は非稼働');
    assert_(isSlotInNonOperatingHours_('2026-06-19', '12:30', periods) === true, '12:30は非稼働');
    assert_(isSlotInNonOperatingHours_('2026-06-19', '11:00', periods) === false, '11:00は稼働');
    assert_(isSlotInNonOperatingHours_('2026-06-19', '13:00', periods) === false, '13:00は稼働（終了時刻は含まない）');
    assert_(isSlotInNonOperatingHours_('2026-06-19', '12:00', []) === false, '非稼働時間未設定');
  }));

  return results;
}

// =================================================================
// バッチ処理 テスト
// =================================================================

function runBatchTests_() {
  Logger.log('\n--- バッチ処理 テスト ---');
  const results = [];

  // TC-BG-001: runNightlyBatch（エラーなし完了確認）
  results.push(runTest_('TC-BG-001: runNightlyBatch - 正常完了', () => {
    try {
      runNightlyBatch();
    } catch (e) {
      throw new Error(`runNightlyBatch でエラーが発生: ${e.message}`);
    }
  }));

  // TC-BG-002: setupTriggers（エラーなし完了確認）
  // 注意: このテストはトリガーを削除・再作成します
  // results.push(runTest_('TC-BG-002: setupTriggers - トリガー設定', () => {
  //   const result = setupTriggers();
  //   assert_(result.success, 'setupTriggersが失敗した');
  // }));

  // TC-BG-003: logError_ - エラーログ記録
  results.push(runTest_('TC-BG-003: logError_ - エラーログ記録', () => {
    const testError = new Error('テスト用エラーメッセージ');
    logError_('testFunction_auto', testError);

    const logs = getErrorLogs();
    const found = logs.some(log => log.functionName === 'testFunction_auto');
    assert_(found, 'エラーログに記録されていない');
  }));

  // TC-BG-003b: logErrorIfSystem_ - 想定内ユーザー向けエラーは記録しない
  results.push(runTest_('TC-BG-003b: logErrorIfSystem_ - 想定内エラーは記録しない', () => {
    logErrorIfSystem_('testUserError_skip', new Error('申し訳ありません。タッチの差で 10:00 の枠が埋まってしまいました。'));
    const logs = getErrorLogs();
    const found = logs.some(log => log.functionName === 'testUserError_skip');
    assert_(!found, '想定内エラーがエラーログに記録された');
  }));

  // TC-BG-004: cleanPastTimetable_（過去エントリ削除）
  results.push(runTest_('TC-BG-004: cleanPastTimetable_ - 過去エントリ削除', () => {
    const sheet = getSpreadsheet_().getSheetByName('満席タイムテーブル');
    if (!sheet) {
      Logger.log('    (満席タイムテーブルシートなしのためスキップ)');
      return;
    }

    // 過去日付のテストデータを1行追加
    sheet.appendRow(['2020-01-01', '10:00', 99]);
    const rowsBefore = sheet.getLastRow();

    const today = new Date();
    today.setHours(0, 0, 0, 0);
    cleanPastTimetable_(today);

    const rowsAfter = sheet.getLastRow();
    assert_(rowsAfter < rowsBefore, '過去エントリが削除されなかった');
  }));

  return results;
}

// =================================================================
// エラーログ統合テスト（logError_ 拡張箇所）
// =================================================================

/**
 * logError_ 拡張箇所の統合テストのみ実行（テストデータ作成・復旧・ログ検証込み）。
 * GAS エディタまたは doPost action: runErrorLogTests から呼び出す。
 * @returns {{summary: Object, results: Object[]}}
 */
function runErrorLogTests() {
  Logger.log('========================================');
  Logger.log('  エラーログ統合テスト 開始');
  Logger.log('========================================');

  cleanupTestData_();
  const errorReportProps = PropertiesService.getScriptProperties();
  errorReportProps.setProperty('errorReportDisabled', 'true');
  const startTime = new Date();
  let results;
  try {
    results = runErrorLogIntegrationTests_();
  } finally {
    errorReportProps.deleteProperty('errorReportDisabled');
    if (typeof setErrorReportNotifyHookForTests_ === 'function') {
      setErrorReportNotifyHookForTests_(null);
    }
  }
  const endTime = new Date();

  const passed = results.filter(r => r.passed).length;
  const failed = results.filter(r => !r.passed);
  const elapsed = Math.round((endTime - startTime) / 1000);
  const summary = {
    total: results.length,
    passed: passed,
    failed: failed.length,
    elapsedSec: elapsed,
    executedAt: startTime.toISOString(),
  };

  Logger.log('----------------------------------------');
  Logger.log(`エラーログ統合テスト: ${passed} / ${results.length} 件 合格（${elapsed}秒）`);
  if (failed.length > 0) {
    failed.forEach(r => Logger.log(`  ✗ ${r.name}: ${r.error}`));
  }
  Logger.log('========================================');

  saveTestResults_(summary, results);
  cleanupTestData_();

  return { summary, results };
}

function runErrorLogIntegrationTests_() {
  Logger.log('\n--- エラーログ統合テスト ---');
  const errorLogStartRow = _errorLogRowCount_();
  const results = [];

  results.push(runTest_('TC-EL-001: syncBlockCalendars - シート欠落', () => {
    _withSheetRenamed_('ブロック予定同期', '_TC_EL_blockSync', () => {
      const countBefore = _errorLogRowCount_();
      syncBlockCalendars();
      assertNewErrorLogged_(countBefore, 'syncBlockCalendars', 'ブロック予定同期');
    });
  }));

  results.push(runTest_('TC-EL-002: validateRequiredSheetHeaders_ - 列欠落', () => {
    _withColumnRenamed_('予約', '予約ID', '_TC_EL_予約ID', () => {
      const countBefore = _errorLogRowCount_();
      try {
        validateRequiredSheetHeaders_(['reservation']);
      } catch (e) { /* 期待どおり */ }
      assertNewErrorLogged_(countBefore, 'validateRequiredSheetHeaders_', '予約ID');
    });
  }));

  results.push(runTest_('TC-EL-003: createEndOfDayUnconfirmedEvent - 無効カレンダー', () => {
    const today = new Date();
    today.setHours(14, 0, 0, 0);
    const seeded = _seedTestBookingRow_({ startTime: today, status: '予約' });
    _withConfigBackup_('reservationCalendarId', '__TC_EL_invalid_calendar__', () => {
      const countBefore = _errorLogRowCount_();
      createEndOfDayUnconfirmedEvent();
      assertNewErrorLogged_(countBefore, 'createEndOfDayUnconfirmedEvent');
    });
    _deleteBookingRow_(seeded.rowNum);
  }));

  results.push(runTest_('TC-EL-004: sendDayBeforeReminders - LINE API 失敗', () => {
    const configs = getConfigs();
    if (configs.reminderMode !== 'LINE') {
      Logger.log('    (reminderMode!=LINE のためスキップ)');
      return;
    }
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    tomorrow.setHours(12, 0, 0, 0);
    const end = new Date(tomorrow.getTime() + 60 * 60000);
    const seeded = _seedTestBookingRow_({
      startTime: tomorrow,
      endTime: end,
      lineUserId: 'test_el_day_' + Date.now(),
    });
    _withConfigBackup_('lineChannelAccessToken', '__TC_EL_invalid_token__', () => {
      const countBefore = _errorLogRowCount_();
      sendDayBeforeReminders();
      assertNewErrorLogged_(countBefore, 'sendDayBeforeReminders');
    });
    _deleteBookingRow_(seeded.rowNum);
  }));

  results.push(runTest_('TC-EL-005: sendHourBeforeReminders - LINE API 失敗', () => {
    const configs = getConfigs();
    if (configs.reminderMode !== 'LINE') {
      Logger.log('    (reminderMode!=LINE のためスキップ)');
      return;
    }
    const start = new Date(Date.now() + 65 * 60000);
    start.setSeconds(0, 0);
    const end = new Date(start.getTime() + 60 * 60000);
    const seeded = _seedTestBookingRow_({
      startTime: start,
      endTime: end,
      lineUserId: 'test_el_hour_' + Date.now(),
    });
    _withConfigBackup_('lineChannelAccessToken', '__TC_EL_invalid_token__', () => {
      const countBefore = _errorLogRowCount_();
      sendHourBeforeReminders();
      assertNewErrorLogged_(countBefore, 'sendHourBeforeReminders');
    });
    _deleteBookingRow_(seeded.rowNum);
  }));

  results.push(runTest_('TC-EL-006: runDailyArchive - 無効アーカイブ先', () => {
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    yesterday.setHours(10, 0, 0, 0);
    const end = new Date(yesterday.getTime() + 60 * 60000);
    const seeded = _seedTestBookingRow_({ startTime: yesterday, endTime: end, status: '来店' });
    _withConfigBackup_('archiveSpreadsheetId', '__TC_EL_invalid_archive__', () => {
      const countBefore = _errorLogRowCount_();
      runDailyArchive();
      assertNewErrorLogged_(countBefore, 'getOrCreateArchiveSpreadsheet_', 'archiveSpreadsheetId');
    });
    _deleteBookingRow_(seeded.rowNum);
  }));

  results.push(runTest_('TC-EL-007: createBooking:calendarCreate - 無効カレンダー', () => {
    _withConfigBackup_('reservationCalendarId', '__TC_EL_invalid_calendar__', () => {
      const countBefore = _errorLogRowCount_();
      try {
        createBooking(_buildTestBookingData_({ startDateTime: _getTestSlot(21) }));
        throw new Error('createBooking がエラーにならなかった');
      } catch (e) {
        if (e.message === 'createBooking がエラーにならなかった') throw e;
      }
      assertNewErrorLogged_(countBefore, 'createBooking:calendarCreate');
    });
  }));

  results.push(runTest_('TC-EL-008: confirmBookingStatus - カレンダー不整合', () => {
    const seeded = _seedTestBookingRow_({
      startTime: _getTodayAt_(14, 0),
      status: '予約',
      eventId: '__TC_EL_invalid_event__',
    });
    const countBefore = _errorLogRowCount_();
    try {
      confirmBookingStatus(seeded.bookingId, 'キャンセル');
      throw new Error('confirmBookingStatus がエラーにならなかった');
    } catch (e) {
      if (e.message === 'confirmBookingStatus がエラーにならなかった') throw e;
    }
    assertNewErrorLogged_(countBefore, 'confirmBookingStatus', seeded.bookingId);
    _deleteBookingRow_(seeded.rowNum);
  }));

  results.push(runTest_('TC-EL-009: createBooking - 想定内エラーは記録しない', () => {
    const configs = getConfigs();
    if (!configs.isStaffFeatureEnabled || !configs.staffs || !configs.staffs.length) {
      Logger.log('    (担当者機能OFFのためスキップ)');
      return;
    }
    const slot = _getTestSlot(28);
    const staff = configs.staffs[0];
    const bookingData = {
      lineUserId: 'test_el_full_' + Date.now(),
      userName: TEST_CUSTOMER_NAME,
      menuName: _getFirstMenuName(),
      duration: 30,
      startDateTime: slot,
      staffEmail: staff.email,
      staffName: staff.name,
    };
    const result1 = createBooking(bookingData);
    assert_(result1 && result1.bookingId, '1件目の予約が失敗');
    const countBefore = _errorLogRowCount_();
    try {
      createBooking(bookingData);
      throw new Error('満席スロットへの2件目が成功してしまった');
    } catch (e) {
      if (e.message === '満席スロットへの2件目が成功してしまった') throw e;
      assertContains_(e.message, '申し訳ありません', '想定内エラーメッセージ');
    }
    assertNewErrorNotLogged_(countBefore, 'createBooking');
    assertNewErrorNotLogged_(countBefore, 'createBooking:calendarCreate');
  }));

  results.push(runTest_('TC-EL-010: logErrorIfSystem_ - 想定内エラーは記録しない', () => {
    const countBefore = _errorLogRowCount_();
    logErrorIfSystem_('TC_EL_user_skip', new Error('申し訳ありません。タッチの差で 10:00 の枠が埋まってしまいました。'));
    assertNewErrorNotLogged_(countBefore, 'TC_EL_user_skip');
  }));

  results.push(runTest_('TC-EL-011: isErrorReportEnabled_ - secret / disabled フラグ', () => {
    const props = PropertiesService.getScriptProperties();
    const hadDisabled = props.getProperty('errorReportDisabled');
    props.deleteProperty('errorReportDisabled');
    try {
      if (_ERROR_REPORT_SECRET === 'PLACEHOLDER_ERROR_REPORT_SECRET') {
        assert_(!isErrorReportEnabledForTests_(), 'プレースホルダ secret 時は無効');
      } else {
        assert_(isErrorReportEnabledForTests_(), 'secret 注入済みでは有効');
        props.setProperty('errorReportDisabled', 'true');
        assert_(!isErrorReportEnabledForTests_(), 'errorReportDisabled=true で無効');
      }
    } finally {
      if (hadDisabled) props.setProperty('errorReportDisabled', hadDisabled);
      else props.deleteProperty('errorReportDisabled');
    }
  }));

  results.push(runTest_('TC-EL-012: logError_ - notify フックが呼ばれる', () => {
    let invoked = false;
    setErrorReportNotifyHookForTests_(function(fn, err) {
      invoked = true;
      assert_(fn === 'TC-EL-012-notify', 'functionName が一致しない');
      assert_(err instanceof Error, 'Error オブジェクトが渡される');
    });
    try {
      const countBefore = _errorLogRowCount_();
      logError_('TC-EL-012-notify', new Error('notify hook test'));
      assert_(invoked, 'notify フックが呼ばれなかった');
      assertNewErrorLogged_(countBefore, 'TC-EL-012-notify', 'notify hook test');
    } finally {
      setErrorReportNotifyHookForTests_(null);
    }
  }));

  results.push(runTest_('TC-EL-013: logError_ - notify 失敗でもシート記録は成功', () => {
    setErrorReportNotifyHookForTests_(function() {
      throw new Error('simulated notify failure');
    });
    try {
      const countBefore = _errorLogRowCount_();
      logError_('TC-EL-013-notify-fail', new Error('sheet must succeed'));
      assertNewErrorLogged_(countBefore, 'TC-EL-013-notify-fail', 'sheet must succeed');
    } finally {
      setErrorReportNotifyHookForTests_(null);
    }
  }));

  _cleanupErrorLogsAddedSince_(errorLogStartRow);
  return results;
}

// =================================================================
// 性能テスト
// =================================================================

/**
 * 性能計測専用のテストランナー。
 * fn() は { avg, max, count } を返す必要がある。
 * 計測結果をテスト名に付加してシートに保存する。
 * @param {string} name
 * @param {Function} fn  - 計測を行い { avg, max, count } を返す関数
 * @returns {{name, passed, error, metrics}}
 */
function runPerfTest_(name, fn) {
  try {
    const metrics = fn();
    const displayName = `${name} [avg:${metrics.avg}ms / max:${metrics.max}ms]`;
    Logger.log(`  ✓ ${displayName}`);
    return { name: displayName, passed: true, metrics };
  } catch (e) {
    Logger.log(`  ✗ ${name}: ${e.message}`);
    return { name, passed: false, error: e.message };
  }
}

/**
 * 性能テストスイート。
 * GASの制約（逐次処理・スプレッドシートI/O）を前提に現実的な閾値を設定する。
 *
 * 計測対象: getAvailableSlots / createBooking / 連続予約スループット
 * 閾値:
 *   - getAvailableSlots: 平均 5,000ms 以内
 *   - createBooking:     平均 8,000ms 以内
 *   - 連続5件スループット: 全件エラーなし完了
 */
function runPerformanceTests_() {
  Logger.log('\n--- 性能テスト ---');
  const results = [];

  // TC-P-001: getAvailableSlots 応答時間（5回計測）
  results.push(runPerfTest_('TC-P-001: getAvailableSlots 応答時間（5回平均 ≤5秒）', () => {
    const THRESHOLD_MS = 5000;
    const ITERATIONS   = 5;
    const times        = [];

    for (let i = 0; i < ITERATIONS; i++) {
      const futureDate = _getFutureWeekdayDate(7 + i);
      const t0         = Date.now();
      const resp       = _callDoPost({ action: 'getAvailableSlots', date: futureDate, duration: 60, staffEmail: null });
      const elapsed    = Date.now() - t0;

      assert_(resp.success, `${i + 1}回目 失敗: ${resp.message}`);
      times.push(elapsed);
      Logger.log(`      ${i + 1}回目: ${elapsed}ms`);
    }

    const avg = Math.round(times.reduce((a, b) => a + b, 0) / times.length);
    const max = Math.max(...times);
    Logger.log(`      平均: ${avg}ms / 最大: ${max}ms`);
    assert_(avg <= THRESHOLD_MS, `平均応答時間 ${avg}ms が閾値 ${THRESHOLD_MS}ms を超過`);

    return { avg, max, count: ITERATIONS };
  }));

  // TC-P-002: createBooking 応答時間（5回計測）
  // ※ テストスロットは day40〜44 の 10:00 を使用（他テストと重複しない）
  results.push(runPerfTest_('TC-P-002: createBooking 応答時間（5回平均 ≤8秒）', () => {
    const THRESHOLD_MS = 8000;
    const ITERATIONS   = 5;
    const times        = [];
    const base         = {
      lineUserId: TEST_LINE_USER_ID,
      userName:   TEST_CUSTOMER_NAME,
      menuName:   _getFirstMenuName(),
      duration:   30,
      staffEmail: 'any',
      staffName:  ''
    };

    for (let i = 0; i < ITERATIONS; i++) {
      const slot    = _getPerfTestSlot(40 + i);
      const t0      = Date.now();
      const resp    = _callDoPost({ action: 'createBooking', bookingData: { ...base, startDateTime: slot } });
      const elapsed = Date.now() - t0;

      assert_(resp.success, `${i + 1}回目 失敗: ${resp.message}`);
      times.push(elapsed);
      Logger.log(`      ${i + 1}回目: ${elapsed}ms`);
    }

    const avg = Math.round(times.reduce((a, b) => a + b, 0) / times.length);
    const max = Math.max(...times);
    Logger.log(`      平均: ${avg}ms / 最大: ${max}ms`);
    assert_(avg <= THRESHOLD_MS, `平均応答時間 ${avg}ms が閾値 ${THRESHOLD_MS}ms を超過`);

    return { avg, max, count: ITERATIONS };
  }));

  // TC-P-003: 連続予約5件スループット（エラーゼロ確認）
  // ※ テストスロットは day45〜49 の 10:00 を使用
  results.push(runPerfTest_('TC-P-003: 連続予約5件スループット（全件エラーなし）', () => {
    const ITERATIONS = 5;
    const base       = {
      lineUserId: TEST_LINE_USER_ID,
      userName:   TEST_CUSTOMER_NAME,
      menuName:   _getFirstMenuName(),
      duration:   30,
      staffEmail: 'any',
      staffName:  ''
    };
    const times = [];
    const t0Total = Date.now();

    for (let i = 0; i < ITERATIONS; i++) {
      const slot    = _getPerfTestSlot(45 + i);
      const t0      = Date.now();
      const resp    = _callDoPost({ action: 'createBooking', bookingData: { ...base, startDateTime: slot } });
      const elapsed = Date.now() - t0;

      assert_(resp.success, `${i + 1}件目でエラー: ${resp.message}`);
      times.push(elapsed);
      Logger.log(`      ${i + 1}件目: ${elapsed}ms`);
    }

    const totalMs = Date.now() - t0Total;
    const avg     = Math.round(times.reduce((a, b) => a + b, 0) / times.length);
    const max     = Math.max(...times);
    Logger.log(`      合計: ${totalMs}ms (平均 ${avg}ms/件)`);

    return { avg, max, count: ITERATIONS };
  }));

  results.push(runTest_('TC-P-004: keepWarm_ - 例外なし', () => {
    keepWarm_();
  }));

  return results;
}

/**
 * 性能テスト専用スロット生成（営業時間内 10:00 固定）。
 * 通常テスト(_getTestSlot=14:00)と時間帯を分けて衝突を回避する。
 */
function _getPerfTestSlot(offsetDays) {
  const d   = new Date();
  d.setDate(d.getDate() + offsetDays);
  d.setHours(10, 0, 0, 0);
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T10:00:00+09:00`;
}

// =================================================================
// テストデータクリーンアップ
// =================================================================

/**
 * テスト実行後に作成されたテストデータを削除する。
 * GASエディタから手動実行可能。
 */
function cleanupTestData_() {
  _deleteTestCustomers();
  _deleteTestBookings();
  _deleteTestErrorLogs();
  try {
    rebuildTimetableFromReservations_();
  } catch (e) {
    Logger.log('満席TT再構築スキップ: ' + e.message);
  }
}

function cleanupTestData() {
  cleanupTestData_();
  Logger.log('テストデータのクリーンアップが完了しました。');
}

function _deleteTestCustomers() {
  const sheet = getSpreadsheet_().getSheetByName('顧客マスタ');
  if (!sheet || sheet.getLastRow() < 2) return;

  const data = sheet.getDataRange().getValues();
  const h = data[0];
  const nameCol = h.indexOf('顧客名');
  const userIdCol = h.indexOf('LINE User ID');

  const rowsToDelete = [];
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][nameCol]).includes('__テスト') ||
        String(data[i][userIdCol]).startsWith('test_')) {
      rowsToDelete.push(i + 1);
    }
  }
  rowsToDelete.reverse().forEach(r => sheet.deleteRow(r));
  if (rowsToDelete.length > 0) {
    Logger.log(`顧客マスタ: ${rowsToDelete.length}件のテストデータを削除。`);
  }
}

function _deleteTestBookings() {
  const configs = getConfigs();
  const sheet = getReservationSheet(configs);
  if (sheet.getLastRow() < 2) return;

  const data = sheet.getDataRange().getValues();
  const h = data[0];
  const userIdCol = h.indexOf('LINE User ID');
  const eventIdCol = h.indexOf('イベントID');

  const rowsToDelete = [];
  for (let i = 1; i < data.length; i++) {
    const userId = String(data[i][userIdCol]);
    if (userId.startsWith('test_')) {
      // Googleカレンダーのイベントも削除
      const eventId = data[i][eventIdCol];
      if (eventId && configs.reservationCalendarId) {
        try {
          const cal = CalendarApp.getCalendarById(configs.reservationCalendarId);
          const event = cal.getEventById(eventId);
          if (event) event.deleteEvent();
        } catch (e) {
          Logger.log(`カレンダーイベント削除スキップ: ${e.message}`);
        }
      }
      rowsToDelete.push(i + 1);
    }
  }
  rowsToDelete.reverse().forEach(r => sheet.deleteRow(r));
  if (rowsToDelete.length > 0) {
    Logger.log(`予約シート: ${rowsToDelete.length}件のテストデータを削除。`);
  }
}

function _deleteTestErrorLogs() {
  const sheet = getSpreadsheet_().getSheetByName('エラーログ');
  if (!sheet || sheet.getLastRow() < 2) return;

  const data = sheet.getDataRange().getValues();
  const rowsToDelete = [];
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][1]) === 'testFunction_auto') {
      rowsToDelete.push(i + 1);
    }
  }
  rowsToDelete.reverse().forEach(r => sheet.deleteRow(r));
}

// =================================================================
// テストヘルパー関数
// =================================================================

/**
 * doPost を直接呼び出す（GASエディタ内テスト用）
 */
function _callDoPost(payload) {
  try {
    const mockE = {
      postData: {
        contents: JSON.stringify(payload)
      }
    };
    const response = doPost(mockE);
    return JSON.parse(response.getContent());
  } catch (e) {
    return { success: false, message: e.message };
  }
}

/**
 * 営業日を考慮した未来の日時文字列を返す（今日+offsetDays）
 * フォーマット: "yyyy-MM-ddTHH:mm:ss+09:00"
 */
function _getTestSlot(offsetDays) {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  d.setHours(14, 0, 0, 0); // 14:00固定（営業時間内と仮定）
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T14:00:00+09:00`;
}

/**
 * 今日から offsetDays 後の日付文字列を返す（"yyyy-MM-dd"）
 */
function _getFutureWeekdayDate(offsetDays) {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * Configから最初のメニュー名を取得する
 */
function _getFirstMenuName() {
  const configs = getConfigs();
  if (configs.serviceMenus && configs.serviceMenus.length > 0) {
    return configs.serviceMenus[0].name;
  }
  return 'テストメニュー';
}

// --- エラーログ統合テスト用ヘルパー ---

function _errorLogRowCount_() {
  const sheet = getSpreadsheet_().getSheetByName('エラーログ');
  if (!sheet || sheet.getLastRow() <= 1) return 0;
  return sheet.getLastRow() - 1;
}

function _getNewErrorLogsSince_(countBefore) {
  const sheet = getSpreadsheet_().getSheetByName('エラーログ');
  if (!sheet || sheet.getLastRow() <= 1) return [];
  return sheet.getDataRange().getValues().slice(1 + countBefore).map(function(row) {
    return { functionName: String(row[1] || ''), message: String(row[2] || '') };
  });
}

function assertNewErrorLogged_(countBefore, functionName, messagePart) {
  const newLogs = _getNewErrorLogsSince_(countBefore);
  const found = newLogs.some(function(log) {
    if (log.functionName !== functionName) return false;
    if (messagePart && log.message.indexOf(messagePart) < 0) return false;
    return true;
  });
  assert_(found, 'エラーログに ' + functionName + (messagePart ? ' / ' + messagePart : '') + ' が記録されていない');
}

function assertNewErrorNotLogged_(countBefore, functionName) {
  const newLogs = _getNewErrorLogsSince_(countBefore);
  const found = newLogs.some(function(log) {
    return log.functionName === functionName;
  });
  assert_(!found, functionName + ' がエラーログに記録された');
}

function _cleanupErrorLogsAddedSince_(countBefore) {
  const sheet = getSpreadsheet_().getSheetByName('エラーログ');
  if (!sheet || sheet.getLastRow() <= 1) return;
  const total = sheet.getLastRow() - 1;
  const toDelete = total - countBefore;
  if (toDelete > 0) {
    sheet.deleteRows(2 + countBefore, toDelete);
  }
}

function _getConfigValueFromSheet_(key) {
  const sheet = getSpreadsheet_().getSheetByName('Config');
  if (!sheet) return null;
  const data = sheet.getDataRange().getValues();
  for (let i = 1; i < data.length; i++) {
    if (data[i][0] === key) return data[i][1];
  }
  return null;
}

function _withConfigBackup_(key, tempValue, fn) {
  const original = _getConfigValueFromSheet_(key);
  updateConfigValue_(key, tempValue);
  invalidateScriptCaches_();
  try {
    fn();
  } finally {
    updateConfigValue_(key, original !== null && original !== undefined ? original : '');
    invalidateScriptCaches_();
  }
}

function _buildTestBookingData_(overrides) {
  const base = {
    lineUserId: 'test_el_' + Date.now(),
    userName: TEST_CUSTOMER_NAME,
    menuName: _getFirstMenuName(),
    duration: 30,
    startDateTime: _getTestSlot(21),
    staffEmail: 'any',
    staffName: '',
  };
  if (!overrides) return base;
  Object.keys(overrides).forEach(function(k) { base[k] = overrides[k]; });
  return base;
}

function _withSheetRenamed_(currentName, tempName, fn) {
  const ss = getSpreadsheet_();
  const sheet = ss.getSheetByName(currentName);
  if (!sheet) throw new Error('シート「' + currentName + '」が見つかりません');
  sheet.setName(tempName);
  try {
    fn();
  } finally {
    const renamed = ss.getSheetByName(tempName);
    if (renamed) renamed.setName(currentName);
  }
}

function _withColumnRenamed_(sheetName, colName, tempColName, fn) {
  const sheet = getSpreadsheet_().getSheetByName(sheetName);
  if (!sheet) throw new Error('シート「' + sheetName + '」が見つかりません');
  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  const colIdx = headers.indexOf(colName);
  if (colIdx < 0) throw new Error('列「' + colName + '」が見つかりません');
  sheet.getRange(1, colIdx + 1).setValue(tempColName);
  try {
    fn();
  } finally {
    sheet.getRange(1, colIdx + 1).setValue(colName);
  }
}

function _getTodayAt_(hour, minute) {
  const d = new Date();
  d.setHours(hour, minute, 0, 0);
  return d;
}

function _seedTestBookingRow_(options) {
  const configs = getConfigs();
  const sheet = getReservationSheet(configs);
  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  const row = new Array(headers.length).fill('');
  const bookingId = options.bookingId || ('BK_TEST_EL_' + Date.now());
  const lineUserId = options.lineUserId || ('test_el_' + Date.now());
  const startTime = options.startTime instanceof Date ? options.startTime : new Date(options.startTime);
  const endTime = options.endTime || new Date(startTime.getTime() + (options.durationMin || 60) * 60000);

  function setCol(name, val) {
    const idx = headers.indexOf(name);
    if (idx >= 0) row[idx] = val;
  }
  setCol('予約ID', bookingId);
  setCol('ステータス', options.status || '予約');
  setCol('LINE User ID', lineUserId);
  setCol('顧客名', options.customerName || '__テストEL__');
  setCol('メニュー名', options.menuName || _getFirstMenuName());
  setCol('予約日時', startTime);
  setCol('終了日時', endTime);
  setCol('イベントID', options.eventId || '');
  setCol('担当者名', options.staffName || '');
  setCol('担当者Email', options.staffEmail || 'any');

  sheet.appendRow(row);
  return {
    bookingId: bookingId,
    rowNum: sheet.getLastRow(),
    lineUserId: lineUserId,
    startTime: startTime,
    endTime: endTime,
  };
}

function _deleteBookingRow_(rowNum) {
  if (!rowNum || rowNum < 2) return;
  const configs = getConfigs();
  const sheet = getReservationSheet(configs);
  if (rowNum <= sheet.getLastRow()) {
    sheet.deleteRow(rowNum);
  }
}
