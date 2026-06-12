// =================================================================
// 定数・設定
// =================================================================

// URLのクエリパラメータから設定値を取得
const urlParams = new URLSearchParams(window.location.search);
const GAS_API_URL = urlParams.get('gasApiUrl');
const LIFF_ID = urlParams.get('liffId');

let userProfile = null;

// =================================================================
// 初期化処理
// =================================================================

window.onload = async () => {
  try {
    // 必須パラメータの存在チェック
    if (!GAS_API_URL || !LIFF_ID) {
      throw new Error('設定情報が不足しています。URLを確認してください。');
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
    // ログインしていない場合はログインページにリダイレクト
    liff.login(); 
    return;
  }
  userProfile = await liff.getProfile();
  document.getElementById('welcomeMessage').textContent = `${userProfile.displayName}様、こんにちは！`;
}

/**
 * アプリケーションの初期化（GASから設定情報を取得）
 */
async function initializeApp() {
  const response = await fetchApi('getInitData');
  const { shopName, serviceMenus } = response;

  document.getElementById('shopName').textContent = shopName || '予約システム';

  const menuSelector = document.getElementById('menuSelector');
  menuSelector.innerHTML = '<option value="">--- メニューを選択してください ---</option>';
  serviceMenus.forEach(menu => {
    const option = document.createElement('option');
    option.value = menu.duration;
    option.textContent = `${menu.name} (${menu.duration}分)`;
    option.dataset.name = menu.name;
    menuSelector.appendChild(option);
  });

  // 翌日の日付をデフォルトで設定
  const today = new Date();
  const jstOffset = 9 * 60; // JSTはUTC+9
  const jstDate = new Date(today.getTime() + (today.getTimezoneOffset() + jstOffset) * 60000);
  
  jstDate.setDate(jstDate.getDate() + 1);
  const tomorrowString = jstDate.toISOString().split('T')[0];
  document.getElementById('dateSelector').value = tomorrowString;

  // 予約可能な最も早い日（今日）を設定
  const todayString = new Date(today.getTime() + (today.getTimezoneOffset() + jstOffset) * 60000).toISOString().split('T')[0];
  document.getElementById('dateSelector').min = todayString;
}

/**
 * イベントリスナーの設定
 */
function setupEventListeners() {
  const menuSelector = document.getElementById('menuSelector');
  const dateSelector = document.getElementById('dateSelector');
  const submitButton = document.getElementById('submitButton');

  menuSelector.addEventListener('change', fetchAndRenderAvailableSlots);
  dateSelector.addEventListener('change', fetchAndRenderAvailableSlots);
  submitButton.addEventListener('click', handleBookingSubmit);
}

// =================================================================
// UI制御・表示関連
// =================================================================

/**
 * ローディング画面を非表示にし、アプリ本体を表示
 */
function showApp() {
  document.getElementById('loading').style.display = 'none';
  document.getElementById('app').style.display = 'block';
}

/**
 * エラー画面を表示
 * @param {string} message - 表示するエラーメッセージ
 */
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
  const dateSelector = document.getElementById('dateSelector');
  const timeSlotsSection = document.getElementById('timeSlotsSection');
  const timeSlotsDiv = document.getElementById('timeSlots');
  const timeSlotsMessage = document.getElementById('timeSlotsMessage');

  // 選択状態をリセット
  document.getElementById('submitButton').disabled = true;
  const selectedButton = document.querySelector('.time-slot-button.selected');
  if (selectedButton) {
    selectedButton.classList.remove('selected');
  }

  // メニューと日付が両方選択されている場合のみAPIを呼び出す
  if (!menuSelector.value || !dateSelector.value) {
    timeSlotsSection.style.display = 'none';
    return;
  }

  timeSlotsDiv.innerHTML = '';
  timeSlotsMessage.textContent = '空き時間を検索中...';
  timeSlotsSection.style.display = 'block';

  try {
    const availableSlots = await fetchApi('getAvailableSlots', { 
      date: dateSelector.value, 
      duration: parseInt(menuSelector.value) 
    });

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

/**
 * 時間枠ボタンがクリックされたときの処理
 * @param {Event} event - クリックイベント
 */
function handleTimeSlotSelection(event) {
  // すべてのボタンの選択状態を解除
  document.querySelectorAll('.time-slot-button').forEach(btn => {
    btn.classList.remove('selected');
  });
  // クリックされたボタンを選択状態にする
  event.target.classList.add('selected');
  
  // 予約確定ボタンを有効化
  document.getElementById('submitButton').disabled = false;
}

// =================================================================
// API通信
// =================================================================

/**
 * GASのAPIを呼び出す共通関数
 * @param {string} action - 実行するアクション名
 * @param {object} payload - 送信するデータ
 * @returns {Promise<any>} APIからのレスポンスデータ
 */
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

/**
 * 予約確定ボタンが押されたときの処理
 */
async function handleBookingSubmit() {
  const submitButton = document.getElementById('submitButton');
  submitButton.disabled = true;
  submitButton.textContent = '予約処理中...';

  try {
    // --- 1. 予約情報を収集 ---
    const menuSelector = document.getElementById('menuSelector');
    const selectedMenuOption = menuSelector.options[menuSelector.selectedIndex];
    const selectedTimeButton = document.querySelector('.time-slot-button.selected');

    if (!userProfile || !selectedMenuOption.dataset.name || !selectedTimeButton) {
      throw new Error('予約情報が不完全です。');
    }

    const bookingData = {
      lineUserId: userProfile.userId,
      userName: userProfile.displayName,
      menuName: selectedMenuOption.dataset.name,
      duration: parseInt(selectedMenuOption.value, 10),
      startDateTime: `${document.getElementById('dateSelector').value}T${selectedTimeButton.dataset.time}`
    };

    // --- 2. APIを呼び出して予約を作成 ---
    const result = await fetchApi('createBooking', { bookingData });

    // --- 3. 成功した場合、完了画面を表示 ---
    showBookingCompleteScreen(result);

  } catch (error) {
    console.error('予約の作成に失敗しました:', error);
    alert(`エラーが発生しました: ${error.message}`);
    submitButton.disabled = false;
    submitButton.textContent = '予約を確定する';
  }
}

/**
 * 予約完了画面を表示し、詳細情報を設定する
 * @param {object} bookingResult - createBooking APIからのレスポンス
 */
function showBookingCompleteScreen(bookingResult) {
  const { eventTitle, startTime, endTime, shopName } = bookingResult;

  // 予約フォームを非表示に
  document.getElementById('app').style.display = 'none';

  // 完了画面に情報を設定
  document.getElementById('completeShopName').textContent = shopName;
  document.getElementById('completeUserName').textContent = userProfile.displayName;
  
  const startTimeObj = new Date(startTime);
  const formattedDateTime = `${startTimeObj.toLocaleDateString('ja-JP')} ${startTimeObj.toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' })}`;
  document.getElementById('completeDateTime').textContent = formattedDateTime;
  
  const menuSelector = document.getElementById('menuSelector');
  const selectedMenuOption = menuSelector.options[menuSelector.selectedIndex];
  document.getElementById('completeMenuName').textContent = selectedMenuOption.dataset.name;

  // GoogleカレンダーのURLを生成
  const formatGCDate = (dateStr) => new Date(dateStr).toISOString().replace(/-|:|\.\d{3}/g, '');
  const googleCalendarUrl = new URL('https://www.google.com/calendar/render');
  googleCalendarUrl.searchParams.append('action', 'TEMPLATE');
  googleCalendarUrl.searchParams.append('text', eventTitle);
  googleCalendarUrl.searchParams.append('dates', `${formatGCDate(startTime)}/${formatGCDate(endTime)}`);
  googleCalendarUrl.searchParams.append('details', `店舗: ${shopName}\nご予約ありがとうございます。`);
  document.getElementById('googleCalendarLink').href = googleCalendarUrl.toString();

  // 完了画面を表示
  document.getElementById('bookingComplete').style.display = 'block';
}