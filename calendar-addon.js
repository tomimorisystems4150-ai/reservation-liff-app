/**
 * Googleカレンダーアドオン
 * 予約イベントをクリックしたときにサイドバーに予約情報と操作ボタンを表示する
 */

/**
 * カレンダーイベントを開いたときに呼ばれるメイン関数
 * @param {Object} e - イベントオブジェクト（e.calendar.calendarEventId）
 * @returns {CardService.Card}
 */
function onCalendarEventOpen(e) {
  try {
    const calendarEventId = e && e.calendar && e.calendar.calendarEventId;
    if (!calendarEventId) {
      return buildMessageCard_('情報', 'カレンダーイベントを選択してください。');
    }

    const booking = findBookingByEventId_(calendarEventId);
    if (!booking) {
      return buildMessageCard_('予約情報なし', 'このイベントに紐づく予約データが見つかりませんでした。\n\n予約システム外で作成されたイベントか、すでに削除された予約の可能性があります。');
    }

    return buildBookingCard_(booking);

  } catch (err) {
    Logger.log('アドオンエラー: ' + err.message);
    return buildMessageCard_('エラー', 'データの取得中にエラーが発生しました。\n\n' + err.message);
  }
}

/**
 * アドオンのホーム画面（カレンダーのトップ）
 * @returns {CardService.Card}
 */
function onCalendarHome() {
  return buildMessageCard_('予約管理アドオン', '予約カレンダーのイベントをクリックすると、予約情報の確認・ステータス変更ができます。');
}

/**
 * イベントIDで予約データを検索する
 * @param {string} calendarEventId - GoogleカレンダーのイベントID
 * @returns {Object|null} 予約データ
 */
function findBookingByEventId_(calendarEventId) {
  const configs = getConfigs();
  const sheet   = getReservationSheet(configs);
  const data    = sheet.getDataRange().getValues();
  const h       = data[0];

  const bookingIdCol = h.indexOf('予約ID');
  const statusCol    = h.indexOf('ステータス');
  const eventIdCol   = h.indexOf('イベントID');
  const userNameCol  = h.indexOf('顧客名');
  const menuCol      = h.indexOf('メニュー名');
  const startCol     = h.indexOf('予約日時');
  const endCol       = h.indexOf('終了日時');
  const staffCol     = h.indexOf('担当者名');

  for (let i = 1; i < data.length; i++) {
    const storedEventId = data[i][eventIdCol];
    if (storedEventId && storedEventId.toString().trim() === calendarEventId.toString().trim()) {
      const startTime = data[i][startCol] ? new Date(data[i][startCol]) : null;
      const endTime   = data[i][endCol]   ? new Date(data[i][endCol])   : null;
      return {
        bookingId: data[i][bookingIdCol],
        status:    data[i][statusCol],
        userName:  data[i][userNameCol],
        menuName:  data[i][menuCol],
        startTime: startTime,
        endTime:   endTime,
        staffName: data[i][staffCol] || '指名なし',
        rowIndex:  i + 1,
      };
    }
  }
  return null;
}

/**
 * 予約詳細カードを構築する
 * @param {Object} booking - 予約データ
 * @returns {CardService.Card}
 */
function buildBookingCard_(booking) {
  const isPending = booking.status === '予約' || booking.status === '仮予約';
  const dateStr   = formatDatetime_(booking.startTime, booking.endTime);
  const statusEmoji = {
    '予約': '🟢', '仮予約': '🟡',
    '来店': '✅', 'キャンセル': '⚪', '無断キャンセル': '🔴'
  }[booking.status] || '•';

  const card = CardService.newCardBuilder()
    .setHeader(
      CardService.newCardHeader()
        .setTitle('予約情報')
        .setSubtitle(booking.bookingId)
        .setImageStyle(CardService.ImageStyle.CIRCLE)
        .setImageUrl('https://fonts.gstatic.com/s/i/short-term/release/materialsymbolsoutlined/calendar_today/default/24px.svg')
    );

  // 予約詳細セクション
  const detailSection = CardService.newCardSection()
    .setHeader('予約詳細');

  detailSection.addWidget(
    CardService.newKeyValue()
      .setTopLabel('お客様')
      .setContent(booking.userName || '（不明）')
  );
  detailSection.addWidget(
    CardService.newKeyValue()
      .setTopLabel('日時')
      .setContent(dateStr)
  );
  detailSection.addWidget(
    CardService.newKeyValue()
      .setTopLabel('メニュー')
      .setContent(booking.menuName || '（不明）')
  );
  detailSection.addWidget(
    CardService.newKeyValue()
      .setTopLabel('担当者')
      .setContent(booking.staffName)
  );
  detailSection.addWidget(
    CardService.newKeyValue()
      .setTopLabel('ステータス')
      .setContent(statusEmoji + ' ' + booking.status)
  );

  card.addSection(detailSection);

  // 操作ボタンセクション（未確定の予約のみ表示）
  if (isPending) {
    const actionSection = CardService.newCardSection()
      .setHeader('ステータス変更');

    const visitBtn = CardService.newTextButton()
      .setText('✅ 来店確認')
      .setTextButtonStyle(CardService.TextButtonStyle.FILLED)
      .setBackgroundColor('#4E7A5A')
      .setOnClickAction(
        CardService.newAction()
          .setFunctionName('handleStatusUpdate_')
          .setParameters({ bookingId: booking.bookingId, newStatus: '来店' })
      );

    const cancelBtn = CardService.newTextButton()
      .setText('キャンセル')
      .setTextButtonStyle(CardService.TextButtonStyle.FILLED)
      .setBackgroundColor('#A8A8A8')
      .setOnClickAction(
        CardService.newAction()
          .setFunctionName('handleStatusUpdate_')
          .setParameters({ bookingId: booking.bookingId, newStatus: 'キャンセル' })
      );

    const noshowBtn = CardService.newTextButton()
      .setText('無断キャンセル')
      .setTextButtonStyle(CardService.TextButtonStyle.FILLED)
      .setBackgroundColor('#C05252')
      .setOnClickAction(
        CardService.newAction()
          .setFunctionName('handleStatusUpdate_')
          .setParameters({ bookingId: booking.bookingId, newStatus: '無断キャンセル' })
      );

    const btnSet = CardService.newButtonSet()
      .addButton(visitBtn)
      .addButton(cancelBtn)
      .addButton(noshowBtn);

    actionSection.addWidget(btnSet);
    card.addSection(actionSection);
  } else {
    const doneSection = CardService.newCardSection();
    doneSection.addWidget(
      CardService.newTextParagraph()
        .setText('このご予約はすでに確定済みです（' + booking.status + '）。')
    );
    card.addSection(doneSection);
  }

  return card.build();
}

/**
 * ボタンクリック時のステータス更新ハンドラ
 * @param {Object} e - アクションイベント
 * @returns {CardService.ActionResponse}
 */
function handleStatusUpdate_(e) {
  try {
    const bookingId = e.parameters.bookingId;
    const newStatus = e.parameters.newStatus;

    confirmBookingStatus(bookingId, newStatus);

    const notification = CardService.newNotification()
      .setText('ステータスを「' + newStatus + '」に更新しました');

    return CardService.newActionResponseBuilder()
      .setNotification(notification)
      .setStateChanged(true)
      .build();

  } catch (err) {
    const notification = CardService.newNotification()
      .setText('エラー: ' + err.message);
    return CardService.newActionResponseBuilder()
      .setNotification(notification)
      .build();
  }
}

/**
 * シンプルなメッセージカードを構築する
 */
function buildMessageCard_(title, message) {
  return CardService.newCardBuilder()
    .setHeader(CardService.newCardHeader().setTitle(title))
    .addSection(
      CardService.newCardSection().addWidget(
        CardService.newTextParagraph().setText(message)
      )
    )
    .build();
}

/**
 * 日時を日本語フォーマットに変換する
 */
function formatDatetime_(startTime, endTime) {
  if (!startTime) return '（不明）';
  const days = ['日', '月', '火', '水', '木', '金', '土'];
  const pad = n => String(n).padStart(2, '0');
  const d = startTime;
  const dateStr = (d.getMonth() + 1) + '月' + d.getDate() + '日（' + days[d.getDay()] + '）';
  const startStr = pad(d.getHours()) + ':' + pad(d.getMinutes());
  if (!endTime) return dateStr + ' ' + startStr + '〜';
  const e = endTime;
  const endStr = pad(e.getHours()) + ':' + pad(e.getMinutes());
  return dateStr + ' ' + startStr + '〜' + endStr;
}
