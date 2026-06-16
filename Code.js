/**
 * @fileoverview 予約管理システムのバックエンドロジック
 */

// =================================================================
// 定数定義
// =================================================================
const SPREADSHEET = SpreadsheetApp.getActiveSpreadsheet();
const CONFIG_SHEET = SPREADSHEET.getSheetByName('Config');

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

  const configs = getConfigs();
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

  if (!currentUser || !authorizedUsers.includes(currentUser.toLowerCase())) {
    Logger.log(`アクセス拒否: ${currentUser} (許可リスト: ${authorizedUsers.join(', ')})`);
    return HtmlService.createTemplateFromFile('unauthorized').evaluate().setTitle('アクセスエラー');
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
  if (!CONFIG_SHEET) {
    throw new Error('設定シート「Config」が見つかりません。');
  }
  
  const dataRange = CONFIG_SHEET.getRange('A2:B' + CONFIG_SHEET.getLastRow());
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

    if (!currentUser || !authorizedUsers.includes(currentUser.toLowerCase())) {
      Logger.log(`保存拒否: ${currentUser} は許可されたユーザーではありません。(許可リスト: ${authorizedUsers.join(', ')})`);
      return false;
    }

    if (!CONFIG_SHEET) {
      throw new Error('設定シート「Config」が見つかりません。');
    }

    const dataRange = CONFIG_SHEET.getRange('A2:B' + CONFIG_SHEET.getLastRow());
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
  let sheet = SPREADSHEET.getSheetByName('予約');
  if (!sheet) {
    sheet = SPREADSHEET.insertSheet('予約');
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

  if (userText === '予約確認') {
    const futureBookings = getFutureBookingsByUserId(userId, configs);
    let replyText = '';

    if (futureBookings.length > 0) {
      const dayOfWeekJp = ['日', '月', '火', '水', '木', '金', '土'];
      
      replyText = '今後のご予約一覧です。\n\n';
      futureBookings.forEach(booking => {
        const startTime = new Date(booking.startTime);
        
        const dayChar = dayOfWeekJp[startTime.getDay()];
        const datePart = Utilities.formatDate(startTime, 'JST', 'M月d日');
        const timePart = Utilities.formatDate(startTime, 'JST', 'HH:mm');
        const formattedDateTime = `${datePart}(${dayChar}) ${timePart}`;

        replyText += `■ ${formattedDateTime}\n`;
        replyText += `メニュー: ${booking.menuName}\n\n`;
      });
      replyText += 'ご来店をお待ちしております。';
    } else {
      replyText = '現在、今後のご予約はございません。';
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

  const userIdCol = headers.indexOf('LINE User ID');
  const statusCol = headers.indexOf('ステータス');
  const startTimeCol = headers.indexOf('予約日時');
  const menuNameCol = headers.indexOf('メニュー名');

  data.forEach(row => {
    const bookingTime = new Date(row[startTimeCol]);
    if (row[userIdCol] === userId && row[statusCol] === '予約' && bookingTime > now) {
      futureBookings.push({
        startTime: bookingTime,
        menuName: row[menuNameCol]
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

  const availabilitySheet = SPREADSHEET.getSheetByName('満席タイムテーブル');
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
    const availabilitySheet = SPREADSHEET.getSheetByName('満席タイムテーブル');
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
  const syncSheet = SPREADSHEET.getSheetByName('ブロック予定同期');
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
 * @param {GoogleAppsScript.Spreadsheet.Sheet} syncSheet
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
 * @param {GoogleAppsScript.Spreadsheet.Sheet} syncSheet
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
 * @param {GoogleAppsScript.Spreadsheet.Sheet} syncSheet
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

  const syncSheet = SPREADSHEET.getSheetByName('ブロック予定同期');
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
  const availabilitySheet = SPREADSHEET.getSheetByName('満席タイムテーブル');
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
  let sheet = SPREADSHEET.getSheetByName(CUSTOMER_SHEET_NAME);
  if (!sheet) {
    sheet = SPREADSHEET.insertSheet(CUSTOMER_SHEET_NAME);
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