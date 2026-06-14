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
    setupNavigation();
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
  
  // --- ▼▼▼【バグ修正】週送りの計算ロジックを修正 ▼▼▼ ---
  const today = new Date();
  today.setHours(0, 0, 0, 0); // 今日の日付の0時0分0秒を取得

  const dayOfWeek = today.getDay(); // 0:日曜, 1:月曜...
  // new Date()で新しいインスタンスを生成し、元のtodayオブジェクトを変更しないようにする
  const startDate = new Date(today.getTime()); 
  const diff = startDate.getDate() - dayOfWeek + (dayOfWeek === 0 ? -6 : 1); // 月曜始まりに調整
  startDate.setDate(diff);
  
  currentWeekStartDate = startDate;
  // --- ▲▲▲【バグ修正】ここまで ▲▲▲ ---
}

// =================================================================
// 画面遷移（ナビゲーション）
// =================================================================

// ▼ 新設：選択ボタン押下時の共通処理を関数化（デグレ防止用）
function handleSelectionClick(e) {
  const nextStepId = e.currentTarget.dataset.nextStep;
  const value = e.currentTarget.dataset.value;
  
  const currentSectionId = e.currentTarget.closest('.page-section').id;
  handleStepCompletion(currentSectionId, value, e.currentTarget);

  if (nextStepId === 'unimplemented') {
    alert('この機能は現在準備中です。');
    return;
  }
  showSection(`section-${nextStepId}`);
}

function setupNavigation() {
  // ▼ 修正：無名関数から、切り出した handleSelectionClick の呼び出しに変更
  document.querySelectorAll('.selection-button[data-next-step]').forEach(button => {
    button.addEventListener('click', handleSelectionClick);
  });

  document.querySelectorAll('.back-button').forEach(button => {
    button.addEventListener('click', (e) => {
      const prevStepId = e.currentTarget.dataset.prevStep;
      showSection(`section-${prevStepId}`);
    });
  });

  // --- ▼▼▼【バグ修正】週送りボタンのイベントリスナーを修正 ▼▼▼ ---
  document.getElementById('prev-week-button').addEventListener('click', () => {
    const newDate = new Date(currentWeekStartDate.getTime());
    newDate.setDate(newDate.getDate() - 7);
    currentWeekStartDate = newDate;
    renderTimetable();
    // スクロール位置をリセット
    document.querySelector('.timetable-wrapper').scrollTop = 0;
  });

  document.getElementById('next-week-button').addEventListener('click', () => {
    const newDate = new Date(currentWeekStartDate.getTime());
    newDate.setDate(newDate.getDate() + 7);
    currentWeekStartDate = newDate;
    renderTimetable();
    // スクロール位置をリセット
    document.querySelector('.timetable-wrapper').scrollTop = 0;
  });
  // --- ▲▲▲【バグ修正】ここまで ▲▲▲ ---

  document.getElementById('staff-selector').addEventListener('change', (e) => {
    const staffEmail = e.target.value;
    const staff = initData.staffs.find(s => s.email === staffEmail);
    bookingState.staff = staff || { name: '指名なし', email: 'any' };
    renderTimetable();
  });
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

// =================================================================
// UI動的生成
// =================================================================

function renderMenuList() {
  const container = document.getElementById('menu-list-container');
  container.innerHTML = '';
  initData.serviceMenus.forEach(menu => {
    const button = document.createElement('button');
    button.className = 'selection-button';
    button.textContent = `${menu.name} (${menu.duration}分)`;
    button.dataset.nextStep = 'step4-datetime';
    button.dataset.value = menu.name;
    
    // ▼ 修正：setupNavigation()を呼ばず、作成したボタン単体に直接イベントを付与
    button.addEventListener('click', handleSelectionClick);
    
    container.appendChild(button);
  });
  // ▼ 修正：重複登録の原因となっていた setupNavigation(); を削除
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
    // 初期選択
    bookingState.staff = { name: '指名なし', email: 'any' };
  } else {
    container.style.display = 'none';
    bookingState.staff = null;
  }
}

async function renderTimetable() {
  const timetableBody = document.querySelector('#timetable tbody');
  const timetableHead = document.querySelector('#timetable thead');
  timetableBody.innerHTML = '<tr><td colspan="8" style="padding: 20px;">空き時間を検索中...</td></tr>';
  timetableHead.innerHTML = '';

  const monthDisplay = new Date(currentWeekStartDate);
  monthDisplay.setDate(monthDisplay.getDate() + 3); // 週の中間あたりで月を表示
  document.getElementById('month-display').textContent = `${monthDisplay.getFullYear()}年 ${monthDisplay.getMonth() + 1}月`;

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  document.getElementById('prev-week-button').disabled = currentWeekStartDate <= today;
  
  const maxDate = new Date();
  maxDate.setHours(0,0,0,0);
  maxDate.setDate(maxDate.getDate() + (initData.bookingLookaheadDays || 90));
  document.getElementById('next-week-button').disabled = currentWeekStartDate >= maxDate;

  // TODO: APIを改修して7日分の空き枠を一括取得する
  const date = new Date(currentWeekStartDate);
  const availableSlots = await fetchApi('getAvailableSlots', { 
    date: `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`,
    duration: bookingState.menu.duration,
    staffEmail: bookingState.staff ? bookingState.staff.email : null
  });

  let headerHtml = '<tr><th></th>';
  const daysOfWeek = ['日', '月', '火', '水', '木', '金', '土'];
  for (let i = 0; i < 7; i++) {
    const d = new Date(currentWeekStartDate);
    d.setDate(d.getDate() + i);
    const dayClass = d.getDay() === 0 ? 'is-sunday' : (d.getDay() === 6 ? 'is-saturday' : '');
    headerHtml += `<th class="${dayClass}">${d.getDate()}<br><span class="day-of-week">(${daysOfWeek[d.getDay()]})</span></th>`;
  }
  headerHtml += '</tr>';
  timetableHead.innerHTML = headerHtml;

  let bodyHtml = '';
  const timeUnit = initData.bookingTimeUnit || 30;
  for (let hour = 9; hour < 20; hour++) {
    for (let min = 0; min < 60; min += timeUnit) {
      const timeStr = `${String(hour).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
      bodyHtml += `<tr><th>${timeStr}</th>`;
      for (let i = 0; i < 7; i++) {
        const d = new Date(currentWeekStartDate);
        d.setDate(d.getDate() + i);
        
        let cellContent = 'ー';
        let cellClass = 'unavailable';

        if (d >= today && d <= maxDate) {
          if (availableSlots.includes(timeStr)) {
            cellContent = '◯';
            cellClass = '';
          } else {
            cellContent = '✕';
          }
        }
        
        bodyHtml += `<td><div class="slot ${cellClass}" data-datetime="${d.toISOString().split('T')[0]}T${timeStr}">${cellContent}</div></td>`;
      }
      bodyHtml += '</tr>';
    }
  }
  timetableBody.innerHTML = bodyHtml;

  document.querySelectorAll('#timetable .slot').forEach(slot => {
    if (!slot.classList.contains('unavailable')) {
      slot.addEventListener('click', (e) => {
        document.querySelectorAll('#timetable .slot.selected').forEach(s => s.classList.remove('selected'));
        e.currentTarget.classList.add('selected');
        bookingState.dateTime = e.currentTarget.dataset.datetime;
        document.getElementById('submitButton').disabled = false;
      });
    }
  });
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