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
  
  // 今日の日付を基準に、その週の月曜日を開始日として設定
  const today = new Date();
  const dayOfWeek = today.getDay(); // 0:日曜, 1:月曜...
  const diff = today.getDate() - dayOfWeek + (dayOfWeek === 0 ? -6 : 1); // 月曜始まりに調整
  currentWeekStartDate = new Date(today.setDate(diff));
  currentWeekStartDate.setHours(0, 0, 0, 0);
}

// =================================================================
// 画面遷移（ナビゲーション）
// =================================================================

function setupNavigation() {
  document.querySelectorAll('.selection-button[data-next-step]').forEach(button => {
    button.addEventListener('click', (e) => {
      const nextStepId = e.currentTarget.dataset.nextStep;
      const value = e.currentTarget.dataset.value;
      
      const currentSectionId = e.currentTarget.closest('.page-section').id;
      handleStepCompletion(currentSectionId, value, e.currentTarget);

      if (nextStepId === 'unimplemented') {
        alert('この機能は現在準備中です。');
        return;
      }
      showSection(`section-${nextStepId}`);
    });
  });

  document.querySelectorAll('.back-button').forEach(button => {
    button.addEventListener('click', (e) => {
      const prevStepId = e.currentTarget.dataset.prevStep;
      showSection(`section-${prevStepId}`);
    });
  });

  document.getElementById('prev-week-button').addEventListener('click', () => {
    currentWeekStartDate.setDate(currentWeekStartDate.getDate() - 7);
    renderTimetable();
  });

  document.getElementById('next-week-button').addEventListener('click', () => {
    currentWeekStartDate.setDate(currentWeekStartDate.getDate() + 7);
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
    case 'section-step4-staff':
      const staff = initData.staffs.find(s => s.email === targetElement.dataset.value);
      bookingState.staff = staff || { name: '指名なし', email: 'any' };
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
    case 'section-step4-staff':
      renderStaffList();
      break;
    case 'section-step5-datetime':
      const infoEl = document.getElementById('lookahead-days-info');
      if (initData.bookingLookaheadDays) {
        infoEl.textContent = `※本日より${initData.bookingLookaheadDays}日後までのご予約が可能です。`;
      }
      // 担当者機能OFFの場合に戻るボタンの遷移先を調整
      const backButton = document.getElementById('back-button-from-datetime');
      backButton.dataset.prevStep = initData.isStaffFeatureEnabled ? 'step4-staff' : 'step3-menu';
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
    button.dataset.nextStep = initData.isStaffFeatureEnabled ? 'step4-staff' : 'step5-datetime';
    button.dataset.value = menu.name;
    container.appendChild(button);
  });
  setupNavigation();
}

function renderStaffList() {
  const container = document.getElementById('staff-list-container');
  container.innerHTML = '';
  
  const noPreferenceButton = document.createElement('button');
  noPreferenceButton.className = 'selection-button';
  noPreferenceButton.textContent = '指名なし';
  noPreferenceButton.dataset.nextStep = 'step5-datetime';
  noPreferenceButton.dataset.value = 'any';
  container.appendChild(noPreferenceButton);

  initData.staffs.forEach(staff => {
    const button = document.createElement('button');
    button.className = 'selection-button';
    button.textContent = staff.name;
    button.dataset.nextStep = 'step5-datetime';
    button.dataset.value = staff.email;
    container.appendChild(button);
  });
  setupNavigation();
}

async function renderTimetable() {
  const timetableBody = document.querySelector('#timetable tbody');
  const timetableHead = document.querySelector('#timetable thead');
  timetableBody.innerHTML = '<tr><td colspan="8">空き時間を検索中...</td></tr>';
  timetableHead.innerHTML = '';

  // 週の表示を更新
  const weekEnd = new Date(currentWeekStartDate);
  weekEnd.setDate(weekEnd.getDate() + 6);
  document.getElementById('week-display').textContent = 
    `${currentWeekStartDate.getFullYear()}年${currentWeekStartDate.getMonth() + 1}月${currentWeekStartDate.getDate()}日〜${weekEnd.getMonth() + 1}月${weekEnd.getDate()}日`;

  // 週ナビゲーションボタンの有効/無効を制御
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  document.getElementById('prev-week-button').disabled = currentWeekStartDate <= today;
  
  const maxDate = new Date(today);
  maxDate.setDate(maxDate.getDate() + (initData.bookingLookaheadDays || 90));
  document.getElementById('next-week-button').disabled = weekEnd >= maxDate;

  // APIから7日分の空き枠を一括取得（※GAS側のAPIはまだ1日分しか対応していないので、今後改修が必要）
  const date = new Date(currentWeekStartDate);
  const availableSlots = await fetchApi('getAvailableSlots', { 
    date: `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`,
    duration: bookingState.menu.duration,
    staffEmail: bookingState.staff ? bookingState.staff.email : 'any'
  });

  // ヘッダーを生成
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

  // ボディを生成
  let bodyHtml = '';
  const timeUnit = initData.bookingTimeUnit || 30;
  for (let hour = 9; hour < 20; hour++) {
    for (let min = 0; min < 60; min += timeUnit) {
      const timeStr = `${String(hour).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
      bodyHtml += `<tr><th>${timeStr}</th>`;
      for (let i = 0; i < 7; i++) {
        const d = new Date(currentWeekStartDate);
        d.setDate(d.getDate() + i);
        
        let cellContent = '✕';
        let cellClass = 'unavailable';

        if (d >= today && d <= maxDate) {
          if (availableSlots.includes(timeStr)) {
            cellContent = '◯';
            cellClass = '';
          }
        }
        
        bodyHtml += `<td><div class="slot ${cellClass}" data-datetime="${d.toISOString().split('T')[0]}T${timeStr}">${cellContent}</div></td>`;
      }
      bodyHtml += '</tr>';
    }
  }
  timetableBody.innerHTML = bodyHtml;

  // クリックイベントを設定
  document.querySelectorAll('#timetable .slot').forEach(slot => {
    if (!slot.classList.contains('unavailable')) {
      slot.addEventListener('click', (e) => {
        // 他の選択を解除
        document.querySelectorAll('#timetable .slot.selected').forEach(s => s.classList.remove('selected'));
        // クリックしたスロットを選択状態に
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