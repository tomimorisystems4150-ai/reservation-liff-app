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
      `スプレッドシート (ID: ${_PROVISIONED_SS_ID}) にアクセスできません。` +
      'GASエディタを開き、任意の関数を実行して権限を付与してください。'
    );
  }
  return ss.getSheetByName('Config');
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

  let configs;
  try {
    configs = getConfigs();
  } catch (err) {
    return HtmlService.createHtmlOutput(
      `<html><body style="font-family:sans-serif;padding:40px;">` +
      `<h2>初期化エラー</h2>` +
      `<p>${err.message}</p>` +
      `<hr><p style="font-size:12px;color:#666;">` +
      `スプレッドシートID: ${_PROVISIONED_SS_ID}<br>` +
      `対処法: <a href="https://script.google.com" target="_blank">GASエディタ</a>を開き、` +
      `「実行」メニューから任意の関数を実行して権限を付与してください。</p>` +
      `</body></html>`
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
    return tmpl.evaluate().setTitle('予約管理');
  }

  const template = HtmlService.createTemplateFromFile('settings');
  template.allConfigsAsJson = JSON.stringify(configs);
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
      let response;
      switch (postData.action) {
        case 'getInitData': {
          const configs = getConfigs();
          const lineUserId = postData.lineUserId || null;
          const isRegistered = lineUserId ? (findCustomerByUserId_(lineUserId) !== null) : false;
          response = {
            shopName: configs.shopName,
            serviceMenus: configs.serviceMenus || [],
            isStaffFeatureEnabled: configs.isStaffFeatureEnabled || false,
            staffs: configs.isStaffFeatureEnabled ? (configs.staffs || []) : [],
            bookingTimeUnit: configs.bookingTimeUnit || 30,
            bookingLookaheadDays: configs.bookingLookaheadDays || 90,
            isRegistered: isRegistered,
            maxBulkBookings: parseInt(configs.maxBulkBookings || 1, 10)
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
          response = createBulkBookings(postData.bookingDataList);
          break;
        }

        case 'registerCustomer': {
          if (!postData.lineUserId || !postData.customerName) {
            throw new Error('LINE User ID と顧客名は必須です。');
          }
          response = registerCustomer(postData.lineUserId, postData.customerName, postData.phone || '');
          break;
        }

        case 'getAvailableSlots': {
          if (!postData.date || !postData.duration) {
            throw new Error('日付または所要時間が指定されていません。');
          }
          response = getAvailableSlots(postData.date, postData.duration, postData.staffEmail);
          break;
        }

        case 'createBooking': {
          if (!postData.bookingData) {
            throw new Error('予約情報がありません。');
          }
          response = createBooking(postData.bookingData);
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
    return createJsonResponse({ success: false, message: error.message });
  }
}


// =================================================================
// データ操作関数
// =================================================================

function getConfigs() {
  if (!getConfigSheet_()) {
    throw new Error('設定シート「Config」が見つかりません。');
  }
  
  const dataRange = getConfigSheet_().getRange('A2:B' + getConfigSheet_().getLastRow());
  const values = dataRange.getValues();
  
  const configs = {};
  values.forEach(row => {
    const key = row[0].toString().trim();
    let value = row[1];
    
    if (!key) return;

    const jsonKeys = ['serviceMenus', 'businessHours', 'holidays', 'staffs', 'staff_block_calendar_id_map'];
    if (jsonKeys.includes(key)) {
      try {
        if (value === '' || value === null || value === undefined) {
          configs[key] = (key === 'serviceMenus' || key === 'holidays' || key === 'staffs') ? [] : {};
        } else {
          configs[key] = JSON.parse(value);
        }
      } catch (e) {
        Logger.log(`Key "${key}" のJSONパースに失敗。デフォルト値を設定します。Error: ${e.message}`);
        configs[key] = (key === 'serviceMenus' || key === 'holidays' || key === 'staffs') ? [] : {};
      }
    } else {
      if (key === 'isStaffFeatureEnabled') {
        configs[key] = (value === true || value === 'TRUE');
      } else {
        configs[key] = value;
      }
    }
  });
  
  return configs;
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

    // adminEmailが未設定の場合は初回セットアップとみなし保存を許可する
    if (authorizedUsers.length > 0 && (!currentUser || !authorizedUsers.includes(currentUser.toLowerCase()))) {
      Logger.log(`保存拒否: ${currentUser} は許可されたユーザーではありません。(許可リスト: ${authorizedUsers.join(', ')})`);
      return false;
    }

    if (!getConfigSheet_()) {
      throw new Error('設定シート「Config」が見つかりません。');
    }

    const dataRange = getConfigSheet_().getRange('A2:B' + getConfigSheet_().getLastRow());
    const sheetValues = dataRange.getValues();

    sheetValues.forEach(row => {
      const key = row[0].toString().trim();
      if (configs.hasOwnProperty(key)) {
        const newValue = configs[key];
        row[1] = (typeof newValue === 'object') ? JSON.stringify(newValue) : newValue;
      }
    });

    dataRange.setValues(sheetValues);
    Logger.log('設定を保存しました。');
    return true;

  } catch (e) {
    Logger.log('設定の保存中にエラーが発生しました: %s', e.message);
    return false;
  }
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
      replyText = '現在、今後のご予約はございません。\n\nご予約はLINEのメニューから承ります。';
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
function getAvailableSlots(startDateString, durationMinutes, staffEmail) {
  const configs = getConfigs();
  const timeUnit = parseInt(configs.bookingTimeUnit || 30, 10);
  const businessHours = configs.businessHours || { start: '10:00', end: '19:00' };
  const maxBookings = parseInt(configs.maxConcurrentBookings || 1, 10);

  const startDate = new Date(startDateString);
  const endDate = new Date(startDate.getTime());
  endDate.setDate(endDate.getDate() + 7);

  const startDateStr = Utilities.formatDate(startDate, 'JST', 'yyyy-MM-dd');
  const endDateStr = Utilities.formatDate(endDate, 'JST', 'yyyy-MM-dd');

  const weeklyBookingCounts = {};

  const isStaffNominated = staffEmail && staffEmail !== 'any';

  // --- ブロックカレンダーの同期と、ブロックスロットの取得 ---
  const blockCalendarIds = getBlockCalendarIds_(configs, staffEmail, isStaffNominated);
  if (blockCalendarIds.length > 0) {
    syncBlockCalendars(blockCalendarIds);
  }
  const blockedSlots = getBlockedSlotsForWeek(startDateStr, endDateStr, blockCalendarIds, businessHours, timeUnit);

  if (isStaffNominated) {
    // ▼ Bルート（指名あり）：予約シートから該当担当者の予定をリアルタイム計算
    const reservationSheet = getReservationSheet(configs);
    const data = reservationSheet.getDataRange().getValues();
    const headers = data[0];
    const statusCol = headers.indexOf('ステータス');
    const startTimeCol = headers.indexOf('予約日時');
    const endTimeCol = headers.indexOf('終了日時');
    const staffEmailCol = headers.indexOf('担当者Email');

    for (let i = 1; i < data.length; i++) {
      const row = data[i];
      const status = row[statusCol];
      if (status !== '予約' && status !== '仮予約') continue;
      if (row[staffEmailCol] !== staffEmail) continue; // 該当担当者以外の予約は除外

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
  } else {
    // ▼ Aルート（指名なし）：満席タイムテーブルから店舗全体の予定を高速取得
    const availabilitySheet = getSpreadsheet_().getSheetByName('満席タイムテーブル');
    if (availabilitySheet) {
      const data = availabilitySheet.getDataRange().getValues();
      for (let i = 1; i < data.length; i++) {
        const row = data[i];
        const rowDateStr = Utilities.formatDate(new Date(row[0]), 'JST', 'yyyy-MM-dd');

        if (rowDateStr >= startDateStr && rowDateStr < endDateStr) {
          if (!weeklyBookingCounts[rowDateStr]) {
            weeklyBookingCounts[rowDateStr] = new Map();
          }

          let timeSlot = row[1];
          if (timeSlot instanceof Date) {
            timeSlot = Utilities.formatDate(timeSlot, 'JST', 'HH:mm');
          } else {
            timeSlot = String(timeSlot).substring(0, 5);
          }

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

        const currentBookings = dailyBookingCounts.get(currentSlotStr) || 0;

        if (currentBookings >= effectiveMaxBookings) {
          isAvailable = false;
          break;
        }
        checkTime.setMinutes(checkTime.getMinutes() + timeUnit);
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
    // 担当者機能ON + 指名あり: その担当者のブロックカレンダーを使用
    const staffCalendarMap = configs.staff_block_calendar_id_map || {};
    const calId = staffCalendarMap[staffEmail];
    return calId ? [String(calId)] : [];
  }

  // 担当者機能ON + 指名なし: 共有ブロックカレンダーがあれば使用
  // （担当者個別のブロックは各担当者の指名ルートで処理されるため、ここでは店舗共有分のみ）
  const calId = configs.block_input_calendar_id;
  return calId ? [String(calId)] : [];
}

/**
 * 指定されたブロックカレンダーをSync Tokenを用いて差分同期し、「ブロック予定同期」シートを更新する
 * @param {string[]} calendarIds - 同期するカレンダーIDの配列
 */
function syncBlockCalendars(calendarIds) {
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

/**
 * 新規予約の各タイムスロットについて、満席タイムテーブルを正規化しながら更新する。
 * 既存行が存在する場合はカウントをインクリメント、存在しない場合のみ新規追記する。
 * @param {Date} startTime - 予約開始日時
 * @param {Date} endTime   - 予約終了日時
 * @param {number} timeUnit - 最小予約単位（分）
 */
function updateTimetableSlots_(startTime, endTime, timeUnit) {
  const availabilitySheet = getSpreadsheet_().getSheetByName('満席タイムテーブル');
  if (!availabilitySheet) return;

  const targetDateStr = Utilities.formatDate(startTime, 'JST', 'yyyy-MM-dd');

  // 既存データをすべて読み込み、日時をキーにした行マップを構築
  const lastRow = availabilitySheet.getLastRow();
  const slotRowMap = new Map(); // key: "yyyy-MM-dd HH:mm" → { rowIndex, count }
  if (lastRow >= 2) {
    const existingData = availabilitySheet.getRange(2, 1, lastRow - 1, 3).getValues();
    existingData.forEach((row, i) => {
      const dateStr = row[0] instanceof Date
        ? Utilities.formatDate(row[0], 'JST', 'yyyy-MM-dd')
        : String(row[0]).substring(0, 10);
      const timeStr = row[1] instanceof Date
        ? Utilities.formatDate(row[1], 'JST', 'HH:mm')
        : String(row[1]).substring(0, 5);
      const key = `${dateStr} ${timeStr}`;
      // 同じキーが重複している場合も合算して保持する（過去の重複行の救済）
      const existing = slotRowMap.get(key);
      if (existing) {
        existing.count += parseInt(row[2], 10) || 0;
      } else {
        slotRowMap.set(key, { rowIndex: i + 2, count: parseInt(row[2], 10) || 0 });
      }
    });
  }

  // 新予約の各タイムスロットをインクリメントまたは新規追記
  const rowsToUpdate = []; // [rowIndex, newCount]
  const rowsToAppend = []; // [date, time, count]

  let updateTime = new Date(startTime);
  while (updateTime < endTime) {
    const timeStr = Utilities.formatDate(updateTime, 'JST', 'HH:mm');
    const key = `${targetDateStr} ${timeStr}`;

    if (slotRowMap.has(key)) {
      const entry = slotRowMap.get(key);
      rowsToUpdate.push({ rowIndex: entry.rowIndex, newCount: entry.count + 1 });
    } else {
      rowsToAppend.push([targetDateStr, timeStr, 1]);
    }
    updateTime.setMinutes(updateTime.getMinutes() + timeUnit);
  }

  // 既存行を更新
  rowsToUpdate.forEach(({ rowIndex, newCount }) => {
    availabilitySheet.getRange(rowIndex, 3).setValue(newCount);
  });

  // 新規行を追記
  if (rowsToAppend.length > 0) {
    const appendStartRow = availabilitySheet.getLastRow() + 1;
    availabilitySheet.getRange(appendStartRow, 1, rowsToAppend.length, 3).setValues(rowsToAppend);
  }
}


// =================================================================
// 顧客マスタ 操作関数
// =================================================================

const CUSTOMER_SHEET_NAME = '顧客マスタ';
const CUSTOMER_HEADERS = ['LINE User ID', '顧客名', '電話番号', '登録日時', '最終来店日', 'メモ', 'ステータス'];

/**
 * 顧客マスタシートを取得する。存在しない場合は自動作成してヘッダーを設定する。
 */
function getCustomerSheet_() {
  let sheet = getSpreadsheet_().getSheetByName(CUSTOMER_SHEET_NAME);
  if (!sheet) {
    sheet = getSpreadsheet_().insertSheet(CUSTOMER_SHEET_NAME);
    sheet.appendRow(CUSTOMER_HEADERS);
    sheet.getRange(1, 1, 1, CUSTOMER_HEADERS.length).setFontWeight('bold');
    Logger.log('顧客マスタシートを自動作成しました。');
  }
  return sheet;
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

  const data = sheet.getRange(2, 1, lastRow - 1, CUSTOMER_HEADERS.length).getValues();
  const userIdCol = CUSTOMER_HEADERS.indexOf('LINE User ID');
  const statusCol = CUSTOMER_HEADERS.indexOf('ステータス');

  for (let i = 0; i < data.length; i++) {
    if (data[i][userIdCol] === lineUserId && data[i][statusCol] !== '無効') {
      const record = {};
      CUSTOMER_HEADERS.forEach((header, idx) => {
        record[header] = data[i][idx];
      });
      return record;
    }
  }
  return null;
}

/**
 * 新規顧客を顧客マスタに登録する。
 * @param {string} lineUserId
 * @param {string} customerName
 * @param {string} phone （任意）
 * @returns {Object} 登録した顧客情報
 */
function registerCustomer(lineUserId, customerName, phone) {
  if (!lineUserId || !customerName || !customerName.trim()) {
    throw new Error('LINE User ID と顧客名は必須です。');
  }

  // 重複登録チェック
  const existing = findCustomerByUserId_(lineUserId);
  if (existing) {
    Logger.log(`顧客登録スキップ: ${lineUserId} はすでに登録済みです。`);
    return existing;
  }

  const sheet = getCustomerSheet_();
  const now = new Date();
  const newRow = [
    lineUserId,
    customerName.trim(),
    phone ? phone.trim() : '',
    now,
    '',
    '',
    '有効'
  ];
  sheet.appendRow(newRow);
  Logger.log(`顧客登録完了: ${customerName.trim()} (${lineUserId})`);

  return {
    'LINE User ID': lineUserId,
    '顧客名': customerName.trim(),
    '電話番号': phone ? phone.trim() : '',
    '登録日時': now.toISOString(),
    'ステータス': '有効'
  };
}

// =================================================================
// 店舗向け管理機能（kanri.html から google.script.run で呼び出す）
// =================================================================

/**
 * 予約一覧を返す（管理画面用）。
 * @param {string} filterType - 'today' | 'upcoming' | 'recent'（直近3日）
 */
function getBookingsForManagement(filterType) {
  const configs = getConfigs();
  const sheet   = getReservationSheet(configs);
  const data    = sheet.getDataRange().getValues();
  const h       = data[0];
  const bookingIdCol  = h.indexOf('予約ID');
  const statusCol     = h.indexOf('ステータス');
  const userIdCol     = h.indexOf('LINE User ID');
  const userNameCol   = h.indexOf('顧客名');
  const menuNameCol   = h.indexOf('メニュー名');
  const startTimeCol  = h.indexOf('予約日時');
  const endTimeCol    = h.indexOf('終了日時');
  const eventIdCol    = h.indexOf('イベントID');
  const staffNameCol  = h.indexOf('担当者名');

  const now        = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0);
  const todayEnd   = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59);
  const recentEnd  = new Date(todayStart.getTime() + 3 * 86400000);

  const bookings = [];
  for (let i = 1; i < data.length; i++) {
    const row = data[i];
    if (!row[bookingIdCol]) continue;
    const startTime = new Date(row[startTimeCol]);
    let include = false;
    if      (filterType === 'today')    include = startTime >= todayStart && startTime <= todayEnd;
    else if (filterType === 'upcoming') include = startTime >= todayStart;
    else if (filterType === 'recent')   include = startTime >= todayStart && startTime < recentEnd;
    if (!include) continue;

    const toISO = (v) => v instanceof Date ? v.toISOString() : String(v);
    bookings.push({
      bookingId: row[bookingIdCol],
      status:    row[statusCol],
      lineUserId:row[userIdCol],
      userName:  row[userNameCol],
      menuName:  row[menuNameCol],
      startTime: toISO(row[startTimeCol]),
      endTime:   toISO(row[endTimeCol]),
      eventId:   row[eventIdCol],
      staffName: row[staffNameCol]
    });
  }
  return bookings.sort((a, b) => new Date(a.startTime) - new Date(b.startTime));
}

/**
 * 本日の未確定予約（ステータスが「予約」または「仮予約」）一覧を返す。
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

  const now        = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0);
  const todayEnd   = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59);

  const bookings = [];
  for (let i = 1; i < data.length; i++) {
    const row    = data[i];
    const status = row[statusCol];
    if (!row[bookingIdCol] || (status !== '予約' && status !== '仮予約')) continue;
    const startTime = new Date(row[startTimeCol]);
    if (startTime < todayStart || startTime > todayEnd) continue;
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
 * 予約ステータスを確定する。
 * - 来店: カレンダーイベントを緑（Basil）に変更、顧客マスタの最終来店日を更新
 * - 無断キャンセル: カレンダーイベントを赤（Tomato）に変更
 * - キャンセル: カレンダーイベントを削除
 * @param {string} bookingId
 * @param {string} newStatus - '来店' | '無断キャンセル' | 'キャンセル'
 */
function confirmBookingStatus(bookingId, newStatus) {
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

  let targetRow = -1, eventId = '', lineUserId = '', startTime = null, endTime = null;
  for (let i = 1; i < data.length; i++) {
    if (data[i][bookingIdCol] === bookingId) {
      targetRow  = i + 1;
      eventId    = data[i][eventIdCol];
      lineUserId = data[i][userIdCol];
      startTime  = new Date(data[i][startTimeCol]);
      endTime    = new Date(data[i][endTimeCol]);
      break;
    }
  }
  if (targetRow === -1) throw new Error(`予約ID「${bookingId}」が見つかりません。`);

  sheet.getRange(targetRow, statusCol + 1).setValue(newStatus);

  if (eventId) {
    try {
      const calendar = CalendarApp.getCalendarById(configs.reservationCalendarId);
      const event    = calendar.getEventById(eventId);
      if (event) {
        if      (newStatus === '来店')       event.setColor('10');   // Basil（緑）
        else if (newStatus === '無断キャンセル') event.setColor('11'); // Tomato（赤）
        else if (newStatus === 'キャンセル')  event.deleteEvent();
      }
    } catch (calErr) {
      Logger.log(`カレンダー更新エラー: ${calErr.message}`);
    }
  }

  if (newStatus === '来店' && lineUserId) {
    updateCustomerLastVisit_(lineUserId, startTime);
  }

  Logger.log(`ステータス更新: ${bookingId} → ${newStatus}`);
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
 * 顧客マスタ一覧を返す（管理画面用）。
 */
function getCustomersForManagement() {
  const sheet = getCustomerSheet_();
  const data  = sheet.getDataRange().getValues();
  if (data.length <= 1) return [];
  const h = data[0];
  const userIdCol    = h.indexOf('LINE User ID');
  const nameCol      = h.indexOf('顧客名');
  const phoneCol     = h.indexOf('電話番号');
  const regDateCol   = h.indexOf('登録日時');
  const lastVisitCol = h.indexOf('最終来店日');
  const memoCol      = h.indexOf('メモ');
  const statusCol    = h.indexOf('ステータス');
  const toISO = (v) => v instanceof Date ? v.toISOString() : String(v || '');

  return data.slice(1)
    .filter(row => row[userIdCol])
    .map(row => ({
      lineUserId:   row[userIdCol],
      name:         row[nameCol],
      phone:        row[phoneCol] || '',
      registeredAt: toISO(row[regDateCol]),
      lastVisit:    row[lastVisitCol] ? toISO(row[lastVisitCol]) : '',
      memo:         row[memoCol] || '',
      status:       row[statusCol] || '有効'
    }));
}

/**
 * 顧客情報を更新する（管理画面から呼び出される）。
 */
function updateCustomerInfo(lineUserId, changes) {
  const sheet = getCustomerSheet_();
  const data  = sheet.getDataRange().getValues();
  const h     = data[0];
  const userIdCol = h.indexOf('LINE User ID');
  const nameCol   = h.indexOf('顧客名');
  const phoneCol  = h.indexOf('電話番号');
  const memoCol   = h.indexOf('メモ');
  const statusCol = h.indexOf('ステータス');

  for (let i = 1; i < data.length; i++) {
    if (data[i][userIdCol] === lineUserId) {
      const r = i + 1;
      if (changes.name   !== undefined) sheet.getRange(r, nameCol   + 1).setValue(changes.name);
      if (changes.phone  !== undefined) sheet.getRange(r, phoneCol  + 1).setValue(changes.phone);
      if (changes.memo   !== undefined) sheet.getRange(r, memoCol   + 1).setValue(changes.memo);
      if (changes.status !== undefined) sheet.getRange(r, statusCol + 1).setValue(changes.status);
      return;
    }
  }
  throw new Error('顧客が見つかりません。');
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
    const dayNames = ['日','月','火','水','木','金','土'];

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

      const d = startTime;
      const dateStr  = `${d.getMonth()+1}月${d.getDate()}日(${dayNames[d.getDay()]}) ${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
      const staffStr = (row[staffCol] && row[staffCol] !== '指名なし') ? `\n担当者: ${row[staffCol]}` : '';
      const text = `【明日の予約リマインド🔔】\n\n📅 ${dateStr}\n📋 ${row[menuCol]}${staffStr}\n\nお気をつけてご来店ください。`;

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

      const timeStr  = `${String(startTime.getHours()).padStart(2,'0')}:${String(startTime.getMinutes()).padStart(2,'0')}`;
      const staffStr = (row[staffCol] && row[staffCol] !== '指名なし') ? `\n担当者: ${row[staffCol]}` : '';
      const text = `【本日の予約リマインド🔔】\n1時間後のご来店をお待ちしております。\n\n🕐 ${timeStr}\n📋 ${row[menuCol]}${staffStr}`;

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
    archived += archiveInactiveCustomers_(configs);
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
