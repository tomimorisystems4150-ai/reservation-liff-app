/**
 * @fileoverview 予約管理システムのバックエンドロジック
 */

// =================================================================
// 定数定義
// =================================================================
// オンボーディング時にプロビジョニングスクリプトが実スプレッドシートIDに置換する。
// 開発環境（バインドスクリプト）ではプレースホルダーのままとなり getActiveSpreadsheet() を使用する。
const _PROVISIONED_SS_ID = 'PLACEHOLDER_SPREADSHEET_ID';

// グローバルスコープでの SpreadsheetApp 呼び出しは GAS の認証フローと競合するため、
// 遅延初期化パターンを使用する。各リクエスト内で最初のアクセス時のみ初期化される。
function getSpreadsheet_() {
  return (_PROVISIONED_SS_ID !== 'PLACEHOLDER_SPREADSHEET_ID')
    ? SpreadsheetApp.openById(_PROVISIONED_SS_ID)
    : SpreadsheetApp.getActiveSpreadsheet();
}

function getConfigSheet_() {
  const ss = getSpreadsheet_();
  if (!ss) {
    throw new Error(
      `スプレッドシート (ID: ${_PROVISIONED_SS_ID}) を開けませんでした。` +
      'システムURLが正しいか、オンボーディングが正常に完了しているか確認してください。'
    );
  }
  const sheet = ss.getSheetByName('Config');
  if (!sheet) {
    throw new Error('設定シート「Config」が見つかりません。テンプレートのコピーが正常に完了しているか確認してください。');
  }
  return sheet;
}

/**
 * GAS ランタイム権限が未承認のときに返すページ。
 * HtmlService ではなく ContentService を使う（iframe サンドボックスを回避）。
 * getAuthorizationUrl() の URL は createOAuthDialog 用のため、
 * 新しいタブではなくポップアップウィンドウで開く必要がある。
 */
function buildAuthRequiredPage_(authUrl) {
  const safeUrl = authUrl || ScriptApp.getService().getUrl();
  const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>初回セットアップ</title>
  <style>
    body{font-family:sans-serif;display:flex;justify-content:center;align-items:center;
         min-height:100vh;margin:0;background:#f5f5f5;}
    .card{background:#fff;border-radius:12px;padding:40px 32px;max-width:460px;
          text-align:center;box-shadow:0 2px 12px rgba(0,0,0,0.1);}
    h2{color:#333;margin:0 0 12px;font-size:20px;}
    p{color:#666;line-height:1.7;margin:0 0 8px;font-size:14px;}
    .btn{background:#4285f4;color:#fff;padding:14px 32px;border:none;border-radius:8px;
         font-weight:700;margin-top:20px;font-size:16px;cursor:pointer;}
    .btn:hover{background:#3367d6;}
    .note{font-size:12px;color:#999;margin-top:16px;}
    .warn{font-size:13px;color:#d32f2f;margin-top:12px;display:none;}
  </style>
</head>
<body>
  <div class="card">
    <h2>🔐 初回セットアップ</h2>
    <p>システムを利用開始するために、Google の権限確認が必要です。</p>
    <p>下のボタンをクリックし、表示された小さな画面で <strong>「許可」</strong> を選んでください。</p>
    <button id="authBtn" class="btn" type="button">権限を確認する</button>
    <p class="note" id="statusNote">許可後、画面が自動で更新されます。</p>
    <p class="warn" id="popupWarn">ポップアップがブロックされました。ブラウザの設定でポップアップを許可してから再度お試しください。</p>
  </div>
  <script>
    (function() {
      var authUrl = ${JSON.stringify(safeUrl)};
      var authWin = null;
      document.getElementById('authBtn').addEventListener('click', function() {
        authWin = window.open(authUrl, 'gasAuth', 'width=520,height=680,scrollbars=yes,resizable=yes');
        if (!authWin) {
          document.getElementById('popupWarn').style.display = 'block';
          return;
        }
        document.getElementById('statusNote').textContent = '権限確認画面を表示中です…';
        var timer = setInterval(function() {
          if (authWin.closed) {
            clearInterval(timer);
            location.reload();
          }
        }, 500);
      });
    })();
  </script>
</body>
</html>`;
  return ContentService.createTextOutput(html).setMimeType(ContentService.MimeType.HTML);
}

function escapeHtml_(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// =================================================================
// トリガー関数 (カスタムメニュー)
// =================================================================

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('▼ システム管理')
    .addItem('設定画面を開く', 'showSettingsUrl')
    .addToUi();
}

function showSettingsUrl() {
  const url = ScriptApp.getService().getUrl();
  if (url) {
    const html = `設定画面URL: <br><a href="${url}" target="_blank" rel="noopener noreferrer">${url}</a><br><br>このURLをブックマークしてご利用ください。`;
    const htmlOutput = HtmlService.createHtmlOutput(html)
      .setWidth(500)
      .setHeight(150);
    SpreadsheetApp.getUi().showModalDialog(htmlOutput, '設定画面URL');
  } else {
    SpreadsheetApp.getUi().alert('Webアプリとしてデプロイされていません。先にデプロイを実行してください。');
  }
}


// =================================================================
// Webアプリ エントリーポイント
// =================================================================

function doGet(e) {
  // ICSダウンロードは認証不要（先行処理）
  if (e && e.parameter && e.parameter.action === 'downloadICS') {
    return handleICSDownload_(e);
  }

  // GAS ランタイム権限の確認（Spreadsheet 等へのアクセス前）
  const authInfo = ScriptApp.getAuthorizationInfo(ScriptApp.AuthMode.FULL);
  if (authInfo.getAuthorizationStatus() === ScriptApp.AuthorizationStatus.REQUIRED) {
    return buildAuthRequiredPage_(authInfo.getAuthorizationUrl());
  }

  let configs;
  try {
    configs = getConfigs();
  } catch (err) {
    return HtmlService.createHtmlOutput(
      `<!DOCTYPE html><html><head><meta charset="utf-8"><title>初期化エラー</title>
      <style>body{font-family:sans-serif;padding:40px;text-align:center;background:#f5f5f5;}
      .card{background:#fff;border-radius:12px;padding:32px;max-width:480px;margin:40px auto;
            box-shadow:0 2px 12px rgba(0,0,0,0.1);}</style></head>
      <body><div class="card">
        <h2>初期化エラー</h2>
        <p style="color:#555;line-height:1.7;">${escapeHtml_(String(err.message || err))}</p>
      </div></body></html>`
    ).setTitle('初期化エラー');
  }
  const currentUser = Session.getActiveUser().getEmail();
  
  let authorizedUsers = [];
  if (configs.adminEmail) {
    authorizedUsers.push(configs.adminEmail.toLowerCase());
  }
  if (configs.isStaffFeatureEnabled && configs.staffs) {
    configs.staffs.forEach(staff => {
      if (staff.email) {
        authorizedUsers.push(staff.email.toLowerCase());
      }
    });
  }
  
  authorizedUsers = [...new Set(authorizedUsers)];

  // adminEmailが未設定の場合は初回セットアップとみなしアクセスを許可する
  // （オンボーディング直後にadminEmailが書き込まれる前のアクセスに対応）
  if (authorizedUsers.length > 0 && (!currentUser || !authorizedUsers.includes(currentUser.toLowerCase()))) {
    Logger.log(`アクセス拒否: ${currentUser} (許可リスト: ${authorizedUsers.join(', ')})`);
    return HtmlService.createTemplateFromFile('unauthorized').evaluate().setTitle('アクセスエラー');
  }

  // ページルーティング（?page=kanri で管理画面を表示）
  const page = (e && e.parameter && e.parameter.page) || 'settings';

  if (page === 'kanri') {
    const tmpl = HtmlService.createTemplateFromFile('kanri');
    tmpl.shopName    = configs.shopName || '';
    tmpl.currentUser = currentUser;
    tmpl.gasDeployUrl = ScriptApp.getService().getUrl();
    return tmpl.evaluate().setTitle('予約管理');
  }

  const template = HtmlService.createTemplateFromFile('settings');
  template.allConfigsAsJson = JSON.stringify(configs);
  template.gasDeployUrl = ScriptApp.getService().getUrl();
  template.liffPagesBase = 'https://tomimorisystems4150-ai.github.io/reservation-liff-app';
  return template.evaluate().setTitle('システム設定');
}

/**
 * 予約IDリストを受け取り、ICSファイルを返す（doGet経由）。
 * ?action=downloadICS&bookingIds=BK001,BK002 の形式でアクセスする。
 */
function handleICSDownload_(e) {
  try {
    const bookingIds = (e.parameter.bookingIds || '')
      .split(',').map(id => id.trim()).filter(Boolean);
    if (bookingIds.length === 0) {
      return ContentService.createTextOutput('予約IDが指定されていません。')
        .setMimeType(ContentService.MimeType.TEXT);
    }

    const configs = getConfigs();
    const sheet = getReservationSheet(configs);
    const data = sheet.getDataRange().getValues();
    const headers = data[0];
    const bookingIdCol  = headers.indexOf('予約ID');
    const startTimeCol  = headers.indexOf('予約日時');
    const endTimeCol    = headers.indexOf('終了日時');
    const menuNameCol   = headers.indexOf('メニュー名');
    const userNameCol   = headers.indexOf('顧客名');

    const formatICSDate = (date) =>
      Utilities.formatDate(date instanceof Date ? date : new Date(date), 'UTC', "yyyyMMdd'T'HHmmss'Z'");
    const now = formatICSDate(new Date());

    const lines = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//ReservationSystem//JP',
      'CALSCALE:GREGORIAN',
      'METHOD:PUBLISH'
    ];

    let found = 0;
    bookingIds.forEach(bookingId => {
      const row = data.find((r, i) => i > 0 && r[bookingIdCol] === bookingId);
      if (!row) return;
      found++;
      lines.push(
        'BEGIN:VEVENT',
        `UID:${bookingId}@reservation-system`,
        `DTSTAMP:${now}`,
        `DTSTART:${formatICSDate(row[startTimeCol])}`,
        `DTEND:${formatICSDate(row[endTimeCol])}`,
        `SUMMARY:【${row[userNameCol]}様】${row[menuNameCol]}`,
        `DESCRIPTION:店舗: ${configs.shopName}\\nご予約ありがとうございます。`,
        'BEGIN:VALARM',
        'TRIGGER:-PT1H',
        'ACTION:DISPLAY',
        'DESCRIPTION:ご予約の1時間前です',
        'END:VALARM',
        'END:VEVENT'
      );
    });

    if (found === 0) {
      return ContentService.createTextOutput('該当する予約が見つかりませんでした。')
        .setMimeType(ContentService.MimeType.TEXT);
    }

    lines.push('END:VCALENDAR');
    return ContentService.createTextOutput(lines.join('\r\n'))
      .setMimeType(ContentService.MimeType.ICAL);

  } catch (err) {
    Logger.log(`ICSダウンロードエラー: ${err.message}`);
    return ContentService.createTextOutput(`エラー: ${err.message}`)
      .setMimeType(ContentService.MimeType.TEXT);
  }
}

function doPost(e) {
  try {
    const postData = JSON.parse(e.postData.contents);

    if (postData.events) {
      handleWebhook(e);
      return; 
    }
    
    if (postData.action) {
      Logger.log('受信アクション: [' + postData.action + '] / postData keys: ' + Object.keys(postData).join(', '));

      if (postData.action !== 'runTests') {
        const configsForSuspend = getConfigs();
        if (isServiceSuspended_(configsForSuspend)) {
          return createServiceSuspendedResponse_();
        }
      }

      let response;
      switch (postData.action) {
        case 'getInitData': {
          requireVerifiedLineUserId_(postData, postData.lineUserId || null);
          const configs = getConfigs();
          const lineUserId = postData.lineUserId || null;
          const customerRecord = lineUserId ? findCustomerByUserId_(lineUserId) : null;
          const isRegistered = customerRecord !== null;
          response = {
            shopName: configs.shopName,
            serviceMenus: configs.serviceMenus || [],
            businessHours: configs.businessHours || { start: '10:00', end: '19:00' },
            isStaffFeatureEnabled: configs.isStaffFeatureEnabled || false,
            staffs: configs.isStaffFeatureEnabled ? (configs.staffs || []) : [],
            bookingTimeUnit: configs.bookingTimeUnit || 30,
            bookingLookaheadDays: configs.bookingLookaheadDays || 90,
            isRegistered: isRegistered,
            customerName: customerRecord ? customerRecord['顧客名'] : '',
            maxBulkBookings: parseInt(configs.maxBulkBookings || 1, 10),
            allowSameDayBooking: isSameDayBookingAllowed_(configs),
            reminderMode: configs.reminderMode || 'ICS',
          };
          break;
        }

        case 'runTests': {
          // 自動テスト実行（CI/CD連携用）
          // テスト結果をJSONで返しつつ「テスト結果」シートに証跡を保存する
          response = runAllGASTests();
          break;
        }

        case 'createBulkBookings': {
          if (!postData.bookingDataList || !Array.isArray(postData.bookingDataList) || postData.bookingDataList.length === 0) {
            throw new Error('予約情報リストがありません。');
          }
          const bulkUserId = postData.bookingDataList[0].lineUserId;
          requireVerifiedLineUserId_(postData, bulkUserId);
          for (let i = 1; i < postData.bookingDataList.length; i++) {
            if (postData.bookingDataList[i].lineUserId !== bulkUserId) {
              throw new Error('一括予約の LINE User ID が一致しません。');
            }
          }
          response = createBulkBookings(postData.bookingDataList);
          break;
        }

        case 'registerCustomer': {
          if (!postData.lineUserId || !postData.customerName) {
            throw new Error('LINE User ID と顧客名は必須です。');
          }
          requireVerifiedLineUserId_(postData, postData.lineUserId);
          response = registerCustomer(
            postData.lineUserId,
            postData.customerName,
            postData.gender,
            postData.ageGroup
          );
          break;
        }

        case 'getAvailableSlots': {
          if (!postData.date || !postData.duration) {
            throw new Error('日付または所要時間が指定されていません。');
          }
          response = getAvailableSlots(
            postData.date,
            postData.duration,
            postData.staffEmail,
            postData.excludeBookingId || null
          );
          break;
        }

        case 'createBooking': {
          if (!postData.bookingData) {
            throw new Error('予約情報がありません。');
          }
          requireVerifiedLineUserId_(postData, postData.bookingData.lineUserId);
          response = createBooking(postData.bookingData);
          break;
        }

        case 'getMyBookings': {
          requireVerifiedLineUserId_(postData, postData.lineUserId);
          response = getMyBookings(postData.lineUserId);
          break;
        }

        case 'cancelBookingByUser': {
          requireVerifiedLineUserId_(postData, postData.lineUserId);
          if (!postData.bookingId) {
            throw new Error('予約IDが指定されていません。');
          }
          response = cancelBookingByUser(postData.lineUserId, postData.bookingId);
          break;
        }

        case 'rescheduleBookingByUser': {
          requireVerifiedLineUserId_(postData, postData.lineUserId);
          if (!postData.bookingId || !postData.newStartDateTime) {
            throw new Error('予約IDまたは新しい日時が指定されていません。');
          }
          response = rescheduleBookingByUser(
            postData.lineUserId,
            postData.bookingId,
            postData.newStartDateTime
          );
          break;
        }

        default:
          throw new Error('無効なアクションが指定されました。');
      }
      return createJsonResponse({ success: true, data: response });
    }

    throw new Error('不正なリクエスト形式です。');

  } catch (error) {
    Logger.log('APIエラー: %s', error.message);
    if (isLineAuthErrorMessage_(error.message)) {
      return createLineAuthFailedResponse_(error.message);
    }
    return createJsonResponse({ success: false, message: error.message });
  }
}


// =================================================================
// データ操作関数
// =================================================================

function getConfigs() {
  const configSheet = getConfigSheet_();
  
  const dataRange = configSheet.getRange('A2:B' + configSheet.getLastRow());
  const values = dataRange.getValues();
  
  const configs = {};
  values.forEach(row => {
    const key = row[0].toString().trim();
    let value = row[1];
    
    if (!key) return;

    const jsonKeys = ['serviceMenus', 'businessHours', 'holidays', 'staffs', 'staff_block_calendar_id_map', 'nonOperatingHours'];
    if (jsonKeys.includes(key)) {
      try {
        if (value === '' || value === null || value === undefined) {
          configs[key] = (key === 'serviceMenus' || key === 'holidays' || key === 'staffs' || key === 'nonOperatingHours') ? [] : {};
        } else {
          configs[key] = JSON.parse(value);
        }
      } catch (e) {
        Logger.log(`Key "${key}" のJSONパースに失敗。デフォルト値を設定します。Error: ${e.message}`);
        configs[key] = (key === 'serviceMenus' || key === 'holidays' || key === 'staffs' || key === 'nonOperatingHours') ? [] : {};
      }
    } else {
      if (key === 'isStaffFeatureEnabled' || key === 'allowSameDayBooking') {
        configs[key] = (value === true || value === 'TRUE');
      } else {
        configs[key] = value;
      }
    }
  });
  
  return configs;
}

/**
 * 開発者側でサービス停止が設定されているか（Config.serviceSuspended）
 */
function isServiceSuspended_(configs) {
  const v = configs && configs.serviceSuspended;
  return v === true || String(v).toLowerCase() === 'true' || v === 1 || v === '1';
}

function createServiceSuspendedResponse_() {
  return createJsonResponse({
    success: false,
    code: 'SERVICE_SUSPENDED',
    message: '現在、予約サービスは一時停止中です。店舗にお問い合わせください。',
  });
}

// =================================================================
// LINE ID Token 検証（LIFF → GAS API）
// =================================================================

const LINE_ID_TOKEN_VERIFY_URL = 'https://api.line.me/oauth2/v2.1/verify';

function isLineIdTokenVerificationEnabled_(configs) {
  return !!String((configs && configs.lineLoginChannelId) || '').trim();
}

/**
 * LINE ID Token を Verify API で検証し、LINE User ID (sub) を返す。
 * lineLoginChannelId 未設定時は null（移行モード）。
 */
function verifyLineIdToken_(idToken, configs) {
  if (!idToken) {
    throw new Error('LINE認証情報がありません。LINEアプリから再度お試しください。');
  }
  const clientId = String(configs.lineLoginChannelId || '').trim();
  if (!clientId) {
    return null;
  }
  const res = UrlFetchApp.fetch(LINE_ID_TOKEN_VERIFY_URL, {
    method: 'post',
    contentType: 'application/x-www-form-urlencoded',
    payload: {
      id_token: idToken,
      client_id: clientId,
    },
    muteHttpExceptions: true,
  });
  if (res.getResponseCode() !== 200) {
    Logger.log('ID token verify failed: HTTP %s %s', res.getResponseCode(), res.getContentText());
    throw new Error('LINE認証の検証に失敗しました。LINEアプリから再度お試しください。');
  }
  const body = JSON.parse(res.getContentText());
  if (!body.sub) {
    throw new Error('LINE認証の検証結果が不正です。');
  }
  return body.sub;
}

/**
 * リクエストの idToken を検証し、expectedUserId と一致することを要求する。
 * lineLoginChannelId 未設定時は移行モード（警告ログのみ）。
 */
function requireVerifiedLineUserId_(postData, expectedUserId) {
  const configs = getConfigs();
  if (!isLineIdTokenVerificationEnabled_(configs)) {
    Logger.log('lineLoginChannelId 未設定: ID Token 検証をスキップ（移行モード）');
    if (!expectedUserId) {
      throw new Error('LINE User ID が必要です。');
    }
    return expectedUserId;
  }
  const verified = verifyLineIdToken_(postData.idToken, configs);
  if (!expectedUserId || verified !== expectedUserId) {
    Logger.log('LINE User ID mismatch: expected=%s verified=%s', expectedUserId, verified);
    throw new Error('LINE認証情報が一致しません。');
  }
  return verified;
}

function createLineAuthFailedResponse_(message) {
  return createJsonResponse({
    success: false,
    code: 'LINE_AUTH_FAILED',
    message: message || 'LINE認証の検証に失敗しました。',
  });
}

function isLineAuthErrorMessage_(message) {
  const msg = String(message || '');
  return msg.indexOf('LINE認証') >= 0 || msg.indexOf('LINE User ID') >= 0;
}

function saveConfigs(configs) {
  try {
    const currentConfigs = getConfigs();
    const currentUser = Session.getActiveUser().getEmail();

    let authorizedUsers = [];
    if (currentConfigs.adminEmail) {
      authorizedUsers.push(currentConfigs.adminEmail.toLowerCase());
    }
    if (currentConfigs.isStaffFeatureEnabled && currentConfigs.staffs) {
      currentConfigs.staffs.forEach(staff => {
        if (staff.email) {
          authorizedUsers.push(staff.email.toLowerCase());
        }
      });
    }
    authorizedUsers = [...new Set(authorizedUsers)];

    if (authorizedUsers.length > 0 && (!currentUser || !authorizedUsers.includes(currentUser.toLowerCase()))) {
      Logger.log(`保存拒否: ${currentUser} は許可されたユーザーではありません。(許可リスト: ${authorizedUsers.join(', ')})`);
      return {
        success: false,
        message: `保存権限がありません。ログイン中: ${currentUser || '（未取得）'}。Config の adminEmail（${currentConfigs.adminEmail || '未設定'}）と同じ Google アカウントで開いてください。`,
      };
    }

    const sheet = getConfigSheet_();
    const keyToRow = buildConfigKeyRowMap_(sheet);

    Object.keys(configs).forEach(key => {
      const newValue = configs[key];
      const cellValue = (typeof newValue === 'object') ? JSON.stringify(newValue) : newValue;
      const rowNum = keyToRow[key];
      if (rowNum) {
        sheet.getRange(rowNum, 2).setValue(cellValue);
      } else {
        const newRow = Math.max(sheet.getLastRow(), 1) + 1;
        sheet.getRange(newRow, 1, 1, 2).setValues([[key, cellValue]]);
        keyToRow[key] = newRow;
      }
    });

    Logger.log('設定を保存しました。');
    return { success: true, message: 'OK' };

  } catch (e) {
    Logger.log('設定の保存中にエラーが発生しました: %s', e.message);
    return { success: false, message: e.message || String(e) };
  }
}

/** Config シート A列キー → 行番号（1-based）のマップを返す */
function buildConfigKeyRowMap_(sheet) {
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return {};
  const values = sheet.getRange('A2:B' + lastRow).getValues();
  const map = {};
  values.forEach((row, i) => {
    const key = String(row[0] || '').trim();
    if (key) map[key] = i + 2;
  });
  return map;
}

function createJsonResponse(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

// =================================================================
// 予約コアロジック
// =================================================================

/**
 * 新規予約を作成する
 */
function createBooking(bookingData) {
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);

  try {
    const configs = getConfigs();
    const { lineUserId, userName, menuName, duration, startDateTime, staffEmail, staffName } = bookingData;
    const startTime = new Date(startDateTime);
    const endTime = new Date(startTime.getTime() + duration * 60000);
    const timeUnit = parseInt(configs.bookingTimeUnit || 30, 10);
    const maxBookings = parseInt(configs.maxConcurrentBookings || 1, 10);

    if (!configs.reservationCalendarId) {
      throw new Error('予約カレンダーが設定されていません。設定画面でGoogleカレンダーIDを登録してください。');
    }
    if (!isSlotBookableBySameDayRules_(startTime, configs)) {
      throw new Error('申し訳ありません。当日予約は受け付けておりません。');
    }

    const reservationSheet = getReservationSheet(configs);
    const data = reservationSheet.getDataRange().getValues();
    const headers = data[0];
    const statusCol = headers.indexOf('ステータス');
    const startTimeCol = headers.indexOf('予約日時');
    const endTimeCol = headers.indexOf('終了日時');
    const staffEmailCol = headers.indexOf('担当者Email');

    // 【追加】担当者が指名されているか判定
    const isStaffNominated = staffEmail && staffEmail !== 'any';
    const effectiveMaxBookings = isStaffNominated ? 1 : maxBookings;

    let checkTime = new Date(startTime);
    while (checkTime < endTime) {
      let concurrentBookings = 0;
      for (let i = 1; i < data.length; i++) {
        const row = data[i];
        const status = row[statusCol];
        if (status !== '予約' && status !== '仮予約') continue;

        // 【追加】指名予約の場合、別の担当者の予約は重複カウントから除外する
        if (isStaffNominated && row[staffEmailCol] !== staffEmail) continue;

        const existingStart = new Date(row[startTimeCol]);
        const existingEnd = new Date(row[endTimeCol]);

        if (checkTime >= existingStart && checkTime < existingEnd) {
          concurrentBookings++;
        }
      }

      if (concurrentBookings >= effectiveMaxBookings) {
        const timeStr = Utilities.formatDate(checkTime, 'JST', 'HH:mm');
        throw new Error(`申し訳ありません。タッチの差で ${timeStr} の枠が埋まってしまいました。`);
      }
      checkTime.setMinutes(checkTime.getMinutes() + timeUnit);
    }

    const newBookingId = generateBookingId();
    reservationSheet.appendRow([
      newBookingId, '予約', lineUserId, userName, menuName, startTime, endTime, '', staffName || '', staffEmail || ''
    ]);

    const calendar = CalendarApp.getCalendarById(configs.reservationCalendarId);
    if (!calendar) throw new Error('予約カレンダーが見つかりません。');
    
    const eventTitle = staffName ? `【${userName}様／担当：${staffName}】${menuName}` : `【${userName}様】${menuName}`;
    const event = calendar.createEvent(eventTitle, startTime, endTime);
    
    reservationSheet.getRange(reservationSheet.getLastRow(), headers.indexOf('イベントID') + 1).setValue(event.getId());

    // 満席タイムテーブルの動的更新（既存行はインクリメント、なければ新規追記）
    updateTimetableSlots_(startTime, endTime, timeUnit);

    return {
      bookingId: newBookingId,
      eventTitle: eventTitle,
      startTime: startTime.toISOString(),
      endTime: endTime.toISOString(),
      shopName: configs.shopName
    };

  } catch (e) {
    Logger.log(`予約作成エラー: ${e.message}`);
    throw e;
  } finally {
    lock.releaseLock();
  }
}

function getReservationSheet(configs) {
  let sheet = getSpreadsheet_().getSheetByName('予約');
  if (!sheet) {
    sheet = getSpreadsheet_().insertSheet('予約');
    const headers = ['予約ID', 'ステータス', 'LINE User ID', '顧客名', 'メニュー名', '予約日時', '終了日時', 'イベントID', '担当者名', '担当者Email'];
    sheet.appendRow(headers);
    sheet.setFrozenRows(1);
  }
  
  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  if (headers.indexOf('担当者名') === -1) {
    sheet.getRange(1, headers.length + 1).setValue('担当者名');
    sheet.getRange(1, headers.length + 2).setValue('担当者Email');
  }
  
  return sheet;
}

function generateBookingId() {
  return 'BK' + new Date().getTime().toString(36) + Math.random().toString(36).substr(2, 5);
}

// =================================================================
// LINE Webhook 処理
// =================================================================
function handleWebhook(e) {
  const configs = getConfigs();
  if (isServiceSuspended_(configs)) {
    Logger.log('サービス停止中のため Webhook を無視しました。');
    return;
  }
  
  const events = JSON.parse(e.postData.contents).events;
  events.forEach(event => {
    if (event.type === 'message' && event.message.type === 'text') {
      handleTextMessage(event, configs);
    }
  });
}

function handleTextMessage(event, configs) {
  const userText = event.message.text;
  const userId = event.source.userId;
  const replyToken = event.replyToken;

  if (userText === '予約') {
    const futureBookings = getFutureBookingsByUserId(userId, configs);
    let replyText = '';

    if (futureBookings.length > 0) {
      const dayOfWeekJp = ['日', '月', '火', '水', '木', '金', '土'];

      replyText = '📅 今後のご予約一覧です。\n\n';
      futureBookings.forEach((booking, index) => {
        const startTime = new Date(booking.startTime);
        const dayChar = dayOfWeekJp[startTime.getDay()];
        const datePart = Utilities.formatDate(startTime, 'JST', 'M月d日');
        const timePart = Utilities.formatDate(startTime, 'JST', 'HH:mm');
        const formattedDateTime = `${datePart}(${dayChar}) ${timePart}`;

        replyText += `【予約${index + 1}】\n`;
        replyText += `日時: ${formattedDateTime}\n`;
        replyText += `メニュー: ${booking.menuName}\n`;
        if (booking.staffName && booking.staffName !== '指名なし') {
          replyText += `担当: ${booking.staffName}\n`;
        }
        replyText += '\n';
      });
      replyText += 'ご来店をお待ちしております。';
    } else {
      replyText = '現在、ご予約はございません。\n\nご予約はLINEのメニューから承ります。';
    }

    replyToUser(replyToken, replyText, configs.lineChannelAccessToken);
  }
}

function getFutureBookingsByUserId(userId, configs) {
  const sheet = getReservationSheet(configs);
  const data = sheet.getDataRange().getValues();
  const headers = data.shift();
  const now = new Date();
  const futureBookings = [];

  const userIdCol    = headers.indexOf('LINE User ID');
  const statusCol    = headers.indexOf('ステータス');
  const startTimeCol = headers.indexOf('予約日時');
  const menuNameCol  = headers.indexOf('メニュー名');
  const staffNameCol = headers.indexOf('担当者名');

  data.forEach(row => {
    const bookingTime = new Date(row[startTimeCol]);
    if (row[userIdCol] === userId && row[statusCol] === '予約' && bookingTime > now) {
      futureBookings.push({
        startTime: bookingTime,
        menuName:  row[menuNameCol],
        staffName: staffNameCol >= 0 ? row[staffNameCol] : '',
      });
    }
  });

  futureBookings.sort((a, b) => a.startTime - b.startTime);

  return futureBookings;
}

/** Config の serviceMenus からメニュー所要時間（分）を取得する */
function getMenuDurationByName_(configs, menuName) {
  const menus = configs.serviceMenus || [];
  const menu = menus.find(m => m.name === menuName);
  return menu ? parseInt(menu.duration, 10) : 0;
}

/**
 * 予約IDで行を検索し、予約オブジェクトと行番号を返す（見つからなければ null）
 */
function findBookingRowById_(bookingId) {
  const configs = getConfigs();
  const sheet = getReservationSheet(configs);
  const data = sheet.getDataRange().getValues();
  if (data.length < 2) return null;
  const h = data[0];
  const bookingIdCol = h.indexOf('予約ID');
  for (let i = 1; i < data.length; i++) {
    if (data[i][bookingIdCol] === bookingId) {
      return {
        sheet: sheet,
        rowIndex: i + 1,
        headers: h,
        row: data[i],
        booking: {
          bookingId: data[i][bookingIdCol],
          status: data[i][h.indexOf('ステータス')],
          lineUserId: data[i][h.indexOf('LINE User ID')],
          userName: data[i][h.indexOf('顧客名')],
          menuName: data[i][h.indexOf('メニュー名')],
          startTime: new Date(data[i][h.indexOf('予約日時')]),
          endTime: new Date(data[i][h.indexOf('終了日時')]),
          eventId: data[i][h.indexOf('イベントID')],
          staffName: data[i][h.indexOf('担当者名')],
          staffEmail: data[i][h.indexOf('担当者Email')],
        },
      };
    }
  }
  return null;
}

/**
 * LIFF 向け: ログインユーザーの未来予約一覧（変更・キャンセル可能な「予約」ステータスのみ）
 */
function getMyBookings(lineUserId) {
  const configs = getConfigs();
  const sheet = getReservationSheet(configs);
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) {
    return { bookings: [], reminderMode: configs.reminderMode || 'ICS' };
  }

  const data = sheet.getRange(1, 1, lastRow, sheet.getLastColumn()).getValues();
  const h = data[0];
  const now = new Date();
  const bookings = [];

  const userIdCol = h.indexOf('LINE User ID');
  const statusCol = h.indexOf('ステータス');
  const bookingIdCol = h.indexOf('予約ID');
  const startTimeCol = h.indexOf('予約日時');
  const endTimeCol = h.indexOf('終了日時');
  const menuNameCol = h.indexOf('メニュー名');
  const staffNameCol = h.indexOf('担当者名');
  const staffEmailCol = h.indexOf('担当者Email');

  for (let i = 1; i < data.length; i++) {
    const row = data[i];
    const startTime = new Date(row[startTimeCol]);
    if (row[userIdCol] !== lineUserId || row[statusCol] !== '予約' || startTime <= now) continue;

    const menuName = row[menuNameCol];
    bookings.push({
      bookingId: row[bookingIdCol],
      startTime: startTime.toISOString(),
      endTime: new Date(row[endTimeCol]).toISOString(),
      menuName: menuName,
      duration: getMenuDurationByName_(configs, menuName),
      staffName: staffNameCol >= 0 ? row[staffNameCol] : '',
      staffEmail: staffEmailCol >= 0 ? row[staffEmailCol] : '',
    });
  }

  bookings.sort((a, b) => new Date(a.startTime) - new Date(b.startTime));
  return { bookings, reminderMode: configs.reminderMode || 'ICS' };
}

/**
 * エンドユーザーによる予約キャンセル（本人確認 + 未来予約のみ）
 */
function cancelBookingByUser(lineUserId, bookingId) {
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const found = findBookingRowById_(bookingId);
    if (!found) throw new Error('予約が見つかりません。');
    const { booking } = found;
    if (booking.lineUserId !== lineUserId) {
      throw new Error('この予約を操作する権限がありません。');
    }
    if (booking.status !== '予約') {
      throw new Error('この予約は変更・キャンセルできません。');
    }
    if (booking.startTime <= new Date()) {
      throw new Error('開始済みまたは過去の予約はキャンセルできません。');
    }

    confirmBookingStatus(bookingId, 'キャンセル');
    const configs = getConfigs();
    return {
      bookingId: bookingId,
      shopName: configs.shopName,
      reminderMode: configs.reminderMode || 'ICS',
    };
  } finally {
    lock.releaseLock();
  }
}

/**
 * 指定時間帯が予約可能か検証する（変更対象の予約IDは重複カウントから除外）
 */
function assertSlotAvailableForBooking_(startTime, endTime, staffEmail, excludeBookingId, configs) {
  const timeUnit = parseInt(configs.bookingTimeUnit || 30, 10);
  const maxBookings = parseInt(configs.maxConcurrentBookings || 1, 10);
  const isStaffNominated = staffEmail && staffEmail !== 'any';
  const effectiveMaxBookings = isStaffNominated ? 1 : maxBookings;

  const reservationSheet = getReservationSheet(configs);
  const data = reservationSheet.getDataRange().getValues();
  const headers = data[0];
  const bookingIdCol = headers.indexOf('予約ID');
  const statusCol = headers.indexOf('ステータス');
  const startTimeCol = headers.indexOf('予約日時');
  const endTimeCol = headers.indexOf('終了日時');
  const staffEmailCol = headers.indexOf('担当者Email');

  let checkTime = new Date(startTime);
  while (checkTime < endTime) {
    let concurrentBookings = 0;
    for (let i = 1; i < data.length; i++) {
      const row = data[i];
      if (row[bookingIdCol] === excludeBookingId) continue;
      const status = row[statusCol];
      if (status !== '予約' && status !== '仮予約') continue;
      if (isStaffNominated && row[staffEmailCol] !== staffEmail) continue;

      const existingStart = new Date(row[startTimeCol]);
      const existingEnd = new Date(row[endTimeCol]);
      if (checkTime >= existingStart && checkTime < existingEnd) {
        concurrentBookings++;
      }
    }
    if (concurrentBookings >= effectiveMaxBookings) {
      const timeStr = Utilities.formatDate(checkTime, 'JST', 'HH:mm');
      throw new Error(`申し訳ありません。タッチの差で ${timeStr} の枠が埋まってしまいました。`);
    }
    checkTime.setMinutes(checkTime.getMinutes() + timeUnit);
  }
}

/**
 * 予約変更時に Google カレンダーイベントの日時を更新する（イベントが無い場合は新規作成）
 */
function updateCalendarEventTimes_(configs, eventId, startTime, endTime, bookingInfo) {
  if (!configs.reservationCalendarId) {
    throw new Error('予約カレンダーが設定されていません。');
  }
  const calendar = CalendarApp.getCalendarById(configs.reservationCalendarId);
  if (!calendar) throw new Error('予約カレンダーが見つかりません。');

  const { userName, menuName, staffName } = bookingInfo;
  const eventTitle = staffName && staffName !== '指名なし'
    ? `【${userName}様／担当：${staffName}】${menuName}`
    : `【${userName}様】${menuName}`;

  if (eventId) {
    const event = getReservationCalendarEvent_(configs, eventId);
    if (event) {
      event.setTime(startTime, endTime);
      event.setTitle(eventTitle);
      return event.getId();
    }
  }

  const newEvent = calendar.createEvent(eventTitle, startTime, endTime);
  return newEvent.getId();
}

/**
 * エンドユーザーによる予約日時変更（メニュー・担当者は変更不可）
 */
function rescheduleBookingByUser(lineUserId, bookingId, newStartDateTime) {
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const configs = getConfigs();
    const found = findBookingRowById_(bookingId);
    if (!found) throw new Error('予約が見つかりません。');

    const { sheet, rowIndex, headers, booking } = found;
    if (booking.lineUserId !== lineUserId) {
      throw new Error('この予約を操作する権限がありません。');
    }
    if (booking.status !== '予約') {
      throw new Error('この予約は変更・キャンセルできません。');
    }
    if (booking.startTime <= new Date()) {
      throw new Error('開始済みまたは過去の予約は変更できません。');
    }

    const duration = getMenuDurationByName_(configs, booking.menuName);
    if (!duration) {
      throw new Error(`メニュー「${booking.menuName}」の所要時間が設定されていません。`);
    }

    const newStart = new Date(newStartDateTime);
    const newEnd = new Date(newStart.getTime() + duration * 60000);

    if (!isSlotBookableBySameDayRules_(newStart, configs)) {
      throw new Error('申し訳ありません。当日予約は受け付けておりません。');
    }

    assertSlotAvailableForBooking_(
      newStart,
      newEnd,
      booking.staffEmail,
      bookingId,
      configs
    );

    const startTimeCol = headers.indexOf('予約日時');
    const endTimeCol = headers.indexOf('終了日時');
    const eventIdCol = headers.indexOf('イベントID');

    sheet.getRange(rowIndex, startTimeCol + 1).setValue(newStart);
    sheet.getRange(rowIndex, endTimeCol + 1).setValue(newEnd);

    const updatedEventId = updateCalendarEventTimes_(
      configs,
      booking.eventId,
      newStart,
      newEnd,
      booking
    );
    if (updatedEventId && updatedEventId !== booking.eventId) {
      sheet.getRange(rowIndex, eventIdCol + 1).setValue(updatedEventId);
    }

    rebuildTimetableFromReservations_();

    return {
      bookingId: bookingId,
      startTime: newStart.toISOString(),
      endTime: newEnd.toISOString(),
      menuName: booking.menuName,
      staffName: booking.staffName,
      shopName: configs.shopName,
      reminderMode: configs.reminderMode || 'ICS',
    };
  } finally {
    lock.releaseLock();
  }
}

function replyToUser(replyToken, text, accessToken) {
  const url = 'https://api.line.me/v2/bot/message/reply';
  const payload = {
    replyToken: replyToken,
    messages: [{
      type: 'text',
      text: text
    }]
  };

  const options = {
    method: 'post',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + accessToken
    },
    payload: JSON.stringify(payload)
  };

  UrlFetchApp.fetch(url, options);
}

function validateSignature(requestBody, channelSecret, signature) {
  const generatedSignature = Utilities.computeHmacSha256Signature(requestBody, channelSecret);
  const encodedSignature = Utilities.base64Encode(generatedSignature);
  return encodedSignature === signature;
}

// =================================================================
// 夜間バッチ処理
// =================================================================

/**
 * 予約状況を集計し、「満席タイムテーブル」シートを更新する（夜間バッチ用）
 */
function updateAvailabilityCache() {
  const configs = getConfigs();
  const timeUnit = parseInt(configs.bookingTimeUnit || 30, 10);
  const lookaheadDays = 90;

  const availabilitySheet = getSpreadsheet_().getSheetByName('満席タイムテーブル');
  if (!availabilitySheet) {
    Logger.log('「満席タイムテーブル」シートが見つかりません。');
    return;
  }

  const bookingCounts = new Map();
  const reservationSheet = getReservationSheet(configs);
  const data = reservationSheet.getDataRange().getValues();
  const headers = data.shift();
  
  const statusCol = headers.indexOf('ステータス');
  const startTimeCol = headers.indexOf('予約日時');
  const endTimeCol = headers.indexOf('終了日時');

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const endDate = new Date(today.getTime() + lookaheadDays * 24 * 60 * 60 * 1000);

  data.forEach(row => {
    const status = row[statusCol];
    if (status !== '予約' && status !== '仮予約') return;

    const bookingStart = new Date(row[startTimeCol]);
    if (bookingStart >= today && bookingStart < endDate) {
      const bookingEnd = new Date(row[endTimeCol]);
      let currentSlot = new Date(bookingStart);

      while (currentSlot < bookingEnd) {
        const dateTimeStr = Utilities.formatDate(currentSlot, 'JST', 'yyyy-MM-dd HH:mm');
        bookingCounts.set(dateTimeStr, (bookingCounts.get(dateTimeStr) || 0) + 1);
        currentSlot.setMinutes(currentSlot.getMinutes() + timeUnit);
      }
    }
  });

  const outputData = [];
  for (const [dateTimeStr, count] of bookingCounts.entries()) {
    const [date, time] = dateTimeStr.split(' ');
    outputData.push([date, time, count]);
  }

  availabilitySheet.clearContents();
  availabilitySheet.appendRow(['日付', '時間枠', '予約数']);
  if (outputData.length > 0) {
    availabilitySheet.getRange(2, 1, outputData.length, 3).setValues(outputData);
  }
  
  Logger.log(`満席タイムテーブルを更新しました。${outputData.length}件のデータを書き込みました。`);
}

/**
 * 指定された週の7日分の空き枠をまとめて取得する
 */
/**
 * 当日予約の受付ルールに基づき、指定スロットが予約可能か判定する
 * - 現在時刻以前の枠は常に不可
 * - 当日枠は allowSameDayBooking が false の場合のみ不可
 */
function isSameDayBookingAllowed_(configs) {
  if (!configs) return true;
  return configs.allowSameDayBooking !== false && configs.allowSameDayBooking !== 'FALSE';
}

function isSlotBookableBySameDayRules_(slotStart, configs) {
  const now = new Date();
  if (slotStart.getTime() <= now.getTime()) return false;

  const todayStr = Utilities.formatDate(now, 'JST', 'yyyy-MM-dd');
  const slotDateStr = Utilities.formatDate(slotStart, 'JST', 'yyyy-MM-dd');
  if (slotDateStr !== todayStr) return true;

  return isSameDayBookingAllowed_(configs);
}

/**
 * 定休日（曜日番号 0=日〜6=土）かどうか
 */
function isWeeklyHoliday_(date, holidays) {
  if (!Array.isArray(holidays) || holidays.length === 0) return false;
  const dayOfWeek = date.getDay();
  return holidays.some(h => parseInt(h, 10) === dayOfWeek);
}

/**
 * 指定スロット開始時刻が非稼働時間帯に含まれるか
 */
function isSlotInNonOperatingHours_(dateStr, timeStr, nonOperatingHours) {
  if (!Array.isArray(nonOperatingHours) || nonOperatingHours.length === 0) return false;
  const slotStart = new Date(`${dateStr}T${timeStr}`);
  for (const period of nonOperatingHours) {
    if (!period || !period.start || !period.end) continue;
    const periodStart = new Date(`${dateStr}T${period.start}`);
    const periodEnd = new Date(`${dateStr}T${period.end}`);
    if (slotStart >= periodStart && slotStart < periodEnd) return true;
  }
  return false;
}

/**
 * 予約シートから週次の予約件数マップを構築する。
 * excludeBookingId 指定時は変更対象予約を満席カウントから除外する（予約変更UI用）。
 */
function buildWeeklyBookingCountsFromSheet_(configs, startDateStr, endDateStr, staffEmail, isStaffNominated, excludeBookingId) {
  const weeklyBookingCounts = {};
  const timeUnit = parseInt(configs.bookingTimeUnit || 30, 10);
  const reservationSheet = getReservationSheet(configs);
  const data = reservationSheet.getDataRange().getValues();
  const headers = data[0];
  const statusCol = headers.indexOf('ステータス');
  const startTimeCol = headers.indexOf('予約日時');
  const endTimeCol = headers.indexOf('終了日時');
  const staffEmailCol = headers.indexOf('担当者Email');
  const bookingIdCol = headers.indexOf('予約ID');

  for (let i = 1; i < data.length; i++) {
    const row = data[i];
    const status = row[statusCol];
    if (status !== '予約' && status !== '仮予約') continue;
    if (excludeBookingId && row[bookingIdCol] === excludeBookingId) continue;
    if (isStaffNominated && row[staffEmailCol] !== staffEmail) continue;

    const bookingStart = new Date(row[startTimeCol]);
    const bookingEnd = new Date(row[endTimeCol]);
    const rowDateStr = Utilities.formatDate(bookingStart, 'JST', 'yyyy-MM-dd');

    if (rowDateStr >= startDateStr && rowDateStr < endDateStr) {
      if (!weeklyBookingCounts[rowDateStr]) {
        weeklyBookingCounts[rowDateStr] = new Map();
      }
      let currentSlot = new Date(bookingStart);
      while (currentSlot < bookingEnd) {
        const timeSlotStr = Utilities.formatDate(currentSlot, 'JST', 'HH:mm');
        const existingCount = weeklyBookingCounts[rowDateStr].get(timeSlotStr) || 0;
        weeklyBookingCounts[rowDateStr].set(timeSlotStr, existingCount + 1);
        currentSlot.setMinutes(currentSlot.getMinutes() + timeUnit);
      }
    }
  }

  return weeklyBookingCounts;
}

function getAvailableSlots(startDateString, durationMinutes, staffEmail, excludeBookingId) {
  const configs = getConfigs();
  const timeUnit = parseInt(configs.bookingTimeUnit || 30, 10);
  const businessHours = configs.businessHours || { start: '10:00', end: '19:00' };
  const maxBookings = parseInt(configs.maxConcurrentBookings || 1, 10);
  const holidays = Array.isArray(configs.holidays) ? configs.holidays : [];
  const nonOperatingHours = Array.isArray(configs.nonOperatingHours) ? configs.nonOperatingHours : [];

  const startDate = new Date(startDateString);
  const endDate = new Date(startDate.getTime());
  endDate.setDate(endDate.getDate() + 7);

  const startDateStr = Utilities.formatDate(startDate, 'JST', 'yyyy-MM-dd');
  const endDateStr = Utilities.formatDate(endDate, 'JST', 'yyyy-MM-dd');

  const isStaffNominated = staffEmail && staffEmail !== 'any';

  // --- ブロックカレンダーの同期と、ブロックスロットの取得 ---
  const blockCalendarIds = getBlockCalendarIds_(configs, staffEmail, isStaffNominated);
  if (blockCalendarIds.length > 0) {
    syncBlockCalendars(blockCalendarIds);
  }
  const blockedSlots = getBlockedSlotsForWeek(startDateStr, endDateStr, blockCalendarIds, businessHours, timeUnit);

  let weeklyBookingCounts;
  if (isStaffNominated || excludeBookingId) {
    // Bルート（指名あり）または予約変更時: 予約シートからリアルタイム計算
    weeklyBookingCounts = buildWeeklyBookingCountsFromSheet_(
      configs, startDateStr, endDateStr, staffEmail, isStaffNominated, excludeBookingId
    );
  } else {
    // Aルート（指名なし）：満席タイムテーブルから店舗全体の予定を高速取得
    weeklyBookingCounts = {};
    rebuildTimetableFromReservations_();
    const availabilitySheet = getSpreadsheet_().getSheetByName('満席タイムテーブル');
    if (availabilitySheet) {
      const data = availabilitySheet.getDataRange().getValues();
      for (let i = 1; i < data.length; i++) {
        const row = data[i];
        const rowDateStr = stripSheetText_(row[0]).substring(0, 10);
        if (!/^\d{4}-\d{2}-\d{2}$/.test(rowDateStr)) continue;

        if (rowDateStr >= startDateStr && rowDateStr < endDateStr) {
          if (!weeklyBookingCounts[rowDateStr]) {
            weeklyBookingCounts[rowDateStr] = new Map();
          }

          const timeSlot = stripSheetText_(row[1]).substring(0, 5);
          const count = parseInt(row[2], 10);
          const existingCount = weeklyBookingCounts[rowDateStr].get(timeSlot) || 0;
          weeklyBookingCounts[rowDateStr].set(timeSlot, existingCount + count);
        }
      }
    }
  }

  // --- 2. 7日分ループして、それぞれの日で空き枠を計算 ---
  const weeklyAvailableSlots = {};
  
  // 【追加】担当者指名時は、その担当者個人としての空き枠を判定するため同時予約上限を強制的に「1」とする
  const effectiveMaxBookings = isStaffNominated ? 1 : maxBookings;

  for (let i = 0; i < 7; i++) {
    const currentDate = new Date(startDate.getTime());
    currentDate.setDate(currentDate.getDate() + i);
    const currentDateString = Utilities.formatDate(currentDate, 'JST', 'yyyy-MM-dd');

    if (isWeeklyHoliday_(currentDate, holidays)) {
      weeklyAvailableSlots[currentDateString] = [];
      continue;
    }

    const dailyBookingCounts = weeklyBookingCounts[currentDateString] || new Map();
    const dailyAvailableSlots = [];

    const businessStartTime = new Date(`${currentDateString}T${businessHours.start}`);
    const businessEndTime = new Date(`${currentDateString}T${businessHours.end}`);

    let potentialStartTime = new Date(businessStartTime);

    while (potentialStartTime < businessEndTime) {
      let isAvailable = true;
      let checkTime = new Date(potentialStartTime);

      for (let j = 0; j < Math.ceil(durationMinutes / timeUnit); j++) {
        if (new Date(checkTime.getTime() + timeUnit * 60000) > businessEndTime) {
          isAvailable = false;
          break;
        }
        const currentSlotStr = Utilities.formatDate(checkTime, 'JST', 'HH:mm');

        // ブロックカレンダーによる全席ブロックチェック（予約上限に関わらず予約不可）
        if (blockedSlots.has(`${currentDateString} ${currentSlotStr}`)) {
          isAvailable = false;
          break;
        }

        // 非稼働時間（昼休み等）チェック
        if (isSlotInNonOperatingHours_(currentDateString, currentSlotStr, nonOperatingHours)) {
          isAvailable = false;
          break;
        }

        const currentBookings = dailyBookingCounts.get(currentSlotStr) || 0;

        if (currentBookings >= effectiveMaxBookings) {
          isAvailable = false;
          break;
        }
        checkTime.setMinutes(checkTime.getMinutes() + timeUnit);
      }

      if (isAvailable && !isSlotBookableBySameDayRules_(potentialStartTime, configs)) {
        isAvailable = false;
      }

      if (isAvailable) {
        dailyAvailableSlots.push(Utilities.formatDate(potentialStartTime, 'JST', 'HH:mm'));
      }
      potentialStartTime.setMinutes(potentialStartTime.getMinutes() + timeUnit);
    }
    weeklyAvailableSlots[currentDateString] = dailyAvailableSlots;
  }

  return weeklyAvailableSlots;
}

// =================================================================
// ブロックカレンダー同期処理
// =================================================================

/**
 * staff_block_calendar_id_map から担当者メールに対応するカレンダーIDを取得（大文字小文字・前後空白を無視）
 */
function resolveStaffBlockCalendarId_(staffCalendarMap, staffEmail) {
  if (!staffEmail || staffEmail === 'any' || !staffCalendarMap) return null;

  const normalizedEmail = String(staffEmail).trim().toLowerCase();
  if (staffCalendarMap[staffEmail]) return staffCalendarMap[staffEmail];

  for (const [key, calId] of Object.entries(staffCalendarMap)) {
    if (String(key).trim().toLowerCase() === normalizedEmail && calId) {
      return calId;
    }
  }
  return null;
}

/**
 * 設定に登録されている全ブロックカレンダーIDを返す（定期同期・デバッグ用）
 * @param {Object} configs
 * @returns {string[]}
 */
function getAllBlockCalendarIds_(configs) {
  const ids = new Set();
  const storeId = configs.block_input_calendar_id;
  if (storeId) ids.add(String(storeId));

  if (configs.isStaffFeatureEnabled) {
    const staffCalendarMap = configs.staff_block_calendar_id_map || {};
    Object.values(staffCalendarMap).forEach((calId) => {
      if (calId) ids.add(String(calId));
    });
  }
  return Array.from(ids);
}

/**
 * 設定に応じて使用するブロックカレンダーIDの配列を返す
 * @param {Object} configs - 設定オブジェクト
 * @param {string} staffEmail - 担当者メールアドレス
 * @param {boolean} isStaffNominated - 担当者指名フラグ
 * @returns {string[]} カレンダーIDの配列
 */
function getBlockCalendarIds_(configs, staffEmail, isStaffNominated) {
  if (!configs.isStaffFeatureEnabled) {
    // 担当者機能OFF: 店舗共有ブロックカレンダーを使用
    const calId = configs.block_input_calendar_id;
    return calId ? [String(calId)] : [];
  }

  if (isStaffNominated) {
    // 担当者機能ON + 指名あり: 店舗共有 + 担当者個別の両方を適用
    const ids = [];
    const storeId = configs.block_input_calendar_id;
    if (storeId) ids.push(String(storeId));

    const staffCalId = resolveStaffBlockCalendarId_(configs.staff_block_calendar_id_map, staffEmail);
    if (staffCalId) ids.push(String(staffCalId));

    return ids;
  }

  // 担当者機能ON + 指名なし: 店舗共有ブロックカレンダーのみ
  const calId = configs.block_input_calendar_id;
  return calId ? [String(calId)] : [];
}

/**
 * 指定されたブロックカレンダーをSync Tokenを用いて差分同期し、「ブロック予定同期」シートを更新する
 * @param {string[]} calendarIds - 同期するカレンダーIDの配列
 */
function syncBlockCalendars(calendarIds) {
  if (!calendarIds || calendarIds.length === 0) {
    calendarIds = getAllBlockCalendarIds_(getConfigs());
  }
  if (!calendarIds || calendarIds.length === 0) return;

  const props = PropertiesService.getScriptProperties();
  const syncSheet = getSpreadsheet_().getSheetByName('ブロック予定同期');
  if (!syncSheet) {
    Logger.log('「ブロック予定同期」シートが見つかりません。同期をスキップします。');
    return;
  }

  calendarIds.forEach(calendarId => {
    if (!calendarId) return;

    const tokenKey = 'blockSyncToken_' + calendarId;
    const syncToken = props.getProperty(tokenKey);

    try {
      // まず既存トークンで増分同期を試みる。失敗(null返却)時はフル同期
      const result = fetchCalendarEvents_(calendarId, syncToken);

      if (result === null) {
        // Sync Token失効（410 Gone）: フル同期で再構築
        Logger.log(`SyncToken失効 (${calendarId})。フル同期を実行します。`);
        props.deleteProperty(tokenKey);
        clearCalendarFromSheet_(syncSheet, calendarId);

        const fullResult = fetchCalendarEvents_(calendarId, null);
        if (fullResult) {
          appendNewBlockEvents_(syncSheet, calendarId, fullResult.events);
          if (fullResult.syncToken) {
            props.setProperty(tokenKey, fullResult.syncToken);
          }
        }
      } else {
        // 正常: 増分変更をシートへ反映
        applyIncrementalBlockEvents_(syncSheet, calendarId, result.events);
        if (result.syncToken) {
          props.setProperty(tokenKey, result.syncToken);
        }
      }
    } catch (e) {
      Logger.log(`ブロックカレンダー同期エラー (${calendarId}): ${e.message}`);
    }
  });
}

/**
 * Google Calendar APIからイベントを取得する（ページング対応）
 * @param {string} calendarId - カレンダーID
 * @param {string|null} syncToken - Sync Token。nullの場合はフル同期
 * @returns {{events: Object[], syncToken: string}|null} 取得結果。410 Gone時はnullを返す
 */
function fetchCalendarEvents_(calendarId, syncToken) {
  let allEvents = [];
  let pageToken = null;
  let finalSyncToken = null;

  do {
    const params = { maxResults: 2500 };

    if (syncToken) {
      params.syncToken = syncToken;
      params.showDeleted = true;
    } else {
      // フル同期: 今日以降の予定のみ取得
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      params.timeMin = today.toISOString();
      params.singleEvents = true;
      params.showDeleted = false;
    }

    if (pageToken) {
      params.pageToken = pageToken;
    }

    let response;
    try {
      response = Calendar.Events.list(calendarId, params);
    } catch (e) {
      const msg = e.message || '';
      // Sync Token失効（410 Gone / invalid sync token）のシグナル
      if (msg.includes('410') || msg.toLowerCase().includes('gone') ||
          msg.toLowerCase().includes('sync token') || msg.toLowerCase().includes('synctoken')) {
        return null;
      }
      throw e;
    }

    allEvents = allEvents.concat(response.items || []);
    pageToken = response.nextPageToken || null;
    if (response.nextSyncToken) {
      finalSyncToken = response.nextSyncToken;
    }

  } while (pageToken);

  return { events: allEvents, syncToken: finalSyncToken };
}

/**
 * 「ブロック予定同期」シートから指定カレンダーの全行を削除する（フル同期前のクリアに使用）
 * @param {GoogleAppsScript.getSpreadsheet_().Sheet} syncSheet
 * @param {string} calendarId
 */
function clearCalendarFromSheet_(syncSheet, calendarId) {
  const lastRow = syncSheet.getLastRow();
  if (lastRow < 2) return;

  const allData = syncSheet.getRange(2, 1, lastRow - 1, 5).getValues();
  const otherData = allData.filter(row => row[1] !== calendarId);

  syncSheet.getRange(2, 1, lastRow - 1, 5).clearContent();
  if (otherData.length > 0) {
    syncSheet.getRange(2, 1, otherData.length, 5).setValues(otherData);
  }
}

/**
 * フル同期で取得したイベントをシートへ一括追記する
 * @param {GoogleAppsScript.getSpreadsheet_().Sheet} syncSheet
 * @param {string} calendarId
 * @param {Object[]} events
 */
function appendNewBlockEvents_(syncSheet, calendarId, events) {
  const newRows = events
    .filter(event => event.status !== 'cancelled')
    .map(event => eventToSheetRow_(calendarId, event))
    .filter(row => row !== null);

  if (newRows.length === 0) return;

  const firstEmptyRow = syncSheet.getLastRow() + 1;
  syncSheet.getRange(firstEmptyRow, 1, newRows.length, 5).setValues(newRows);
}

/**
 * 増分同期で取得した差分イベントをシートへ反映する（追加・更新・削除）
 * 全データをメモリ上で処理し、一括で書き戻す方式（API呼び出し最小化）
 * @param {GoogleAppsScript.getSpreadsheet_().Sheet} syncSheet
 * @param {string} calendarId
 * @param {Object[]} events
 */
function applyIncrementalBlockEvents_(syncSheet, calendarId, events) {
  if (events.length === 0) return;

  const lastRow = syncSheet.getLastRow();
  let existingData = [];
  if (lastRow >= 2) {
    existingData = syncSheet.getRange(2, 1, lastRow - 1, 5).getValues();
  }

  // メモリ上にMapを構築: 予定ID → 行データ
  const dataMap = new Map(existingData.map(row => [row[0], row]));

  // 差分を適用
  events.forEach(event => {
    if (event.status === 'cancelled') {
      dataMap.delete(event.id);
    } else {
      const rowData = eventToSheetRow_(calendarId, event);
      if (rowData) dataMap.set(event.id, rowData);
    }
  });

  // 他カレンダーのデータは変更なし、このカレンダーのデータは更新済みMapから再構築
  const otherData = existingData.filter(row => row[1] !== calendarId);
  const thisData = Array.from(dataMap.values()).filter(row => row[1] === calendarId);
  const allData = [...otherData, ...thisData];

  // シートのデータ行を一括更新
  if (lastRow >= 2) {
    syncSheet.getRange(2, 1, lastRow - 1, 5).clearContent();
  }
  if (allData.length > 0) {
    syncSheet.getRange(2, 1, allData.length, 5).setValues(allData);
  }
}

/**
 * Google Calendarイベントオブジェクトをシート行データ配列に変換する
 * @param {string} calendarId
 * @param {Object} event
 * @returns {Array|null}
 */
function eventToSheetRow_(calendarId, event) {
  if (!event.start) return null;

  const isAllDay = !!event.start.date; // dateTime でなく date があれば終日イベント
  let startTime, endTime;

  if (isAllDay) {
    startTime = new Date(event.start.date);
    endTime = new Date(event.end.date); // 終日イベントの終了日は翌日 0:00（排他）
  } else {
    startTime = new Date(event.start.dateTime);
    endTime = new Date(event.end.dateTime);
  }

  return [event.id, calendarId, startTime, endTime, isAllDay];
}

/**
 * 指定週の「ブロック予定同期」シートを参照し、
 * ブロックされている時間スロット（"YYYY-MM-DD HH:mm"）のSetを返す
 * @param {string} startDateStr - 週開始日 "YYYY-MM-DD"
 * @param {string} endDateStr   - 週終了日（排他） "YYYY-MM-DD"
 * @param {string[]} calendarIds
 * @param {{start: string, end: string}} businessHours
 * @param {number} timeUnit - 予約時間単位（分）
 * @returns {Set<string>}
 */
function getBlockedSlotsForWeek(startDateStr, endDateStr, calendarIds, businessHours, timeUnit) {
  const blockedSlots = new Set();
  if (!calendarIds || calendarIds.length === 0) return blockedSlots;

  const syncSheet = getSpreadsheet_().getSheetByName('ブロック予定同期');
  if (!syncSheet || syncSheet.getLastRow() < 2) return blockedSlots;

  const data = syncSheet.getRange(2, 1, syncSheet.getLastRow() - 1, 5).getValues();
  // カラム順: [予定ID, カレンダーID, 開始日時, 終了日時, 終日フラグ]

  data.forEach(row => {
    if (!calendarIds.includes(row[1])) return; // 対象カレンダー以外はスキップ
    if (!row[2] || !row[3]) return;

    const isAllDay = (row[4] === true || row[4] === 'TRUE');
    const eventStart = new Date(row[2]);
    const eventEnd = new Date(row[3]);

    if (isAllDay) {
      // 終日イベント: 営業時間全スロットをブロック
      let currentDay = new Date(eventStart);
      currentDay.setHours(0, 0, 0, 0);
      const eventEndDay = new Date(eventEnd);
      eventEndDay.setHours(0, 0, 0, 0);

      while (currentDay < eventEndDay) {
        const dayStr = Utilities.formatDate(currentDay, 'JST', 'yyyy-MM-dd');
        if (dayStr >= startDateStr && dayStr < endDateStr) {
          const dayBusinessStart = new Date(`${dayStr}T${businessHours.start}`);
          const dayBusinessEnd = new Date(`${dayStr}T${businessHours.end}`);
          let slotTime = new Date(dayBusinessStart);
          while (slotTime < dayBusinessEnd) {
            blockedSlots.add(`${dayStr} ${Utilities.formatDate(slotTime, 'JST', 'HH:mm')}`);
            slotTime.setMinutes(slotTime.getMinutes() + timeUnit);
          }
        }
        currentDay.setDate(currentDay.getDate() + 1);
      }
    } else {
      // 時間指定イベント: イベント期間に重なるスロットをブロック
      // イベント開始をtimeUnit境界に切り下げ
      const slotStartMinutes = Math.floor(eventStart.getMinutes() / timeUnit) * timeUnit;
      const slotStart = new Date(eventStart);
      slotStart.setMinutes(slotStartMinutes, 0, 0);

      let slotTime = new Date(slotStart);
      while (slotTime < eventEnd) {
        const slotDateStr = Utilities.formatDate(slotTime, 'JST', 'yyyy-MM-dd');
        if (slotDateStr >= endDateStr) break; // 週の範囲を超えたら終了
        if (slotDateStr >= startDateStr) {
          blockedSlots.add(`${slotDateStr} ${Utilities.formatDate(slotTime, 'JST', 'HH:mm')}`);
        }
        slotTime.setMinutes(slotTime.getMinutes() + timeUnit);
      }
    }
  });

  return blockedSlots;
}

/**
 * ブロックカレンダーのSync Tokenをすべてリセットする（管理者用ユーティリティ）
 * 次回のgetAvailableSlots呼び出し時に自動でフル同期が実行される
 */
function resetBlockSyncTokens() {
  const props = PropertiesService.getScriptProperties();
  const allProps = props.getProperties();
  let count = 0;
  Object.keys(allProps).forEach(key => {
    if (key.startsWith('blockSyncToken_')) {
      props.deleteProperty(key);
      count++;
    }
  });
  Logger.log(`ブロックカレンダーのSync Tokenを${count}件リセットしました。次回呼び出し時にフル同期が実行されます。`);
}

/**
 * 全ブロックカレンダーの同期状態を確認するデバッグ用関数（GASエディタから手動実行）
 */
function debugBlockSync() {
  const configs = getConfigs();
  const allIds = getAllBlockCalendarIds_(configs);
  Logger.log('block calendar ids: ' + JSON.stringify(allIds));
  resetBlockSyncTokens();
  syncBlockCalendars(allIds);
  const sheet = getSpreadsheet_().getSheetByName('ブロック予定同期');
  Logger.log('sync sheet lastRow: ' + (sheet ? sheet.getLastRow() : 'NO SHEET'));
}


// =================================================================
// 複数日程一括予約
// =================================================================

/**
 * 複数日程の予約を一括で作成する。
 * 全スロットのチェックをLockService配下で先行して実施し、
 * 1件でも空きがなければ全件をキャンセルしてエラーを返す（アトミック処理）。
 * @param {Array} bookingDataList - 予約情報の配列
 * @returns {Array} 作成された予約情報の配列
 */
function createBulkBookings(bookingDataList) {
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);

  try {
    const configs = getConfigs();
    const timeUnit = parseInt(configs.bookingTimeUnit || 30, 10);
    const maxBookings = parseInt(configs.maxConcurrentBookings || 1, 10);
    const maxBulkBookings = parseInt(configs.maxBulkBookings || 1, 10);

    if (bookingDataList.length > maxBulkBookings) {
      throw new Error(`一括予約の上限（${maxBulkBookings}件）を超えています。`);
    }
    if (!configs.reservationCalendarId) {
      throw new Error('予約カレンダーが設定されていません。設定画面でGoogleカレンダーIDを登録してください。');
    }

    const reservationSheet = getReservationSheet(configs);
    const data = reservationSheet.getDataRange().getValues();
    const headers = data[0];
    const statusCol = headers.indexOf('ステータス');
    const startTimeCol = headers.indexOf('予約日時');
    const endTimeCol = headers.indexOf('終了日時');
    const staffEmailCol = headers.indexOf('担当者Email');

    // バッチ内の予約同士が占有するスロットを事前計算（バッチ内競合チェック用）
    const batchSlotCounts = new Map();
    for (const bd of bookingDataList) {
      const s = new Date(bd.startDateTime);
      const e = new Date(s.getTime() + bd.duration * 60000);
      let t = new Date(s);
      while (t < e) {
        const key = Utilities.formatDate(t, 'JST', 'yyyy-MM-dd HH:mm');
        batchSlotCounts.set(key, (batchSlotCounts.get(key) || 0) + 1);
        t.setMinutes(t.getMinutes() + timeUnit);
      }
    }

    // Step 1: 全日時の空き枠を先行チェック（既存予約 + バッチ内競合を考慮）
    for (const bookingData of bookingDataList) {
      const { startDateTime, duration, staffEmail } = bookingData;
      const startTime = new Date(startDateTime);
      if (!isSlotBookableBySameDayRules_(startTime, configs)) {
        throw new Error('当日予約は受け付けておりません。');
      }
      const endTime = new Date(startTime.getTime() + duration * 60000);
      const isStaffNominated = staffEmail && staffEmail !== 'any';
      const effectiveMaxBookings = isStaffNominated ? 1 : maxBookings;

      let checkTime = new Date(startTime);
      while (checkTime < endTime) {
        // 既存予約のカウント
        let concurrentBookings = 0;
        for (let i = 1; i < data.length; i++) {
          const row = data[i];
          const status = row[statusCol];
          if (status !== '予約' && status !== '仮予約') continue;
          if (isStaffNominated && row[staffEmailCol] !== staffEmail) continue;
          const existingStart = new Date(row[startTimeCol]);
          const existingEnd = new Date(row[endTimeCol]);
          if (checkTime >= existingStart && checkTime < existingEnd) {
            concurrentBookings++;
          }
        }

        // バッチ内の他予約が同スロットを占有する分を加算（バッチ内2件以上が同時間帯に重複しないか確認）
        const batchKey = Utilities.formatDate(checkTime, 'JST', 'yyyy-MM-dd HH:mm');
        const batchCount = batchSlotCounts.get(batchKey) || 0;
        // この予約自身の分（1）を差し引き、他の予約の分だけ加算
        concurrentBookings += (batchCount - 1);

        if (concurrentBookings >= effectiveMaxBookings) {
          const timeStr = Utilities.formatDate(checkTime, 'JST', 'HH:mm');
          const dateStr = Utilities.formatDate(startTime, 'JST', 'M月d日');
          throw new Error(`${dateStr} ${timeStr} の枠はすでに埋まっています。全件の予約をキャンセルしました。`);
        }
        checkTime.setMinutes(checkTime.getMinutes() + timeUnit);
      }
    }

    // Step 2: 全件チェックOK → 日時順にソートして全件書き込み
    const sortedList = bookingDataList.slice().sort(
      (a, b) => new Date(a.startDateTime) - new Date(b.startDateTime)
    );

    const calendar = CalendarApp.getCalendarById(configs.reservationCalendarId);
    if (!calendar) throw new Error('予約カレンダーが見つかりません。');

    const results = [];
    for (const bookingData of sortedList) {
      const { lineUserId, userName, menuName, duration, startDateTime, staffEmail, staffName } = bookingData;
      const startTime = new Date(startDateTime);
      const endTime = new Date(startTime.getTime() + duration * 60000);

      const newBookingId = generateBookingId();
      reservationSheet.appendRow([
        newBookingId, '予約', lineUserId, userName, menuName,
        startTime, endTime, '', staffName || '', staffEmail || ''
      ]);

      const eventTitle = staffName && staffEmail !== 'any'
        ? `【${userName}様／担当：${staffName}】${menuName}`
        : `【${userName}様】${menuName}`;
      const event = calendar.createEvent(eventTitle, startTime, endTime);
      reservationSheet.getRange(
        reservationSheet.getLastRow(),
        headers.indexOf('イベントID') + 1
      ).setValue(event.getId());

      updateTimetableSlots_(startTime, endTime, timeUnit);

      results.push({
        bookingId: newBookingId,
        eventTitle: eventTitle,
        startTime: startTime.toISOString(),
        endTime: endTime.toISOString(),
        shopName: configs.shopName
      });
    }

    return results;

  } catch (e) {
    Logger.log(`一括予約エラー: ${e.message}`);
    throw e;
  } finally {
    lock.releaseLock();
  }
}


// =================================================================
// 満席タイムテーブル ユーティリティ
// =================================================================

/** スプレッドシートのテキスト強制値（先頭 '）を除去する */
function stripSheetText_(value) {
  let s = String(value == null ? '' : value).trim();
  if (s.startsWith("'")) s = s.slice(1);
  return s;
}

/** Date を JST スロットキー "yyyy-MM-dd HH:mm" に変換する */
function formatJstSlotKey_(date) {
  const d = date instanceof Date ? date : new Date(date);
  if (isNaN(d.getTime())) return '';
  return Utilities.formatDate(d, 'JST', 'yyyy-MM-dd') + ' ' + Utilities.formatDate(d, 'JST', 'HH:mm');
}

/**
 * 予約シートの日時セルを Date に変換する（JST 基準）
 * appendRow 由来の Date オブジェクトはそのまま利用する。
 */
function parseReservationDateTime_(cellValue) {
  if (cellValue instanceof Date) return new Date(cellValue.getTime());
  const s = stripSheetText_(cellValue);
  if (!s) return new Date(NaN);
  if (/^\d{4}-\d{2}-\d{2}T/.test(s)) return new Date(s);
  const m = s.replace(/\//g, '-').match(/^(\d{4}-\d{2}-\d{2})[ T](\d{1,2}):(\d{2})/);
  if (m) {
    return new Date(`${m[1]}T${String(m[2]).padStart(2, '0')}:${m[3]}:00+09:00`);
  }
  return new Date(s);
}

/** 満席タイムテーブルの日付・時間セルを正規化キー "yyyy-MM-dd HH:mm" に変換する */
function normalizeTimetableSlotKey_(dateVal, timeVal) {
  if (dateVal instanceof Date && timeVal instanceof Date) {
    return formatJstSlotKey_(dateVal);
  }
  const dateStr = dateVal instanceof Date
    ? Utilities.formatDate(dateVal, 'JST', 'yyyy-MM-dd')
    : stripSheetText_(dateVal).substring(0, 10);
  let timeStr;
  if (timeVal instanceof Date) {
    // 時刻のみセル（1899-12-30 基点）は JST の HH:mm をそのまま使う
    timeStr = Utilities.formatDate(timeVal, 'JST', 'HH:mm');
  } else {
    timeStr = stripSheetText_(timeVal).substring(0, 5);
  }
  return `${dateStr} ${timeStr}`;
}

/** 満席タイムテーブルを読み込み、同一日時の重複行は予約数を合算する */
function readTimetableSlotMap_(availabilitySheet) {
  const slotMap = new Map();
  const lastRow = availabilitySheet.getLastRow();
  if (lastRow < 2) return slotMap;

  const numRows = lastRow - 1;
  const existingData = availabilitySheet.getRange(2, 1, numRows, 3).getValues();
  existingData.forEach(row => {
    const key = normalizeTimetableSlotKey_(row[0], row[1]);
    if (!key || key.length < 12) return;
    slotMap.set(key, (slotMap.get(key) || 0) + (parseInt(row[2], 10) || 0));
  });
  return slotMap;
}

/**
 * スロットMapを満席タイムテーブルへ重複なく書き戻す。
 * 日付・時間はテキスト（先頭 '）で書き込み、スプレッドシートのタイムゾーンによるずれを防ぐ。
 */
function writeTimetableFromMap_(availabilitySheet, slotMap) {
  availabilitySheet.clearContents();
  availabilitySheet.appendRow(['日付', '時間枠', '予約数']);

  const rows = [];
  slotMap.forEach((count, key) => {
    if (count <= 0) return;
    const spaceIdx = key.indexOf(' ');
    const dateStr = key.substring(0, spaceIdx);
    const timeStr = key.substring(spaceIdx + 1);
    rows.push(["'" + dateStr, "'" + timeStr, count]);
  });
  rows.sort((a, b) => `${stripSheetText_(a[0])} ${stripSheetText_(a[1])}`.localeCompare(
    `${stripSheetText_(b[0])} ${stripSheetText_(b[1])}`
  ));

  if (rows.length > 0) {
    availabilitySheet.getRange(2, 1, rows.length, 3).setValues(rows);
  }
}

/**
 * 予約シート（予約/仮予約）から満席タイムテーブルを全件再構築する（正のデータ源）。
 */
function rebuildTimetableFromReservations_() {
  const configs = getConfigs();
  const timeUnit = parseInt(configs.bookingTimeUnit || 30, 10);
  const availabilitySheet = getSpreadsheet_().getSheetByName('満席タイムテーブル');
  if (!availabilitySheet) return;

  const reservationSheet = getReservationSheet(configs);
  const data = reservationSheet.getDataRange().getValues();
  if (data.length < 2) {
    writeTimetableFromMap_(availabilitySheet, new Map());
    return;
  }

  const h = data[0];
  const statusCol = h.indexOf('ステータス');
  const startCol = h.indexOf('予約日時');
  const endCol = h.indexOf('終了日時');
  const slotMap = new Map();

  for (let i = 1; i < data.length; i++) {
    const status = data[i][statusCol];
    if (status !== '予約' && status !== '仮予約') continue;

    const startTime = parseReservationDateTime_(data[i][startCol]);
    const endTime = parseReservationDateTime_(data[i][endCol]);
    if (isNaN(startTime.getTime()) || isNaN(endTime.getTime())) continue;

    let slotTime = new Date(startTime.getTime());
    while (slotTime < endTime) {
      const key = formatJstSlotKey_(slotTime);
      if (key) slotMap.set(key, (slotMap.get(key) || 0) + 1);
      slotTime.setMinutes(slotTime.getMinutes() + timeUnit);
    }
  }

  writeTimetableFromMap_(availabilitySheet, slotMap);
  Logger.log('満席タイムテーブルを予約シートから再構築しました（%s スロット）', slotMap.size);
}

/** 新規予約後に満席タイムテーブルを更新する */
function updateTimetableSlots_(startTime, endTime, timeUnit) {
  rebuildTimetableFromReservations_();
}

/** キャンセル・来店確定等で予約枠を解放する */
function releaseTimetableSlots_(startTime, endTime, timeUnit) {
  rebuildTimetableFromReservations_();
}


// =================================================================
// 顧客マスタ 操作関数
// =================================================================

const CUSTOMER_SHEET_NAME = '顧客マスタ';
const CUSTOMER_HEADERS = [
  'LINE User ID', '顧客名', '性別', '年代', '電話番号', '生年月日', '住所',
  '登録日時', '最終来店日', 'メモ', 'ステータス'
];
const CUSTOMER_GENDER_OPTIONS = ['女性', '男性', '未回答'];
const CUSTOMER_AGE_GROUP_OPTIONS = ['10代', '20代', '30代', '40代', '50代', '60代', '70代', '80代'];

/**
 * 顧客マスタシートを取得する。存在しない場合は自動作成してヘッダーを設定する。
 */
function getCustomerSheet_() {
  let sheet = getSpreadsheet_().getSheetByName(CUSTOMER_SHEET_NAME);
  if (!sheet) {
    sheet = getSpreadsheet_().insertSheet(CUSTOMER_SHEET_NAME);
    Logger.log('顧客マスタシートを自動作成しました。');
  }
  ensureCustomerSheetColumns_(sheet);
  return sheet;
}

function getCustomerSheetHeaders_(sheet) {
  ensureCustomerSheetColumns_(sheet);
  const lastCol = Math.max(sheet.getLastColumn(), 1);
  return sheet.getRange(1, 1, 1, lastCol).getValues()[0].map(h => String(h).trim());
}

/** 既存シートに不足カラムを追加する */
function ensureCustomerSheetColumns_(sheet) {
  const lastCol = Math.max(sheet.getLastColumn(), 0);
  let headers = lastCol > 0
    ? sheet.getRange(1, 1, 1, lastCol).getValues()[0].map(h => String(h).trim())
    : [];

  if (headers.length === 0 || headers.every(h => !h)) {
    sheet.clear();
    sheet.appendRow(CUSTOMER_HEADERS);
    sheet.getRange(1, 1, 1, CUSTOMER_HEADERS.length).setFontWeight('bold');
    return;
  }

  let changed = false;
  CUSTOMER_HEADERS.forEach(header => {
    if (headers.indexOf(header) === -1) {
      sheet.getRange(1, sheet.getLastColumn() + 1).setValue(header);
      headers.push(header);
      changed = true;
    }
  });
  if (changed) {
    sheet.getRange(1, 1, 1, sheet.getLastColumn()).setFontWeight('bold');
  }
}

function validateCustomerGender_(gender) {
  if (!gender || CUSTOMER_GENDER_OPTIONS.indexOf(String(gender)) === -1) {
    throw new Error('性別を選択してください。');
  }
}

function validateCustomerAgeGroup_(ageGroup) {
  if (!ageGroup || CUSTOMER_AGE_GROUP_OPTIONS.indexOf(String(ageGroup)) === -1) {
    throw new Error('年代を選択してください。');
  }
}

function formatBirthDateForStorage_(value) {
  if (value === null || value === undefined || value === '') return '';
  if (value instanceof Date && !isNaN(value.getTime())) {
    return Utilities.formatDate(value, 'JST', 'yyyy-MM-dd');
  }
  const s = String(value).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const d = new Date(s);
  if (!isNaN(d.getTime())) return Utilities.formatDate(d, 'JST', 'yyyy-MM-dd');
  throw new Error('生年月日の形式が正しくありません（yyyy-MM-dd）。');
}

function formatBirthDateForDisplay_(value) {
  if (!value) return '';
  if (value instanceof Date && !isNaN(value.getTime())) {
    return Utilities.formatDate(value, 'JST', 'yyyy-MM-dd');
  }
  const s = String(value).trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.substring(0, 10);
  return s;
}

function buildCustomerRowValues_(headers, record) {
  return headers.map(header => {
    const val = record[header];
    if (header === '電話番号') return formatPhoneForStorage_(val || '');
    if (header === '生年月日') return val ? formatBirthDateForStorage_(val) : '';
    if (val instanceof Date) return val;
    return val !== undefined && val !== null ? val : '';
  });
}

function appendCustomerRow_(sheet, record) {
  const headers = getCustomerSheetHeaders_(sheet);
  sheet.appendRow(buildCustomerRowValues_(headers, record));
  const phoneCol = headers.indexOf('電話番号') + 1;
  if (phoneCol > 0 && record['電話番号']) {
    setPhoneCellValue_(sheet, sheet.getLastRow(), phoneCol, record['電話番号']);
  }
}

function rowToCustomerRecord_(row, headers) {
  const record = {};
  headers.forEach((header, idx) => {
    record[header] = row[idx];
  });
  return record;
}

/** 同一顧客の複数行を1レコードに統合する（管理画面の保存内容を優先） */
function mergeCustomerRecordFields_(records) {
  if (!records.length) return null;
  if (records.length === 1) return Object.assign({}, records[0]);

  const merged = {};
  merged['LINE User ID'] = normalizeCustomerUserId_(records[0]['LINE User ID']);

  ['顧客名', '性別', '年代', '電話番号', '生年月日', '住所', 'メモ'].forEach(field => {
    for (let i = records.length - 1; i >= 0; i--) {
      const v = records[i][field];
      if (v !== null && v !== undefined && String(v).trim() !== '') {
        merged[field] = v;
        break;
      }
    }
    if (merged[field] === undefined) merged[field] = '';
  });
  if (merged['顧客名']) merged['顧客名'] = normalizeCustomerName_(merged['顧客名']);

  merged['ステータス'] = records.some(r => String(r['ステータス'] || '').trim() === '無効')
    ? '無効'
    : (String(records[records.length - 1]['ステータス'] || '').trim() || '有効');

  let earliestReg = null;
  let latestVisit = null;
  records.forEach(r => {
    const reg = r['登録日時'];
    if (reg) {
      const regDt = reg instanceof Date ? reg : new Date(reg);
      if (!isNaN(regDt.getTime()) && (!earliestReg || regDt < earliestReg)) earliestReg = regDt;
    }
    const visit = r['最終来店日'];
    if (visit) {
      const visitDt = visit instanceof Date ? visit : new Date(visit);
      if (!isNaN(visitDt.getTime()) && (!latestVisit || visitDt > latestVisit)) latestVisit = visitDt;
    }
  });
  merged['登録日時'] = earliestReg || records[0]['登録日時'] || '';
  merged['最終来店日'] = latestVisit || '';

  return merged;
}

function applyCustomerRecordToRow_(sheet, rowNum, headers, record) {
  const values = buildCustomerRowValues_(headers, record);
  sheet.getRange(rowNum, 1, rowNum, values.length).setValues([values]);
  const phoneCol = headers.indexOf('電話番号') + 1;
  if (phoneCol > 0 && record['電話番号']) {
    setPhoneCellValue_(sheet, rowNum, phoneCol, record['電話番号']);
  }
}

/**
 * 顧客マスタ内の同一 LINE User ID 行を1行に統合する。
 * @returns {number} 削除した重複行数
 */
function mergeDuplicateCustomerRowsByUserId_(lineUserId) {
  const normalizedUserId = normalizeCustomerUserId_(lineUserId);
  if (!normalizedUserId) return 0;

  const sheet = getCustomerSheet_();
  const headers = getCustomerSheetHeaders_(sheet);
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return 0;

  const data = sheet.getRange(2, 1, lastRow, headers.length).getValues();
  const userIdCol = headers.indexOf('LINE User ID');
  const rowNums = [];
  const records = [];

  for (let i = 0; i < data.length; i++) {
    if (!customerUserIdMatches_(data[i][userIdCol], normalizedUserId)) continue;
    rowNums.push(i + 2);
    records.push(rowToCustomerRecord_(data[i], headers));
  }

  if (records.length <= 1) return 0;

  const merged = mergeCustomerRecordFields_(records);
  applyCustomerRecordToRow_(sheet, rowNums[0], headers, merged);
  rowNums.slice(1).sort((a, b) => b - a).forEach(r => sheet.deleteRow(r));
  Logger.log(`顧客マスタ統合: ${normalizedUserId} (${records.length}行 → 1行)`);
  return records.length - 1;
}

/** 顧客マスタ全体の重複 LINE User ID を統合する */
function mergeAllDuplicateCustomers_() {
  const sheet = getCustomerSheet_();
  const headers = getCustomerSheetHeaders_(sheet);
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return 0;

  const data = sheet.getRange(2, 1, lastRow, headers.length).getValues();
  const userIdCol = headers.indexOf('LINE User ID');
  const duplicateUserIds = new Set();

  const counts = {};
  data.forEach(row => {
    const key = normalizeCustomerUserId_(row[userIdCol]);
    if (!key) return;
    counts[key] = (counts[key] || 0) + 1;
    if (counts[key] > 1) duplicateUserIds.add(key);
  });

  let removed = 0;
  duplicateUserIds.forEach(userId => {
    removed += mergeDuplicateCustomerRowsByUserId_(userId);
  });
  if (removed > 0) Logger.log(`顧客マスタ重複統合完了: ${removed}行を削除`);
  return removed;
}

/**
 * LINE User ID で顧客マスタを検索する。
 * @param {string} lineUserId
 * @returns {Object|null} 顧客レコードのオブジェクト、未登録の場合は null
 */
function findCustomerByUserId_(lineUserId) {
  const sheet = getCustomerSheet_();
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return null;

  const headers = getCustomerSheetHeaders_(sheet);
  const data = sheet.getRange(2, 1, lastRow, headers.length).getValues();
  const userIdCol = headers.indexOf('LINE User ID');
  const statusCol = headers.indexOf('ステータス');

  for (let i = 0; i < data.length; i++) {
    if (customerUserIdMatches_(data[i][userIdCol], lineUserId) && data[i][statusCol] !== '無効') {
      return rowToCustomerRecord_(data[i], headers);
    }
  }
  return null;
}

/** 顧客名から空白を除去する（検索・表示の統一用） */
function normalizeCustomerName_(name) {
  return String(name || '').replace(/\s+/g, '');
}

/** 電話番号を文字列として正規化（先頭0消失の補正を含む） */
function formatPhoneForStorage_(phone) {
  if (phone === null || phone === undefined || phone === '') return '';
  let s = (typeof phone === 'number') ? String(Math.trunc(phone)) : String(phone).trim();
  if (s.startsWith("'")) s = s.slice(1);
  s = s.replace(/[^\d-]/g, '');
  if (/^\d+$/.test(s) && !s.startsWith('0') && (s.length === 9 || s.length === 10)) {
    s = '0' + s;
  }
  return s;
}

/** 電話番号セルを文字列形式で書き込む */
function setPhoneCellValue_(sheet, row, col, phone) {
  const formatted = formatPhoneForStorage_(phone);
  const cell = sheet.getRange(row, col);
  cell.setNumberFormat('@');
  cell.setValue(formatted);
}

/**
 * 新規顧客を顧客マスタに登録する。
 */
function registerCustomer(lineUserId, customerName, gender, ageGroup) {
  if (!lineUserId || !customerName || !normalizeCustomerName_(customerName)) {
    throw new Error('LINE User ID と顧客名は必須です。');
  }
  validateCustomerGender_(gender);
  validateCustomerAgeGroup_(ageGroup);

  const normalizedName = normalizeCustomerName_(customerName);

  const existing = findCustomerByUserId_(lineUserId);
  if (existing) {
    Logger.log(`顧客登録スキップ: ${lineUserId} はすでに登録済みです。`);
    return existing;
  }

  const sheet = getCustomerSheet_();
  const now = new Date();
  const record = {
    'LINE User ID': lineUserId,
    '顧客名': normalizedName,
    '性別': gender,
    '年代': ageGroup,
    '電話番号': '',
    '生年月日': '',
    '住所': '',
    '登録日時': now,
    '最終来店日': '',
    'メモ': '',
    'ステータス': '有効'
  };
  appendCustomerRow_(sheet, record);
  mergeDuplicateCustomerRowsByUserId_(lineUserId);
  Logger.log(`顧客登録完了: ${normalizedName} (${lineUserId})`);

  return {
    'LINE User ID': lineUserId,
    '顧客名': normalizedName,
    '性別': gender,
    '年代': ageGroup,
    '電話番号': '',
    '生年月日': '',
    '住所': '',
    '登録日時': now.toISOString(),
    'ステータス': '有効'
  };
}

// =================================================================
// 店舗向け管理機能（kanri.html から google.script.run で呼び出す）
// =================================================================

function formatJstDate_(value) {
  const d = value instanceof Date ? value : new Date(value);
  if (isNaN(d.getTime())) return '';
  return Utilities.formatDate(d, 'JST', 'yyyy-MM-dd');
}

function rowToBookingObject_(row, h) {
  const toISO = (v) => v instanceof Date ? v.toISOString() : String(v);
  return {
    bookingId:  row[h.indexOf('予約ID')],
    status:     row[h.indexOf('ステータス')],
    lineUserId: row[h.indexOf('LINE User ID')],
    userName:   row[h.indexOf('顧客名')],
    menuName:   row[h.indexOf('メニュー名')],
    startTime:  toISO(row[h.indexOf('予約日時')]),
    endTime:    toISO(row[h.indexOf('終了日時')]),
    eventId:    row[h.indexOf('イベントID')],
    staffName:  row[h.indexOf('担当者名')],
  };
}

function matchesBookingDateFilter_(startTime, filterType, now) {
  if (filterType === 'all' || filterType === 'upcoming') return true;

  const startStr = formatJstDate_(startTime);
  if (!startStr) return false;

  const todayStr = formatJstDate_(now);
  if (filterType === 'today') return startStr === todayStr;
  if (filterType === 'recent') {
    const endDate = new Date(now);
    endDate.setDate(endDate.getDate() + 2);
    const endStr = formatJstDate_(endDate);
    return startStr >= todayStr && startStr <= endStr;
  }
  return false;
}

function filterBookingsByKeyword_(bookings, keyword) {
  const q = normalizeCustomerName_(keyword);
  if (!q) return bookings;
  const customerNameMap = buildCustomerNameMap_();
  return bookings.filter(b => {
    const registeredName = customerNameMap[b.lineUserId] || '';
    return normalizeCustomerName_(b.userName).includes(q)
      || normalizeCustomerName_(registeredName).includes(q);
  });
}

function buildCustomerNameMap_() {
  const map = {};
  readCustomersFromSheet_(getCustomerSheet_()).forEach(c => { map[c.lineUserId] = c.name; });
  readArchivedCustomers_().forEach(c => {
    if (!map[c.lineUserId]) map[c.lineUserId] = c.name;
  });
  return map;
}

function getArchivedBookings_() {
  const configs = getConfigs();
  if (!configs.archiveSpreadsheetId) return [];
  try {
    const archiveSS = SpreadsheetApp.openById(configs.archiveSpreadsheetId);
    const sheet = archiveSS.getSheetByName('予約');
    if (!sheet || sheet.getLastRow() < 2) return [];
    const data = sheet.getDataRange().getValues();
    const h = data[0];
    const bookings = [];
    for (let i = 1; i < data.length; i++) {
      const row = data[i];
      if (!row[h.indexOf('予約ID')]) continue;
      bookings.push(rowToBookingObject_(row, h));
    }
    return bookings;
  } catch (e) {
    Logger.log('アーカイブ予約取得エラー: %s', e.message);
    return [];
  }
}

/**
 * 予約一覧を返す（管理画面用）。
 * @param {string} filterType - 'today' | 'recent' | 'all' | 'past'
 * @param {string} searchKeyword - 顧客名の部分一致（任意）
 */
function getBookingsForManagement(filterType, searchKeyword) {
  const filter = filterType || 'all';
  const keyword = String(searchKeyword || '').trim();

  if (filter === 'past') {
    return filterBookingsByKeyword_(getArchivedBookings_(), keyword)
      .sort((a, b) => new Date(b.startTime) - new Date(a.startTime));
  }

  const configs = getConfigs();
  const sheet = getReservationSheet(configs);
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];

  const lastCol = sheet.getLastColumn();
  const data = sheet.getRange(1, 1, lastRow, lastCol).getValues();
  const h = data[0];
  const bookingIdCol = h.indexOf('予約ID');
  const startTimeCol = h.indexOf('予約日時');
  if (bookingIdCol < 0 || startTimeCol < 0) {
    throw new Error('予約シートのヘッダーが不正です。');
  }

  const now = new Date();
  const bookings = [];

  for (let i = 1; i < data.length; i++) {
    const row = data[i];
    const bookingId = row[bookingIdCol];
    if (bookingId === '' || bookingId === null || bookingId === undefined) continue;
    if (!matchesBookingDateFilter_(row[startTimeCol], filter, now)) continue;
    bookings.push(rowToBookingObject_(row, h));
  }

  return filterBookingsByKeyword_(bookings, keyword)
    .sort((a, b) => new Date(a.startTime) - new Date(b.startTime));
}

/**
 * 終業後処理用: 現在時刻より前の未確定予約（ステータス「予約」「仮予約」）一覧を返す。
 * 本日以前の未処理分も含む。
 */
function getUnconfirmedTodayBookings() {
  const configs = getConfigs();
  const sheet   = getReservationSheet(configs);
  const data    = sheet.getDataRange().getValues();
  const h       = data[0];
  const bookingIdCol = h.indexOf('予約ID');
  const statusCol    = h.indexOf('ステータス');
  const userNameCol  = h.indexOf('顧客名');
  const menuNameCol  = h.indexOf('メニュー名');
  const startTimeCol = h.indexOf('予約日時');
  const endTimeCol   = h.indexOf('終了日時');
  const staffNameCol = h.indexOf('担当者名');

  const now = new Date();

  const bookings = [];
  for (let i = 1; i < data.length; i++) {
    const row    = data[i];
    const status = row[statusCol];
    if (!row[bookingIdCol] || (status !== '予約' && status !== '仮予約')) continue;
    const startTime = new Date(row[startTimeCol]);
    if (isNaN(startTime.getTime()) || startTime >= now) continue;
    bookings.push({
      bookingId: row[bookingIdCol],
      status:    status,
      userName:  row[userNameCol],
      menuName:  row[menuNameCol],
      startTime: startTime.toISOString(),
      endTime:   new Date(row[endTimeCol]).toISOString(),
      staffName: row[staffNameCol]
    });
  }
  return bookings.sort((a, b) => new Date(a.startTime) - new Date(b.startTime));
}

/**
 * 予約カレンダー上のイベントを取得する（カレンダーID指定 → グローバル検索）
 */
function getReservationCalendarEvent_(configs, eventId) {
  const id = String(eventId || '').trim();
  if (!id) return null;

  const calendarId = String((configs && configs.reservationCalendarId) || '').trim();
  if (calendarId) {
    try {
      const calendar = CalendarApp.getCalendarById(calendarId);
      if (calendar) {
        const event = calendar.getEventById(id);
        if (event) return event;
      }
    } catch (e) {
      Logger.log('カレンダーイベント取得（calendarId指定）: %s', e.message);
    }
  }

  try {
    return CalendarApp.getEventById(id);
  } catch (e) {
    Logger.log('カレンダーイベント取得（global）: %s', e.message);
    return null;
  }
}

/**
 * ステータス確定に伴う Google カレンダーイベントの更新
 * - キャンセル / 無断キャンセル: イベント削除
 * - 来店: カレンダーは変更しない（予約管理画面でステータス管理）
 */
function applyCalendarEventStatusChange_(configs, eventId, status) {
  const normalizedStatus = String(status || '').trim();
  if (normalizedStatus !== 'キャンセル' && normalizedStatus !== '無断キャンセル') return false;

  const event = getReservationCalendarEvent_(configs, eventId);
  if (!event) {
    throw new Error('Googleカレンダーの予定が見つかりませんでした。');
  }
  event.deleteEvent();
  return true;
}

/**
 * 予約ステータスを確定する。
 * - 来店: 顧客マスタの最終来店日を更新（カレンダーは変更しない）
 * - 無断キャンセル / キャンセル: カレンダーイベントを削除
 * @param {string} bookingId
 * @param {string} newStatus - '来店' | '無断キャンセル' | 'キャンセル'
 */
function confirmBookingStatus(bookingId, newStatus) {
  const status = String(newStatus || '').trim();
  const configs = getConfigs();
  const sheet   = getReservationSheet(configs);
  const data    = sheet.getDataRange().getValues();
  const h       = data[0];
  const bookingIdCol = h.indexOf('予約ID');
  const statusCol    = h.indexOf('ステータス');
  const eventIdCol   = h.indexOf('イベントID');
  const startTimeCol = h.indexOf('予約日時');
  const endTimeCol   = h.indexOf('終了日時');
  const userIdCol    = h.indexOf('LINE User ID');

  let targetRow = -1, eventId = '', lineUserId = '', startTime = null, endTime = null, oldStatus = '';
  for (let i = 1; i < data.length; i++) {
    if (data[i][bookingIdCol] === bookingId) {
      targetRow  = i + 1;
      eventId    = data[i][eventIdCol];
      lineUserId = data[i][userIdCol];
      startTime  = new Date(data[i][startTimeCol]);
      endTime    = new Date(data[i][endTimeCol]);
      oldStatus  = data[i][statusCol];
      break;
    }
  }
  if (targetRow === -1) throw new Error(`予約ID「${bookingId}」が見つかりません。`);

  sheet.getRange(targetRow, statusCol + 1).setValue(status);

  if (eventId && (status === 'キャンセル' || status === '無断キャンセル')) {
    applyCalendarEventStatusChange_(configs, eventId, status);
    sheet.getRange(targetRow, eventIdCol + 1).setValue('');
  } else if (eventId) {
    Logger.log('カレンダー更新スキップ: status=%s bookingId=%s', status, bookingId);
  } else if (status === 'キャンセル' || status === '無断キャンセル') {
    Logger.log('カレンダー更新スキップ: イベントIDなし bookingId=%s status=%s', bookingId, status);
  }

  const wasActive = oldStatus === '予約' || oldStatus === '仮予約';
  const releasesSlot = status === '来店' || status === 'キャンセル' || status === '無断キャンセル';
  if (wasActive && releasesSlot) {
    const timeUnit = parseInt(configs.bookingTimeUnit || 30, 10);
    releaseTimetableSlots_(startTime, endTime, timeUnit);
  }

  if (status === '来店' && lineUserId) {
    updateCustomerLastVisit_(lineUserId, startTime);
  }

  Logger.log(`ステータス更新: ${bookingId} → ${status}`);
}

/**
 * 複数予約を一括でステータス確定する。
 * @param {string[]} bookingIds
 * @param {string} status
 */
function batchConfirmStatuses(bookingIds, status) {
  bookingIds.forEach(id => {
    try { confirmBookingStatus(id, status); }
    catch (e) { Logger.log(`バッチ確定エラー (${id}): ${e.message}`); }
  });
}

/** 顧客マスタの最終来店日を更新する。 */
function updateCustomerLastVisit_(lineUserId, visitDate) {
  const sheet = getCustomerSheet_();
  const data  = sheet.getDataRange().getValues();
  const h     = data[0];
  const userIdCol    = h.indexOf('LINE User ID');
  const lastVisitCol = h.indexOf('最終来店日');
  if (lastVisitCol === -1) return;
  for (let i = 1; i < data.length; i++) {
    if (data[i][userIdCol] === lineUserId) {
      sheet.getRange(i + 1, lastVisitCol + 1).setValue(visitDate);
      return;
    }
  }
}

/**
 * 顧客マスタ一覧を返す（管理画面用）。アーカイブ済みの無効顧客も含む。
 */
function normalizeCustomerUserId_(lineUserId) {
  return String(lineUserId || '').trim();
}

function customerUserIdMatches_(rowValue, lineUserId) {
  return normalizeCustomerUserId_(rowValue) === normalizeCustomerUserId_(lineUserId);
}

function getCustomersForManagement() {
  mergeAllDuplicateCustomers_();
  const customers = readCustomersFromSheet_(getCustomerSheet_());
  const archived = readArchivedCustomers_();
  const merged = new Map();
  customers.forEach(c => {
    const key = normalizeCustomerUserId_(c.lineUserId);
    if (key) merged.set(key, Object.assign({}, c, { lineUserId: key }));
  });
  archived.forEach(c => {
    const key = normalizeCustomerUserId_(c.lineUserId);
    if (key && !merged.has(key)) merged.set(key, Object.assign({}, c, { lineUserId: key }));
  });
  return Array.from(merged.values()).map(c => Object.assign(c, computeCustomerAnalytics_(c.lineUserId)));
}

/** 予約シート（＋アーカイブ）から顧客の全予約を収集 */
function getAllBookingsForCustomer_(lineUserId) {
  const configs = getConfigs();
  const bookings = [];

  const collectFromSheet = (sheet) => {
    if (!sheet || sheet.getLastRow() < 2) return;
    const data = sheet.getDataRange().getValues();
    const h = data[0];
    const userIdCol = h.indexOf('LINE User ID');
    if (userIdCol < 0) return;
    const statusCol = h.indexOf('ステータス');
    const menuCol = h.indexOf('メニュー名');
    const startCol = h.indexOf('予約日時');
    const staffCol = h.indexOf('担当者名');
    const staffEmailCol = h.indexOf('担当者Email');

    for (let i = 1; i < data.length; i++) {
      if (data[i][userIdCol] !== lineUserId) continue;
      const startTime = new Date(data[i][startCol]);
      if (isNaN(startTime.getTime())) continue;
      bookings.push({
        status: data[i][statusCol],
        menuName: data[i][menuCol],
        startTime: startTime,
        staffName: staffCol >= 0 ? data[i][staffCol] : '',
        staffEmail: staffEmailCol >= 0 ? data[i][staffEmailCol] : '',
      });
    }
  };

  collectFromSheet(getReservationSheet(configs));
  if (configs.archiveSpreadsheetId) {
    try {
      const archiveSS = SpreadsheetApp.openById(configs.archiveSpreadsheetId);
      collectFromSheet(archiveSS.getSheetByName('予約'));
    } catch (e) {
      Logger.log('アーカイブ予約取得エラー: %s', e.message);
    }
  }
  return bookings;
}

/**
 * 予約データから顧客分析指標を算出する（管理画面表示用）
 */
function computeCustomerAnalytics_(lineUserId) {
  const bookings = getAllBookingsForCustomer_(lineUserId);
  const visits = bookings.filter(b => b.status === '来店');
  const cancels = bookings.filter(b => b.status === 'キャンセル');
  const noShows = bookings.filter(b => b.status === '無断キャンセル');
  const terminal = visits.length + cancels.length + noShows.length;

  let firstVisitDate = '';
  if (visits.length > 0) {
    const earliest = visits.reduce((a, b) => (a.startTime < b.startTime ? a : b));
    firstVisitDate = formatJstDate_(earliest.startTime);
  }

  const cancelRate = terminal > 0 ? Math.round(cancels.length / terminal * 100) : 0;
  const noShowRate = terminal > 0 ? Math.round(noShows.length / terminal * 100) : 0;

  const menuCounts = {};
  const menuSource = visits.length > 0 ? visits : bookings.filter(b => b.menuName);
  menuSource.forEach(b => {
    menuCounts[b.menuName] = (menuCounts[b.menuName] || 0) + 1;
  });
  const topMenu = Object.keys(menuCounts).sort((a, b) => menuCounts[b] - menuCounts[a])[0] || '';

  const staffSource = bookings.filter(b => b.status === '来店' || b.status === '予約');
  let staffTendency = '';
  if (staffSource.length > 0) {
    const nominated = {};
    let noneCount = 0;
    staffSource.forEach(b => {
      const email = b.staffEmail;
      const name = b.staffName;
      if (!email || email === 'any' || !name || name === '指名なし') {
        noneCount++;
      } else {
        nominated[name] = (nominated[name] || 0) + 1;
      }
    });
    const parts = Object.entries(nominated)
      .sort((a, b) => b[1] - a[1])
      .map(([name, count]) => `${name}(${Math.round(count / staffSource.length * 100)}%)`);
    if (noneCount > 0) {
      parts.push(`指名なし(${Math.round(noneCount / staffSource.length * 100)}%)`);
    }
    staffTendency = parts.join(' / ');
  }

  return {
    visitCount: visits.length,
    firstVisitDate: firstVisitDate,
    cancelRate: cancelRate,
    noShowRate: noShowRate,
    topMenu: topMenu,
    staffTendency: staffTendency,
  };
}

function readCustomersFromSheet_(sheet) {
  if (!sheet) return [];
  const data = sheet.getDataRange().getValues();
  if (data.length <= 1) return [];
  return mapCustomerRows_(data);
}

function readArchivedCustomers_() {
  const configs = getConfigs();
  if (!configs.archiveSpreadsheetId) return [];
  try {
    const archiveSS = SpreadsheetApp.openById(configs.archiveSpreadsheetId);
    const sheet = archiveSS.getSheetByName('顧客マスタ');
    if (!sheet || sheet.getLastRow() < 2) return [];
    return mapCustomerRows_(sheet.getDataRange().getValues(), true);
  } catch (e) {
    Logger.log('アーカイブ顧客取得エラー: %s', e.message);
    return [];
  }
}

function mapCustomerRows_(data, fromArchive) {
  const h = data[0];
  const userIdCol    = h.indexOf('LINE User ID');
  const nameCol      = h.indexOf('顧客名');
  const genderCol    = h.indexOf('性別');
  const ageGroupCol  = h.indexOf('年代');
  const phoneCol     = h.indexOf('電話番号');
  const birthDateCol = h.indexOf('生年月日');
  const addressCol   = h.indexOf('住所');
  const regDateCol   = h.indexOf('登録日時');
  const lastVisitCol = h.indexOf('最終来店日');
  const memoCol      = h.indexOf('メモ');
  const statusCol    = h.indexOf('ステータス');
  const toISO = (v) => v instanceof Date ? v.toISOString() : String(v || '');

  return data.slice(1)
    .filter(row => row[userIdCol])
    .map(row => ({
      lineUserId:   normalizeCustomerUserId_(row[userIdCol]),
      name:         row[nameCol],
      gender:       genderCol >= 0 ? (row[genderCol] || '') : '',
      ageGroup:     ageGroupCol >= 0 ? (row[ageGroupCol] || '') : '',
      phone:        phoneCol >= 0 ? formatPhoneForStorage_(row[phoneCol]) : '',
      birthDate:    birthDateCol >= 0 ? formatBirthDateForDisplay_(row[birthDateCol]) : '',
      address:      addressCol >= 0 ? String(row[addressCol] || '') : '',
      registeredAt: toISO(row[regDateCol]),
      lastVisit:    row[lastVisitCol] ? toISO(row[lastVisitCol]) : '',
      memo:         memoCol >= 0 ? (row[memoCol] || '') : '',
      status:       row[statusCol] || '有効',
      fromArchive:  !!fromArchive,
    }));
}

/**
 * アーカイブ顧客マスタから顧客マスタへ復元する。
 */
function restoreCustomerFromArchive_(lineUserId) {
  const configs = getConfigs();
  if (!configs.archiveSpreadsheetId) throw new Error('顧客が見つかりません。');

  const archiveSS = SpreadsheetApp.openById(configs.archiveSpreadsheetId);
  const archiveSheet = archiveSS.getSheetByName('顧客マスタ');
  if (!archiveSheet || archiveSheet.getLastRow() < 2) throw new Error('顧客が見つかりません。');

  const data = archiveSheet.getDataRange().getValues();
  const h = data[0];
  const userIdCol = h.indexOf('LINE User ID');

  for (let i = 1; i < data.length; i++) {
    if (!customerUserIdMatches_(data[i][userIdCol], lineUserId)) continue;
    const masterSheet = getCustomerSheet_();
    const record = rowToCustomerRecord_(data[i], h);
    appendCustomerRow_(masterSheet, record);
    archiveSheet.deleteRow(i + 1);
    return;
  }
  throw new Error('顧客が見つかりません。');
}

/**
 * 顧客マスタ1行分の変更を反映する。
 */
function applyCustomerInfoChanges_(sheet, rowNum, headers, changes) {
  const nameCol   = headers.indexOf('顧客名');
  const genderCol = headers.indexOf('性別');
  const ageGroupCol = headers.indexOf('年代');
  const phoneCol  = headers.indexOf('電話番号');
  const birthDateCol = headers.indexOf('生年月日');
  const addressCol = headers.indexOf('住所');
  const memoCol   = headers.indexOf('メモ');
  const statusCol = headers.indexOf('ステータス');

  if (statusCol < 0 && changes.status !== undefined) {
    throw new Error('顧客マスタに「ステータス」列が見つかりません。');
  }

  if (changes.name   !== undefined && nameCol >= 0) {
    sheet.getRange(rowNum, nameCol + 1).setValue(normalizeCustomerName_(changes.name));
  }
  if (changes.gender !== undefined && genderCol >= 0) {
    if (changes.gender) validateCustomerGender_(changes.gender);
    sheet.getRange(rowNum, genderCol + 1).setValue(changes.gender || '');
  }
  if (changes.ageGroup !== undefined && ageGroupCol >= 0) {
    if (changes.ageGroup) validateCustomerAgeGroup_(changes.ageGroup);
    sheet.getRange(rowNum, ageGroupCol + 1).setValue(changes.ageGroup || '');
  }
  if (changes.phone !== undefined && phoneCol >= 0) {
    setPhoneCellValue_(sheet, rowNum, phoneCol + 1, changes.phone);
  }
  if (changes.birthDate !== undefined && birthDateCol >= 0) {
    const birth = changes.birthDate ? formatBirthDateForStorage_(changes.birthDate) : '';
    sheet.getRange(rowNum, birthDateCol + 1).setValue(birth);
  }
  if (changes.address !== undefined && addressCol >= 0) {
    sheet.getRange(rowNum, addressCol + 1).setValue(changes.address);
  }
  if (changes.memo !== undefined && memoCol >= 0) {
    sheet.getRange(rowNum, memoCol + 1).setValue(changes.memo);
  }
  if (changes.status !== undefined && statusCol >= 0) {
    sheet.getRange(rowNum, statusCol + 1).setValue(changes.status);
  }
}

/**
 * 顧客情報を更新する（管理画面から呼び出される）。
 */
function updateCustomerInfo(lineUserId, changes) {
  const normalizedUserId = normalizeCustomerUserId_(lineUserId);
  if (!normalizedUserId) throw new Error('LINE User ID が不正です。');

  const sheet = getCustomerSheet_();
  const headers = getCustomerSheetHeaders_(sheet);
  const data = sheet.getDataRange().getValues();
  const userIdCol = headers.indexOf('LINE User ID');
  if (userIdCol < 0) throw new Error('顧客マスタに「LINE User ID」列が見つかりません。');

  let updated = false;
  for (let i = 1; i < data.length; i++) {
    if (!customerUserIdMatches_(data[i][userIdCol], normalizedUserId)) continue;
    applyCustomerInfoChanges_(sheet, i + 1, headers, changes);
    updated = true;
  }
  if (updated) {
    mergeDuplicateCustomerRowsByUserId_(normalizedUserId);
    return;
  }

  try {
    restoreCustomerFromArchive_(normalizedUserId);
    return updateCustomerInfo(normalizedUserId, changes);
  } catch (restoreErr) {
    throw new Error('顧客が見つかりません。');
  }
}

// =================================================================
// 夜間バッチ・トリガー管理・終業後処理
// =================================================================

/**
 * 夜間バッチ: 満席タイムテーブルを全件再計算する。
 * 毎日深夜2時にトリガーで自動実行する。
 */
function runNightlyBatch() {
  const configs  = getConfigs();
  const timeUnit = parseInt(configs.bookingTimeUnit || 30, 10);
  const sheet    = getReservationSheet(configs);
  const data     = sheet.getDataRange().getValues();
  const h        = data[0];
  const statusCol    = h.indexOf('ステータス');
  const startTimeCol = h.indexOf('予約日時');
  const endTimeCol   = h.indexOf('終了日時');

  const now = new Date(); now.setHours(0, 0, 0, 0);

  const slotMap = new Map();
  for (let i = 1; i < data.length; i++) {
    const row    = data[i];
    const status = row[statusCol];
    if (status !== '予約' && status !== '仮予約') continue;
    const startTime = new Date(row[startTimeCol]);
    if (startTime < now) continue;
    const endTime = new Date(row[endTimeCol]);
    let t = new Date(startTime);
    while (t < endTime) {
      const key = Utilities.formatDate(t, 'JST', 'yyyy-MM-dd') + ' ' + Utilities.formatDate(t, 'JST', 'HH:mm');
      slotMap.set(key, (slotMap.get(key) || 0) + 1);
      t.setMinutes(t.getMinutes() + timeUnit);
    }
  }

  const timetableSheet = getSpreadsheet_().getSheetByName('満席タイムテーブル');
  if (!timetableSheet) return;
  const lastRow = timetableSheet.getLastRow();
  if (lastRow > 1) timetableSheet.deleteRows(2, lastRow - 1);

  if (slotMap.size > 0) {
    const rows = [];
    slotMap.forEach((count, key) => {
      const [date, time] = key.split(' ');
      rows.push([date, time, count]);
    });
    rows.sort((a, b) => `${a[0]} ${a[1]}`.localeCompare(`${b[0]} ${b[1]}`));
    timetableSheet.getRange(2, 1, rows.length, 3).setValues(rows);
  }

  Logger.log(`夜間バッチ完了: ${slotMap.size}スロットを再計算`);
}

/**
 * システムトリガーを設定する（初期セットアップ時または設定リセット時に実行）。
 * GASエディタから手動実行するか、設定画面のボタンから呼び出す。
 */
function setupTriggers() {
  ScriptApp.getProjectTriggers().forEach(t => ScriptApp.deleteTrigger(t));

  // 夜間バッチ（毎日 深夜2時）
  ScriptApp.newTrigger('runNightlyBatch')
    .timeBased().everyDays(1).atHour(2).create();

  // ブロックカレンダー差分同期（1時間ごと）
  ScriptApp.newTrigger('syncBlockCalendars')
    .timeBased().everyHours(1).create();

  // 終業後未確定予定の作成（毎日 21時）
  ScriptApp.newTrigger('createEndOfDayUnconfirmedEvent')
    .timeBased().everyDays(1).atHour(21).create();

  // 前日LINEリマインド（毎日 18時）
  ScriptApp.newTrigger('sendDayBeforeReminders')
    .timeBased().everyDays(1).atHour(18).create();

  // 当日60分前LINEリマインド（1時間ごと）
  ScriptApp.newTrigger('sendHourBeforeReminders')
    .timeBased().everyHours(1).create();

  // 日次アーカイブ（毎日 深夜3時）
  ScriptApp.newTrigger('runDailyArchive')
    .timeBased().everyDays(1).atHour(3).create();

  Logger.log('トリガーを設定しました（全6種：夜間バッチ/ブロック同期/終業後予定/前日リマインド/当日リマインド/日次アーカイブ）。');
  return { success: true };
}

/**
 * 終業後トリガー: 当日の未確定予約がある場合、管理カレンダーに確認用予定を自動作成する。
 * 予定の説明欄には管理画面URL（?page=kanri）を埋め込む。
 */
function createEndOfDayUnconfirmedEvent() {
  const configs    = getConfigs();
  const now        = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0);
  const todayEnd   = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59);

  const sheet = getReservationSheet(configs);
  const data  = sheet.getDataRange().getValues();
  const h     = data[0];
  const statusCol    = h.indexOf('ステータス');
  const startTimeCol = h.indexOf('予約日時');

  const unconfirmedCount = data.slice(1).filter(row => {
    if (!row[statusCol]) return false;
    const t = new Date(row[startTimeCol]);
    return t >= todayStart && t <= todayEnd && (row[statusCol] === '予約' || row[statusCol] === '仮予約');
  }).length;

  if (unconfirmedCount === 0) return;

  const calendar  = CalendarApp.getCalendarById(configs.reservationCalendarId);
  const kanriUrl  = `${ScriptApp.getService().getUrl()}?page=kanri`;
  const evtStart  = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 21, 0, 0);
  const evtEnd    = new Date(evtStart.getTime() + 30 * 60000);

  calendar.createEvent(
    `【要確認】本日の未確定予約: ${unconfirmedCount}件`,
    evtStart, evtEnd,
    { description: `本日の未確定予約が${unconfirmedCount}件あります。\n管理画面から確認・確定してください:\n${kanriUrl}` }
  );
  Logger.log(`終業後未確定予定を作成: ${unconfirmedCount}件`);
}

// =================================================================
// フェーズ4: LINEリマインド・エラーログ・データアーカイブ
// =================================================================

// ----------------------------------------------------------------
// LINE リマインド機能
// ----------------------------------------------------------------

/**
 * LINE Messaging API でプッシュメッセージを送信する共通ヘルパー。
 */
function sendLineMessage_(lineUserId, messages) {
  const configs  = getConfigs();
  const token    = configs.lineChannelAccessToken;
  const response = UrlFetchApp.fetch('https://api.line.me/v2/bot/message/push', {
    method: 'post',
    headers: {
      'Content-Type':  'application/json',
      'Authorization': 'Bearer ' + token
    },
    payload:           JSON.stringify({ to: lineUserId, messages }),
    muteHttpExceptions: true
  });
  const result = JSON.parse(response.getContentText());
  if (result.message) throw new Error('LINE API: ' + result.message);
  return result;
}

/**
 * LINE リマインドメッセージ本文を組み立てる。
 * @param {'dayBefore'|'hourBefore'} kind
 * @param {Date} startTime
 * @param {string} menuName
 * @param {string} staffName
 * @returns {string}
 */
function buildLineReminderMessage_(kind, startTime, menuName, staffName) {
  const dayNames = ['日', '月', '火', '水', '木', '金', '土'];
  const d = startTime;
  const dateTimeStr = `${d.getMonth() + 1}月${d.getDate()}日(${dayNames[d.getDay()]}) ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  const title = kind === 'dayBefore'
    ? '📅【明日の予約リマインド】'
    : '📅【本日の予約リマインド】';

  let text = `${title}\n\n`;
  if (kind === 'hourBefore') {
    text += '1時間後のご来店をお待ちしております。\n\n';
  }
  text += `日時: ${dateTimeStr}\n`;
  text += `メニュー: ${menuName}\n`;
  if (staffName && staffName !== '指名なし') {
    text += `担当者: ${staffName}\n`;
  }
  if (kind === 'dayBefore') {
    text += '\nお気をつけてご来店ください。';
  }
  return text;
}

/**
 * 前日リマインド（毎日18時トリガー）。
 * reminderMode が "LINE" の場合のみ、翌日予約の顧客にプッシュ通知を送る。
 * PropertiesService でキーを保存し二重送信を防止する。
 */
function sendDayBeforeReminders() {
  try {
    const configs = getConfigs();
    if (configs.reminderMode !== 'LINE') return;

    const now      = new Date();
    const tmrStart = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 0);
    const tmrEnd   = new Date(tmrStart.getTime() + 86400000);

    const sheet = getReservationSheet(configs);
    const data  = sheet.getDataRange().getValues();
    const h     = data[0];
    const bkIdCol    = h.indexOf('予約ID');
    const statusCol  = h.indexOf('ステータス');
    const userIdCol  = h.indexOf('LINE User ID');
    const menuCol    = h.indexOf('メニュー名');
    const startCol   = h.indexOf('予約日時');
    const staffCol   = h.indexOf('担当者名');

    const props = PropertiesService.getScriptProperties();

    for (let i = 1; i < data.length; i++) {
      const row    = data[i];
      const status = row[statusCol];
      if (!row[bkIdCol] || (status !== '予約' && status !== '仮予約')) continue;

      const startTime = new Date(row[startCol]);
      if (startTime < tmrStart || startTime >= tmrEnd) continue;

      const bookingId  = row[bkIdCol];
      const propKey    = `reminder_day_${bookingId}`;
      if (props.getProperty(propKey)) continue;

      const lineUserId = row[userIdCol];
      if (!lineUserId) continue;

      const text = buildLineReminderMessage_('dayBefore', startTime, row[menuCol], row[staffCol]);

      try {
        sendLineMessage_(lineUserId, [{ type: 'text', text }]);
        props.setProperty(propKey, new Date().toISOString());
      } catch (e) {
        logError_('sendDayBeforeReminders', e);
      }
    }
  } catch (e) {
    logError_('sendDayBeforeReminders', e);
  }
}

/**
 * 当日60分前リマインド（1時間ごとトリガー）。
 * 現在時刻から60〜75分後に開始する予約の顧客にプッシュ通知を送る。
 */
function sendHourBeforeReminders() {
  try {
    const configs = getConfigs();
    if (configs.reminderMode !== 'LINE') return;

    const now         = new Date();
    const windowStart = new Date(now.getTime() + 60 * 60000);
    const windowEnd   = new Date(now.getTime() + 75 * 60000);

    const sheet = getReservationSheet(configs);
    const data  = sheet.getDataRange().getValues();
    const h     = data[0];
    const bkIdCol   = h.indexOf('予約ID');
    const statusCol = h.indexOf('ステータス');
    const userIdCol = h.indexOf('LINE User ID');
    const menuCol   = h.indexOf('メニュー名');
    const startCol  = h.indexOf('予約日時');
    const staffCol  = h.indexOf('担当者名');

    const props = PropertiesService.getScriptProperties();

    for (let i = 1; i < data.length; i++) {
      const row    = data[i];
      const status = row[statusCol];
      if (!row[bkIdCol] || (status !== '予約' && status !== '仮予約')) continue;

      const startTime = new Date(row[startCol]);
      if (startTime < windowStart || startTime > windowEnd) continue;

      const bookingId = row[bkIdCol];
      const propKey   = `reminder_hour_${bookingId}`;
      if (props.getProperty(propKey)) continue;

      const lineUserId = row[userIdCol];
      if (!lineUserId) continue;

      const text = buildLineReminderMessage_('hourBefore', startTime, row[menuCol], row[staffCol]);

      try {
        sendLineMessage_(lineUserId, [{ type: 'text', text }]);
        props.setProperty(propKey, new Date().toISOString());
      } catch (e) {
        logError_('sendHourBeforeReminders', e);
      }
    }
  } catch (e) {
    logError_('sendHourBeforeReminders', e);
  }
}

// ----------------------------------------------------------------
// エラーログ機能
// ----------------------------------------------------------------

/**
 * GAS 内エラーを「エラーログ」シートに記録する共通ヘルパー。
 * 最大500件を保持し、超過分は古い順に削除する。
 */
function logError_(functionName, error) {
  try {
    let sheet = getSpreadsheet_().getSheetByName('エラーログ');
    if (!sheet) {
      sheet = getSpreadsheet_().insertSheet('エラーログ');
      sheet.getRange(1, 1, 1, 4).setValues([['日時', '関数名', 'エラー内容', 'スタックトレース']]);
      sheet.setFrozenRows(1);
      sheet.hideSheet(); // 通常シートタブには表示しない
    }
    const errMsg = error instanceof Error ? error.message : String(error);
    const stack  = (error instanceof Error && error.stack) ? error.stack : '';
    sheet.appendRow([new Date(), functionName, errMsg, stack]);
    const lastRow = sheet.getLastRow();
    if (lastRow > 501) sheet.deleteRows(2, lastRow - 501);
  } catch (logErr) {
    Logger.log('logError_失敗: ' + logErr.message);
  }
}

/**
 * エラーログ一覧を返す（管理画面から呼び出される）。最新100件を返す。
 */
function getErrorLogs() {
  const sheet = getSpreadsheet_().getSheetByName('エラーログ');
  if (!sheet || sheet.getLastRow() <= 1) return [];
  const data = sheet.getDataRange().getValues().slice(1);
  return data.reverse().slice(0, 100).map(row => ({
    timestamp:    row[0] instanceof Date ? row[0].toISOString() : String(row[0]),
    functionName: row[1] || '',
    message:      row[2] || '',
    stack:        row[3] || ''
  }));
}

/**
 * エラーログを全件削除する（管理画面から呼び出される）。
 */
function clearErrorLogs() {
  const sheet = getSpreadsheet_().getSheetByName('エラーログ');
  if (!sheet || sheet.getLastRow() <= 1) return;
  sheet.deleteRows(2, sheet.getLastRow() - 1);
}

// ----------------------------------------------------------------
// データアーカイブ機能
// ----------------------------------------------------------------

/**
 * 日次アーカイブ（毎日深夜3時トリガー）。
 * 前日以前の完了済みデータを本体スプレッドシートからアーカイブファイルへ移動し
 * 本体を常に軽量に保つ。
 *   - 予約シート  : 来店/キャンセル/無断キャンセル かつ 予約日が昨日以前 → アーカイブ移動
 *   - 顧客マスタ  : ステータスが「無効」 → アーカイブ移動（離脱顧客の分析価値を保持）
 *   - 満席テーブル: 日付が昨日以前 → 削除のみ（予約データから再現可能な派生データ）
 * アーカイブファイルが 50,000行を超えた場合は新ファイルを自動作成し
 * Config の「archiveSpreadsheetId」を自動更新する。
 */
function runDailyArchive() {
  try {
    const configs = getConfigs();
    const today   = new Date(); today.setHours(0, 0, 0, 0);

    let archived = 0;
    archived += archivePastReservations_(configs, today);
    // 無効顧客は論理削除としてマスタに残し、再有効化できるようにする
    cleanPastTimetable_(today);

    if (archived > 0) Logger.log(`日次アーカイブ完了: ${archived}件を移動。`);
    else              Logger.log('日次アーカイブ: 対象レコードなし。');
  } catch (e) {
    logError_('runDailyArchive', e);
  }
}

/**
 * 完了済み予約（来店/キャンセル/無断キャンセル）で予約日が昨日以前のものをアーカイブへ移動する。
 * @returns {number} 移動件数
 */
function archivePastReservations_(configs, today) {
  const sheet = getReservationSheet(configs);
  const data  = sheet.getDataRange().getValues();
  const h     = data[0];
  const bkIdCol   = h.indexOf('予約ID');
  const statusCol = h.indexOf('ステータス');
  const startCol  = h.indexOf('予約日時');
  const doneStats = ['来店', 'キャンセル', '無断キャンセル'];

  const toArchive = [], rowNums = [];
  for (let i = 1; i < data.length; i++) {
    const row = data[i];
    if (!row[bkIdCol]) continue;
    if (!doneStats.includes(row[statusCol])) continue;
    if (new Date(row[startCol]) >= today) continue;
    toArchive.push(row);
    rowNums.push(i + 1);
  }
  if (!toArchive.length) return 0;

  const archiveSS    = getOrCreateArchiveSpreadsheet_(configs);
  let   archiveSheet = archiveSS.getSheetByName('予約');
  if (!archiveSheet) {
    archiveSheet = archiveSS.insertSheet('予約');
    archiveSheet.getRange(1, 1, 1, h.length).setValues([h]);
  }
  archiveSheet.getRange(archiveSheet.getLastRow() + 1, 1, toArchive.length, h.length)
    .setValues(toArchive);
  rowNums.reverse().forEach(r => sheet.deleteRow(r));
  return toArchive.length;
}

/**
 * ステータスが「無効」の顧客をアーカイブへ移動する。
 * 離脱顧客データはチャーン分析や再獲得戦略に活用できるため削除せず保持する。
 * @returns {number} 移動件数
 */
function archiveInactiveCustomers_(configs) {
  const sheet = getCustomerSheet_();
  if (!sheet) return 0;
  const data  = sheet.getDataRange().getValues();
  const h     = data[0];
  const userIdCol = h.indexOf('LINE User ID');
  const statusCol = h.indexOf('ステータス');

  const toArchive = [], rowNums = [];
  for (let i = 1; i < data.length; i++) {
    const row = data[i];
    if (!row[userIdCol] || row[statusCol] !== '無効') continue;
    toArchive.push(row);
    rowNums.push(i + 1);
  }
  if (!toArchive.length) return 0;

  const archiveSS    = getOrCreateArchiveSpreadsheet_(configs);
  let   archiveSheet = archiveSS.getSheetByName('顧客マスタ');
  if (!archiveSheet) {
    archiveSheet = archiveSS.insertSheet('顧客マスタ');
    archiveSheet.getRange(1, 1, 1, h.length).setValues([h]);
  }
  archiveSheet.getRange(archiveSheet.getLastRow() + 1, 1, toArchive.length, h.length)
    .setValues(toArchive);
  rowNums.reverse().forEach(r => sheet.deleteRow(r));
  return toArchive.length;
}

/**
 * 満席タイムテーブルの過去エントリを削除する。
 * キャッシュデータのため削除のみ（アーカイブ不要）。
 * 予約データがあれば同等の分析は常に再現できる。
 */
function cleanPastTimetable_(today) {
  const sheet = getSpreadsheet_().getSheetByName('満席タイムテーブル');
  if (!sheet || sheet.getLastRow() <= 1) return;
  const todayStr = Utilities.formatDate(today, 'JST', 'yyyy-MM-dd');
  const data     = sheet.getDataRange().getValues();
  const rowNums  = [];
  for (let i = 1; i < data.length; i++) {
    const v = data[i][0];
    const s = v instanceof Date ? Utilities.formatDate(v, 'JST', 'yyyy-MM-dd') : String(v);
    if (s < todayStr) rowNums.push(i + 1);
  }
  rowNums.reverse().forEach(r => sheet.deleteRow(r));
  if (rowNums.length) Logger.log(`満席テーブル: 過去${rowNums.length}件を削除。`);
}

/**
 * アーカイブ用スプレッドシートを取得または新規作成する。
 * 総行数が 50,000行を超えた場合は新ファイルを作成し Config を自動更新する。
 */
function getOrCreateArchiveSpreadsheet_(configs) {
  const MAX_ROWS = 50000;
  let ss = null;

  if (configs.archiveSpreadsheetId) {
    try {
      ss = SpreadsheetApp.openById(configs.archiveSpreadsheetId);
      let totalRows = 0;
      ss.getSheets().forEach(sh => { totalRows += sh.getLastRow(); });
      if (totalRows > MAX_ROWS) {
        Logger.log(`アーカイブファイルが${totalRows}行を超えました。新ファイルを作成します。`);
        ss = null;
      }
    } catch (e) {
      ss = null;
    }
  }

  if (!ss) {
    const label = Utilities.formatDate(new Date(), 'JST', 'yyyy-MM');
    ss = SpreadsheetApp.create(`予約アーカイブ_${configs.shopName || 'システム'}_${label}`);
    updateConfigValue_('archiveSpreadsheetId', ss.getId());
    Logger.log(`新規アーカイブファイルを作成しました。ID: ${ss.getId()}`);
  }

  return ss;
}

/**
 * Config シートの指定キーの値を更新する。キーが存在しない場合は末尾に追加する。
 */
function updateConfigValue_(key, value) {
  const sheet = getSpreadsheet_().getSheetByName('Config');
  if (!sheet) return;
  const data = sheet.getDataRange().getValues();
  for (let i = 0; i < data.length; i++) {
    if (data[i][0] === key) {
      sheet.getRange(i + 1, 2).setValue(value);
      return;
    }
  }
  sheet.appendRow([key, value, '自動設定']);
}
