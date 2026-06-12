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
    showApp();
  } catch (error) {
    console.error(error);
    showError(error.message);
  }
};

/**
 * LIFFの初期化とプロファイル取得
 */
async function initializeLiff() {
  await liff.init({ liffId: LIFF_ID });
  if (!liff.isLoggedIn()) {
    liff.login(); 
    await new Promise(() => {});
  }
  userProfile = await liff.getProfile();
  document.getElementById('welcomeMessage').textContent = `${userProfile.displayName}様、こんにちは！`;
}

/**
 * アプリケーションの初期化（GASから設定情報を取得）
 */
async function initializeApp() {
  const response = await fetchApi('getInitData');
  const { shopName, serviceMenus, isStaffFeatureEnabled, staffs } = response;

  document.getElementById('shopName').textContent = shopName || '予約システム';

  // メニューセレクターの生成
  const menuSelector = document.getElementById('menuSelector');
  menuSelector.innerHTML = '<option value="">--- メニューを選択してください ---</option>';
  serviceMenus.forEach(menu => {
    const option = document.createElement('option');
    option.value = menu.duration;
    option.textContent = `${menu.name} (${menu.duration}分)`;
    option.dataset.name = menu.name;
    menuSelector.appendChild(option);
  });

  // 担当者機能が有効な場合、担当者セレクターを生成・表示
  if (isStaffFeatureEnabled && staffs.length > 0) {
    const staffSelectorSection = document.getElementById('staffSelectorSection');
    const staffSelector = document.getElementById('staffSelector');
    
    staffSelector.innerHTML = '<option value="">--- 担当者を選択してください ---</option>';
    staffs.forEach(staff => {
      const option = document.createElement('option');
      option.value = staff.email; // 識別子としてemailを使用
      option.textContent = staff.name;
      staffSelector.appendChild(option);
    });

    staffSelectorSection.style.display = 'block';
    document.getElementById('dateSelectorTitle').textContent = '3. ご希望の日を選択';
  }

  // 日付セレクターの初期設定
  const today = new Date();
  const jstOffset = 9 * 60;
  const jstDate = new Date(today.getTime() + (today.getTimezoneOffset() + jstOffset) * 60000);
  
  jstDate.setDate(jstDate.getDate() + 1);
  const tomorrowString = jstDate.toISOString().split('T')[0];
  document.getElementById('dateSelector').value = tomorrowString;

  const todayString = new Date(today.getTime() + (today.getTimezoneOffset() + jstOffset) * 60000).toISOString().split('T')[0];
  document.getElementById('dateSelector').min = todayString;
}

/**
 * イベントリスナーの設定
 */
function setupEventListeners() {
  const menuSelector = document.getElementById('menuSelector');
  const staffSelector = document.getElementById('staffSelector');
  const dateSelector = document.getElementById('dateSelector');
  const submitButton = document.getElementById('submitButton');

  menuSelector.addEventListener('change', fetchAndRenderAvailableSlots);
  staffSelector.addEventListener('change', fetchAndRenderAvailableSlots);
  dateSelector.addEventListener('change', fetchAndRenderAvailableSlots);
  submitButton.addEventListener('click', handleBookingSubmit);
}

// =================================================================
// UI制御・表示関連
// =================================================================

function showApp() {
  document.getElementById('loading').style.display = 'none';
  document.getElementById('app').style.display = 'block';
}

function showError(message) {
  document.getElementById('loading').style.display = 'none';
  document.getElementById('errorMessage').textContent = message;
  document.getElementById('error').style.display = 'block';
}

/**
 * 空き時間枠を取得し、画面に描画する
 */
async function fetchAndRenderAvailableSlots() {
  const menuSelector = document.getElementById('menuSelector');
  const staffSelector = document.getElementById('staffSelector');
  const dateSelector = document.getElementById('dateSelector');
  const timeSlotsSection = document.getElementById('timeSlotsSection');
  const timeSlotsDiv = document.getElementById('timeSlots');
  const timeSlotsMessage = document.getElementById('timeSlotsMessage');

  document.getElementById('submitButton').disabled = true;
  const selectedButton = document.querySelector('.time-slot-button.selected');
  if (selectedButton) {
    selectedButton.classList.remove('selected');
  }

  const duration = menuSelector.value;
  const date = dateSelector.value;
  const staffEmail = staffSelector.value;
  const isStaffFeatureEnabled = document.getElementById('staffSelectorSection').style.display === 'block';

  // APIを呼び出す条件をチェック
  let shouldFetch = false;
  if (isStaffFeatureEnabled) {
    // 担当者機能ON: メニュー、担当者、日付がすべて選択されているか
    if (duration && staffEmail && date) {
      shouldFetch = true;
    }
  } else {
    // 担当者機能OFF: メニューと日付が選択されているか
    if (duration && date) {
      shouldFetch = true;
    }
  }

  if (!shouldFetch) {
    timeSlotsSection.style.display = 'none';
    return;
  }

  timeSlotsDiv.innerHTML = '';
  timeSlotsMessage.textContent = '空き時間を検索中...';
  timeSlotsSection.style.display = 'block';

  try {
    // 【注意】現時点ではstaffEmailをAPIに渡しても、バックエンドの空き枠計算ロジックは未対応です
    const payload = { 
      date: date, 
      duration: parseInt(duration),
      staffEmail: staffEmail // 担当者情報を追加
    };
    const availableSlots = await fetchApi('getAvailableSlots', payload);

    if (availableSlots.length > 0) {
      availableSlots.forEach(slot => {
        const button = document.createElement('button');
        button.className = 'time-slot-button';
        button.textContent = slot;
        button.dataset.time = slot;
        button.addEventListener('click', handleTimeSlotSelection);
        timeSlotsDiv.appendChild(button);
      });
      timeSlotsMessage.textContent = '';
    } else {
      timeSlotsMessage.textContent = 'ご指定の条件では、予約可能な時間がありません。';
    }
  } catch (error) {
    console.error('空き枠の取得に失敗しました:', error);
    timeSlotsMessage.textContent = 'エラーが発生しました。時間をおいて再度お試しください。';
  }
}

function handleTimeSlotSelection(event) {
  document.querySelectorAll('.time-slot-button').forEach(btn => {
    btn.classList.remove('selected');
  });
  event.target.classList.add('selected');
  document.getElementById('submitButton').disabled = false;
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
    const menuSelector = document.getElementById('menuSelector');
    const staffSelector = document.getElementById('staffSelector');
    const selectedMenuOption = menuSelector.options[menuSelector.selectedIndex];
    const selectedStaffOption = staffSelector.options[staffSelector.selectedIndex];
    const selectedTimeButton = document.querySelector('.time-slot-button.selected');

    if (!userProfile || !selectedMenuOption.dataset.name || !selectedTimeButton) {
      throw new Error('予約情報が不完全です。');
    }

    const bookingData = {
      lineUserId: userProfile.userId,
      userName: userProfile.displayName,
      menuName: selectedMenuOption.dataset.name,
      duration: parseInt(selectedMenuOption.value, 10),
      startDateTime: `${document.getElementById('dateSelector').value}T${selectedTimeButton.dataset.time}`,
      staffEmail: selectedStaffOption ? selectedStaffOption.value : '',
      staffName: selectedStaffOption ? selectedStaffOption.textContent : ''
    };

    const result = await fetchApi('createBooking', { bookingData });
    showBookingCompleteScreen(result);

  } catch (error) {
    console.error('予約の作成に失敗しました:', error);
    alert(`エラーが発生しました: ${error.message}`);
    submitButton.disabled = false;
    submitButton.textContent = '予約を確定する';
  }
}

function showBookingCompleteScreen(bookingResult) {
  const { eventTitle, startTime, endTime, shopName } = bookingResult;

  document.getElementById('app').style.display = 'none';

  document.getElementById('completeShopName').textContent = shopName;
  document.getElementById('completeUserName').textContent = userProfile.displayName;
  
  const startTimeObj = new Date(startTime);
  const formattedDateTime = `${startTimeObj.toLocaleDateString('ja-JP')} ${startTimeObj.toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' })}`;
  document.getElementById('completeDateTime').textContent = formattedDateTime;
  
  const menuSelector = document.getElementById('menuSelector');
  const selectedMenuOption = menuSelector.options[menuSelector.selectedIndex];
  document.getElementById('completeMenuName').textContent = selectedMenuOption.dataset.name;

  // 担当者情報があれば表示
  const staffSelector = document.getElementById('staffSelector');
  const selectedStaffOption = staffSelector.options[staffSelector.selectedIndex];
  if (selectedStaffOption && selectedStaffOption.value) {
    document.getElementById('completeStaffName').textContent = selectedStaffOption.textContent;
    document.getElementById('completeStaffP').style.display = 'block';
  }

  const formatGCDate = (dateStr) => new Date(dateStr).toISOString().replace(/-|:|\.\d{3}/g, '');
  const googleCalendarUrl = new URL('https://www.google.com/calendar/render');
  googleCalendarUrl.searchParams.append('action', 'TEMPLATE');
  googleCalendarUrl.searchParams.append('text', eventTitle);
  googleCalendarUrl.searchParams.append('dates', `${formatGCDate(startTime)}/${formatGCDate(endTime)}`);
  googleCalendarUrl.searchParams.append('details', `店舗: ${shopName}\nご予約ありがとうございます。`);
  document.getElementById('googleCalendarLink').href = googleCalendarUrl.toString();

  document.getElementById('bookingComplete').style.display = 'block';
}