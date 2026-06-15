// =================================================================
// 定数・設定
// =================================================================

function getLiffParams() {
  let gasApiUrl = sessionStorage.getItem('gasApiUrl');
  let liffId = sessionStorage.getItem('liffId');

  if (!gasApiUrl || !liffId) {
    const urlParams = new URLSearchParams(window.location.search);
    gasApiUrl = urlParams.get('gasApiUrl');
    liffId = urlParams.get('liffId');

    if (gasApiUrl && liffId) {
      sessionStorage.setItem('gasApiUrl', gasApiUrl);
      sessionStorage.setItem('liffId', liffId);
    }
  }
  return { gasApiUrl, liffId };
}

const { gasApiUrl: GAS_API_URL, liffId: LIFF_ID } = getLiffParams();
let userProfile = null;

const bookingState = {
  visitExperience: null,
  bookingType: null,
  menu: null,
  staff: null,
  dateTime: null,
};

let initData = {};
let currentWeekStartDate = null;

// =================================================================
// 初期化処理
// =================================================================

window.onload = async () => {
  try {
    if (!GAS_API_URL || !LIFF_ID) {
      throw new Error('設定情報が不足しています。LIFFアプリのURL設定を確認してください。');
    }
    await initializeLiff();
    await initializeApp();
    setupEventListeners();
    showSection('section-step1-visit-experience');
    showApp();
  } catch (error) {
    console.error(error);
    showError(error.message);
  }
};

async function initializeLiff() {
  await liff.init({ liffId: LIFF_ID });
  if (!liff.isLoggedIn()) {
    liff.login(); 
    await new Promise(() => {});
  }
  userProfile = await liff.getProfile();
  document.getElementById('welcomeMessage').textContent = `${userProfile.displayName}様、こんにちは！`;
}

async function initializeApp() {
  initData = await fetchApi('getInitData');
  document.getElementById('shopName').textContent = initData.shopName || '予約システム';
  
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const dayOfWeek = today.getDay();
  const startDate = new Date(today.getTime()); 
  const diff = startDate.getDate() - dayOfWeek + (dayOfWeek === 0 ? -6 : 1);
  startDate.setDate(diff);
  currentWeekStartDate = startDate;
}

// =================================================================
// イベントリスナー設定
// =================================================================

function setupEventListeners() {
  const mainElement = document.querySelector('main');

  mainElement.addEventListener('click', (e) => {
    const selectionButton = e.target.closest('.selection-button[data-next-step]');
    const backButton = e.target.closest('.back-button');
    const slotButton = e.target.closest('#timetable .slot:not(.unavailable)');

    if (selectionButton) {
      handleSelectionButtonClick(selectionButton);
    } else if (backButton) {
      handleBackButtonClick(backButton);
    } else if (slotButton) {
      handleSlotClick(slotButton);
    }
  });

  document.getElementById('prev-week-button').addEventListener('click', () => {
    const newDate = new Date(currentWeekStartDate.getTime());
    newDate.setDate(newDate.getDate() - 7);
    currentWeekStartDate = newDate;
    renderTimetable();
    document.querySelector('.timetable-wrapper').scrollTop = 0;
  });

  document.getElementById('next-week-button').addEventListener('click', () => {
    const newDate = new Date(currentWeekStartDate.getTime());
    newDate.setDate(newDate.getDate() + 7);
    currentWeekStartDate = newDate;
    renderTimetable();
    document.querySelector('.timetable-wrapper').scrollTop = 0;
  });

  document.getElementById('staff-selector').addEventListener('change', (e) => {
    const staffEmail = e.target.value;
    const staff = initData.staffs.find(s => s.email === staffEmail);
    bookingState.staff = staff || { name: '指名なし', email: 'any' };
    renderTimetable();
  });

  // 予約確定ボタンのイベントリスナーを追加
  document.getElementById('submitButton').addEventListener('click', handleBookingSubmit);
}

// =================================================================
// イベントハンドラ
// =================================================================

function handleSelectionButtonClick(button) {
  const nextStepId = button.dataset.nextStep;
  const value = button.dataset.value;
  const currentSectionId = button.closest('.page-section').id;
  
  handleStepCompletion(currentSectionId, value, button);

  if (nextStepId === 'unimplemented') {
    alert('この機能は現在準備中です。');
    return;
  }
  showSection(`section-${nextStepId}`);
}

function handleBackButtonClick(button) {
  const prevStepId = button.dataset.prevStep;
  showSection(`section-${prevStepId}`);
}

function handleSlotClick(slot) {
  document.querySelectorAll('#timetable .slot.selected').forEach(s => s.classList.remove('selected'));
  slot.classList.add('selected');
  bookingState.dateTime = slot.dataset.datetime;
  document.getElementById('submitButton').disabled = false;
}

function handleStepCompletion(completedSectionId, selectedValue, targetElement) {
  switch (completedSectionId) {
    case 'section-step1-visit-experience':
      bookingState.visitExperience = selectedValue;
      if (selectedValue === 'first-time') {
        console.log("「初めてのご予約」が選択されました。顧客登録フローを実装予定。");
      }
      break;
    case 'section-step3-menu':
      const menu = initData.serviceMenus.find(m => m.name === targetElement.dataset.value);
      bookingState.menu = menu;
      break;
  }
}

// =================================================================
// 画面表示・制御
// =================================================================

function showSection(sectionId) {
  prepareSection(sectionId);

  document.querySelectorAll('.page-section').forEach(section => {
    section.style.display = 'none';
  });
  const targetSection = document.getElementById(sectionId);
  if (targetSection) {
    targetSection.style.display = 'block';
  } else {
    console.error(`セクションが見つかりません: ${sectionId}`);
  }
}

function prepareSection(sectionId) {
  switch (sectionId) {
    case 'section-step3-menu':
      renderMenuList();
      break;
    case 'section-step4-datetime':
      renderStaffSelector();
      const infoEl = document.getElementById('lookahead-days-info');
      if (initData.bookingLookaheadDays) {
        infoEl.textContent = `※本日より${initData.bookingLookaheadDays}日後までのご予約が可能です。`;
      }
      renderTimetable();
      break;
  }
}

function renderMenuList() {
  const container = document.getElementById('menu-list-container');
  container.innerHTML = '';
  initData.serviceMenus.forEach(menu => {
    const button = document.createElement('button');
    button.className = 'selection-button';
    button.textContent = `${menu.name} (${menu.duration}分)`;
    button.dataset.nextStep = 'step4-datetime';
    button.dataset.value = menu.name;
    container.appendChild(button);
  });
}

function renderStaffSelector() {
  const container = document.getElementById('staff-selector-container');
  const selector = document.getElementById('staff-selector');
  
  if (initData.isStaffFeatureEnabled && initData.staffs.length > 0) {
    selector.innerHTML = '<option value="any">指名なし</option>';
    initData.staffs.forEach(staff => {
      const option = document.createElement('option');
      option.value = staff.email;
      option.textContent = staff.name;
      selector.appendChild(option);
    });
    container.style.display = 'block';
    bookingState.staff = { name: '指名なし', email: 'any' };
  } else {
    container.style.display = 'none';
    bookingState.staff = null;
  }
}

// ...（既存のrenderTimetable関数を完全に置き換え）...

async function renderTimetable() {
  const timetableBody = document.querySelector('#timetable tbody');
  const timetableHead = document.querySelector('#timetable thead');
  timetableBody.innerHTML = '<tr><td colspan="8" style="padding: 20px;">空き時間を検索中...</td></tr>';
  timetableHead.innerHTML = '';

  const monthDisplay = new Date(currentWeekStartDate.getTime());
  monthDisplay.setDate(monthDisplay.getDate() + 3);
  document.getElementById('month-display').textContent = `${monthDisplay.getFullYear()}年 ${monthDisplay.getMonth() + 1}月`;

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  document.getElementById('prev-week-button').disabled = currentWeekStartDate.getTime() <= today.getTime();
  
  const maxDate = new Date();
  maxDate.setHours(0,0,0,0);
  maxDate.setDate(maxDate.getDate() + (initData.bookingLookaheadDays || 90));
  document.getElementById('next-week-button').disabled = currentWeekStartDate.getTime() >= maxDate.getTime();

  const weeklyAvailableSlots = await fetchApi('getAvailableSlots', { 
    date: `${currentWeekStartDate.getFullYear()}-${String(currentWeekStartDate.getMonth() + 1).padStart(2, '0')}-${String(currentWeekStartDate.getDate()).padStart(2, '0')}`,
    duration: bookingState.menu.duration,
    staffEmail: bookingState.staff ? bookingState.staff.email : null
  });

  let headerHtml = '<tr><th></th>';
  const daysOfWeek = ['日', '月', '火', '水', '木', '金', '土'];
  for (let i = 0; i < 7; i++) {
    const d = new Date(currentWeekStartDate.getTime());
    d.setDate(d.getDate() + i);
    const dayClass = d.getDay() === 0 ? 'is-sunday' : (d.getDay() === 6 ? 'is-saturday' : '');
    headerHtml += `<th class="${dayClass}">${d.getDate()}<br><span class="day-of-week">(${daysOfWeek[d.getDay()]})</span></th>`;
  }
  headerHtml += '</tr>';
  timetableHead.innerHTML = headerHtml;

  let bodyHtml = '';
  const timeUnit = parseInt(initData.bookingTimeUnit || 30, 10);
  for (let hour = 9; hour < 20; hour++) {
    for (let min = 0; min < 60; min += timeUnit) {
      const timeStr = `${String(hour).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
      bodyHtml += `<tr><th>${timeStr}</th>`;
      for (let i = 0; i < 7; i++) {
        const d = new Date(currentWeekStartDate.getTime());
        d.setDate(d.getDate() + i);
        const year = d.getFullYear();
        const month = String(d.getMonth() + 1).padStart(2, '0');
        const date = String(d.getDate()).padStart(2, '0');
        const dateStr = `${year}-${month}-${date}`;
        const dailyAvailableSlots = weeklyAvailableSlots[dateStr] || [];
        
        let cellContent = 'ー';
        let cellClass = 'unavailable';

        if (d.getTime() >= today.getTime() && d.getTime() <= maxDate.getTime()) {
          if (dailyAvailableSlots.includes(timeStr)) {
            cellContent = '◯';
            cellClass = '';
          } else {
            cellContent = '✕';
          }
        }
        
        // ▼▼▼【修正】data-datetime属性にタイムゾーン情報を付与▼▼▼
        const dateTimeString = `${dateStr}T${timeStr}:00+09:00`;
        bodyHtml += `<td><div class="slot ${cellClass}" data-datetime="${dateTimeString}">${cellContent}</div></td>`;
      }
      bodyHtml += '</tr>';
    }
  }
  timetableBody.innerHTML = bodyHtml;
}

function showApp() {
  document.getElementById('loading').style.display = 'none';
  document.getElementById('app').style.display = 'block';
}

function showError(message) {
  document.getElementById('loading').style.display = 'none';
  document.getElementById('errorMessage').textContent = message;
  document.getElementById('error').style.display = 'block';
}

// =================================================================
// API通信
// =================================================================

async function fetchApi(action, payload = {}) {
  const response = await fetch(GAS_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'text/plain;charset=utf-8',
    },
    body: JSON.stringify({ action, ...payload }),
    mode: 'cors',
  });

  const result = await response.json();

  if (!result.success) {
    throw new Error(result.message || 'APIで不明なエラーが発生しました。');
  }

  return result.data;
}

// =================================================================
// 予約確定処理
// =================================================================

async function handleBookingSubmit() {
  const submitButton = document.getElementById('submitButton');
  submitButton.disabled = true;
  submitButton.textContent = '予約処理中...';

  try {
    if (!userProfile || !bookingState.menu || !bookingState.dateTime) {
      throw new Error('予約情報が不完全です。');
    }

    const bookingData = {
      lineUserId: userProfile.userId,
      userName: userProfile.displayName,
      menuName: bookingState.menu.name,
      duration: bookingState.menu.duration,
      startDateTime: bookingState.dateTime,
      staffEmail: bookingState.staff ? bookingState.staff.email : '',
      staffName: bookingState.staff ? bookingState.staff.name : ''
    };

    const result = await fetchApi('createBooking', { bookingData });
    showBookingCompleteScreen(result);

  } catch (error) {
    console.error('予約の作成に失敗しました:', error);
    alert(`エラーが発生しました: ${error.message}`);
    
    submitButton.textContent = '空き枠を更新中...';
    try {
      await renderTimetable();
    } finally {
      submitButton.textContent = '予約を確定';
      submitButton.disabled = true; // 予約失敗後は再度日時選択から
    }
  }
}

function showBookingCompleteScreen(bookingResult) {
  const { eventTitle, startTime, shopName } = bookingResult;

  // メインの予約画面を非表示に
  document.getElementById('app').style.display = 'none';

  // 完了画面に情報を設定
  document.getElementById('completeShopName').textContent = shopName;
  document.getElementById('completeUserName').textContent = userProfile.displayName;
  
  const startTimeObj = new Date(startTime);
  const formattedDateTime = `${startTimeObj.toLocaleDateString('ja-JP')} ${startTimeObj.toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' })}`;
  document.getElementById('completeDateTime').textContent = formattedDateTime;
  
  document.getElementById('completeMenuName').textContent = bookingState.menu.name;

  if (bookingState.staff && bookingState.staff.email !== 'any') {
    document.getElementById('completeStaffName').textContent = bookingState.staff.name;
    document.getElementById('completeStaffP').style.display = 'block';
  }

  const formatGCDate = (dateStr) => new Date(dateStr).toISOString().replace(/-|:|\.\d{3}/g, '');
  const endTime = new Date(startTimeObj.getTime() + bookingState.menu.duration * 60000);
  const googleCalendarUrl = new URL('https://www.google.com/calendar/render');
  googleCalendarUrl.searchParams.append('action', 'TEMPLATE');
  googleCalendarUrl.searchParams.append('text', eventTitle);
  googleCalendarUrl.searchParams.append('dates', `${formatGCDate(startTime)}/${formatGCDate(endTime.toISOString())}`);
  googleCalendarUrl.searchParams.append('details', `店舗: ${shopName}\nご予約ありがとうございます。`);
  document.getElementById('googleCalendarLink').href = googleCalendarUrl.toString();

  // 完了画面を表示
  document.getElementById('bookingComplete').style.display = 'block';
}