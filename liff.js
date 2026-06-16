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
let isCustomerRegistered = false;

const bookingState = {
  visitExperience: null,
  bookingType: null,
  menu: null,
  staff: null,
  selectedSlots: [],
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
  initData = await fetchApi('getInitData', { lineUserId: userProfile.userId });
  isCustomerRegistered = initData.isRegistered || false;
  // 診断ログ（本番確認後に削除可）
  console.log('[initData]', JSON.stringify(initData));
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

  // 顧客情報登録ボタン
  document.getElementById('register-customer-button').addEventListener('click', handleCustomerRegistration);

  // 予約確定ボタン
  document.getElementById('submitButton').addEventListener('click', handleBookingSubmit);

  // カウンターチップのタップ → パネル開閉
  document.getElementById('bulk-counter').addEventListener('click', () => {
    toggleDatesPanel();
  });

  // 選択済み日時パネルの✕ボタン（イベントデリゲーション）
  document.getElementById('selected-dates-panel').addEventListener('click', (e) => {
    const btn = e.target.closest('.remove-slot-btn');
    if (btn) removeSlot(btn.dataset.datetime);
  });

  // チップコンテナ外をクリックしたらパネルを閉じる
  document.addEventListener('click', (e) => {
    if (!e.target.closest('#bulk-chip-container')) {
      const panel = document.getElementById('selected-dates-panel');
      if (panel && panel.classList.contains('is-open')) {
        panel.classList.remove('is-open');
        panel.setAttribute('aria-hidden', 'true');
        updateBulkCounter();
      }
    }
  });
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

  // 「初めてのご予約」かつ未登録の場合は顧客情報登録画面へ
  if (currentSectionId === 'section-step1-visit-experience' && value === 'first-time' && !isCustomerRegistered) {
    showSection('section-customer-registration');
    return;
  }

  showSection(`section-${nextStepId}`);
}

function handleBackButtonClick(button) {
  const prevStepId = button.dataset.prevStep;
  showSection(`section-${prevStepId}`);
}

function handleSlotClick(slot) {
  if (slot.classList.contains('unavailable') ||
      slot.classList.contains('bulk-limit-reached') ||
      slot.classList.contains('slot-conflict')) return;

  const dateTime = slot.dataset.datetime;
  const maxBulk = initData.maxBulkBookings || 1;

  if (slot.classList.contains('selected')) {
    // 選択解除
    slot.classList.remove('selected');
    bookingState.selectedSlots = bookingState.selectedSlots.filter(s => s !== dateTime);
  } else {
    // 新規選択（上限未満のみ）
    if (bookingState.selectedSlots.length < maxBulk) {
      slot.classList.add('selected');
      bookingState.selectedSlots.push(dateTime);
    }
  }

  updateSubmitButton();
  updateBulkSlotAvailability();
  updateBulkCounter();
}

/**
 * 選択状況に応じてサブミットボタンのテキスト・活性を更新する。
 */
function updateSubmitButton() {
  const submitButton = document.getElementById('submitButton');
  const count = bookingState.selectedSlots.length;
  const maxBulk = initData.maxBulkBookings || 1;

  if (count === 0) {
    submitButton.disabled = true;
    submitButton.textContent = maxBulk > 1
      ? `日時を選択してください（最大${maxBulk}件）`
      : '日時を選択してください';
  } else if (maxBulk > 1) {
    submitButton.disabled = false;
    submitButton.textContent = `まとめて予約を確定（${count}件）`;
  } else {
    submitButton.disabled = false;
    submitButton.textContent = '予約を確定';
  }
}

/**
 * 一括予約の選択状況に応じてスロットの選択可否を更新する。
 * - 上限到達: bulk-limit-reached（グレーアウト）
 * - 選択済みスロットと時間帯が重複: slot-conflict（オレンジ警告色）
 * どちらも該当しない場合は両クラスを除去する。
 */
function updateBulkSlotAvailability() {
  const maxBulk = initData.maxBulkBookings || 1;
  const count = bookingState.selectedSlots.length;
  const limitReached = maxBulk > 1 && count >= maxBulk;
  const duration = bookingState.menu ? bookingState.menu.duration : 0;

  document.querySelectorAll('#timetable .slot:not(.unavailable)').forEach(slot => {
    if (slot.classList.contains('selected')) {
      slot.classList.remove('bulk-limit-reached', 'slot-conflict');
      return;
    }

    if (limitReached) {
      slot.classList.add('bulk-limit-reached');
      slot.classList.remove('slot-conflict');
      return;
    }

    slot.classList.remove('bulk-limit-reached');

    // 選択済みスロットとの時間帯重複チェック
    if (duration > 0 && bookingState.selectedSlots.length > 0) {
      const slotStart = new Date(slot.dataset.datetime);
      const slotEnd = new Date(slotStart.getTime() + duration * 60000);
      const hasConflict = bookingState.selectedSlots.some(selectedDT => {
        const selStart = new Date(selectedDT);
        const selEnd = new Date(selStart.getTime() + duration * 60000);
        // 時間帯の重複判定（端点は許容）
        return slotStart < selEnd && slotEnd > selStart;
      });
      if (hasConflict) {
        slot.classList.add('slot-conflict');
      } else {
        slot.classList.remove('slot-conflict');
      }
    } else {
      slot.classList.remove('slot-conflict');
    }
  });
}

/**
 * 現在週を再描画した後に selectedSlots の選択状態を視覚的に復元する。
 */
function restoreSlotSelections() {
  if (bookingState.selectedSlots.length === 0) return;
  document.querySelectorAll('#timetable .slot[data-datetime]').forEach(slot => {
    if (bookingState.selectedSlots.includes(slot.dataset.datetime)) {
      slot.classList.add('selected');
    }
  });
}

function handleStepCompletion(completedSectionId, selectedValue, targetElement) {
  switch (completedSectionId) {
    case 'section-step1-visit-experience':
      bookingState.visitExperience = selectedValue;
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
    case 'section-customer-registration':
      document.getElementById('customer-name').value = '';
      document.getElementById('customer-phone').value = '';
      break;
    case 'section-step3-menu':
      renderMenuList();
      break;
    case 'section-step4-datetime':
      bookingState.selectedSlots = [];
      if (bookingState.menu) {
        document.getElementById('current-selected-menu').textContent = `${bookingState.menu.name} (${bookingState.menu.duration}分)`;
      }
      renderStaffSelector();
      const infoEl = document.getElementById('lookahead-days-info');
      if (initData.bookingLookaheadDays) {
        infoEl.textContent = `※本日より${initData.bookingLookaheadDays}日後までのご予約が可能です。`;
      }
      updateSubmitButton();
      updateBulkCounter(); // updateSelectedDatesPanel も内部で呼ばれる
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

  restoreSlotSelections();
  updateBulkSlotAvailability();
  updateBulkCounter();
}

/**
 * バルク予約のカウンターチップを更新する。
 * スロットが1件以上あるときは件数と展開矢印を表示し、タップでパネルを開閉できる。
 */
function updateBulkCounter() {
  const counterEl = document.getElementById('bulk-counter');
  if (!counterEl) return;
  const maxBulk = initData.maxBulkBookings || 1;

  if (maxBulk <= 1) {
    counterEl.style.display = 'none';
    return;
  }

  const count = bookingState.selectedSlots.length;
  const panel = document.getElementById('selected-dates-panel');
  const isOpen = panel ? panel.classList.contains('is-open') : false;

  counterEl.style.display = 'flex';
  if (count > 0) {
    counterEl.innerHTML =
      `<span>選択中: <strong>${count}</strong> / ${maxBulk} 件</span>`
      + `<span class="bulk-counter-arrow">${isOpen ? '▲' : '▼'}</span>`;
    counterEl.style.cursor = 'pointer';
    counterEl.setAttribute('aria-expanded', isOpen);
  } else {
    counterEl.innerHTML = `<span>日時を選択してください（最大${maxBulk}件）</span>`;
    counterEl.style.cursor = 'default';
    counterEl.setAttribute('aria-expanded', 'false');
  }
  counterEl.className = `bulk-counter${count >= maxBulk ? ' bulk-counter--full' : ''}`;

  updateSelectedDatesPanel();
}

/**
 * 選択済み日時の一覧パネルのリスト内容だけを更新する。
 * 表示・非表示は toggleDatesPanel / is-open クラスで管理する。
 */
function updateSelectedDatesPanel() {
  const panel = document.getElementById('selected-dates-panel');
  const list = document.getElementById('selected-dates-list');
  if (!panel || !list) return;

  const slots = bookingState.selectedSlots;

  // スロットが0になったら強制的に閉じる
  if (slots.length === 0) {
    panel.classList.remove('is-open');
    panel.setAttribute('aria-hidden', 'true');
    return;
  }

  const dayNames = ['日', '月', '火', '水', '木', '金', '土'];
  list.innerHTML = slots.slice().sort().map(dt => {
    const d = new Date(dt);
    const label = `${d.getMonth() + 1}月${d.getDate()}日（${dayNames[d.getDay()]}）`
      + `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    return `<li class="selected-date-item">
      <span class="selected-date-label">${label}</span>
      <button class="remove-slot-btn" data-datetime="${dt}" aria-label="取り消し">✕</button>
    </li>`;
  }).join('');
}

/**
 * カウンターチップのタップでパネルを開閉する。
 */
function toggleDatesPanel() {
  const panel = document.getElementById('selected-dates-panel');
  if (!panel || bookingState.selectedSlots.length === 0) return;
  const isOpen = panel.classList.toggle('is-open');
  panel.setAttribute('aria-hidden', !isOpen);
  updateBulkCounter(); // 矢印の向きを更新
}

/**
 * パネルの✕ボタンから特定スロットの選択を解除する。
 */
function removeSlot(datetime) {
  bookingState.selectedSlots = bookingState.selectedSlots.filter(s => s !== datetime);

  // 現在の週に該当スロットが表示されていれば視覚的にも解除
  const slotEl = document.querySelector(`#timetable .slot[data-datetime="${datetime}"]`);
  if (slotEl) slotEl.classList.remove('selected');

  updateSubmitButton();
  updateBulkSlotAvailability();
  updateBulkCounter();
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
// 顧客情報登録処理
// =================================================================

async function handleCustomerRegistration() {
  const nameInput = document.getElementById('customer-name');
  const phoneInput = document.getElementById('customer-phone');
  const registerButton = document.getElementById('register-customer-button');

  const customerName = nameInput.value.trim();
  if (!customerName) {
    alert('お名前を入力してください。');
    nameInput.focus();
    return;
  }

  registerButton.disabled = true;
  registerButton.textContent = '登録中...';

  try {
    await fetchApi('registerCustomer', {
      lineUserId: userProfile.userId,
      customerName: customerName,
      phone: phoneInput.value.trim()
    });

    isCustomerRegistered = true;
    showSection('section-step2-booking-type');

  } catch (error) {
    console.error('顧客登録に失敗しました:', error);
    alert(`登録に失敗しました: ${error.message}`);
  } finally {
    registerButton.disabled = false;
    registerButton.textContent = '登録して予約に進む';
  }
}

// =================================================================
// 予約確定処理
// =================================================================

async function handleBookingSubmit() {
  const submitButton = document.getElementById('submitButton');
  submitButton.disabled = true;
  submitButton.textContent = '予約処理中...';

  try {
    if (!userProfile || !bookingState.menu || bookingState.selectedSlots.length === 0) {
      throw new Error('予約情報が不完全です。');
    }

    const baseData = {
      lineUserId: userProfile.userId,
      userName: userProfile.displayName,
      menuName: bookingState.menu.name,
      duration: bookingState.menu.duration,
      staffEmail: bookingState.staff ? bookingState.staff.email : '',
      staffName: bookingState.staff ? bookingState.staff.name : ''
    };

    let results;
    if (bookingState.selectedSlots.length === 1) {
      // 単一予約（既存の createBooking を使用）
      const bookingData = { ...baseData, startDateTime: bookingState.selectedSlots[0] };
      const result = await fetchApi('createBooking', { bookingData });
      results = [result];
    } else {
      // 一括予約
      const bookingDataList = bookingState.selectedSlots.map(slot => ({
        ...baseData,
        startDateTime: slot
      }));
      results = await fetchApi('createBulkBookings', { bookingDataList });
    }

    showBookingCompleteScreen(results);

  } catch (error) {
    console.error('予約の作成に失敗しました:', error);
    alert(`エラーが発生しました: ${error.message}`);
    
    submitButton.textContent = '空き枠を更新中...';
    try {
      await renderTimetable();
    } finally {
      updateSubmitButton();
    }
  }
}

function showBookingCompleteScreen(results) {
  // results は配列（単一予約・一括予約ともに配列で受け取る）
  const sortedResults = results.slice().sort((a, b) => new Date(a.startTime) - new Date(b.startTime));
  const firstResult = sortedResults[0];
  const { shopName } = firstResult;

  document.getElementById('app').style.display = 'none';
  document.getElementById('completeShopName').textContent = shopName;
  document.getElementById('completeUserName').textContent = userProfile.displayName;

  // 日時リストを生成
  const dateListEl = document.getElementById('completeDateTimeList');
  const formatDT = (isoStr) => {
    const d = new Date(isoStr);
    return `${d.toLocaleDateString('ja-JP')} ${d.toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' })}`;
  };

  if (sortedResults.length === 1) {
    dateListEl.innerHTML = `<p><strong>日時:</strong> ${formatDT(firstResult.startTime)}</p>`;
  } else {
    let html = `<p><strong>日時（${sortedResults.length}件）:</strong></p><ul class="booking-date-list">`;
    sortedResults.forEach(r => {
      html += `<li>${formatDT(r.startTime)}</li>`;
    });
    html += '</ul>';
    dateListEl.innerHTML = html;
  }

  document.getElementById('completeMenuName').textContent = bookingState.menu.name;

  if (bookingState.staff && bookingState.staff.email !== 'any') {
    document.getElementById('completeStaffName').textContent = bookingState.staff.name;
    document.getElementById('completeStaffP').style.display = 'block';
  }

  // Googleカレンダーリンクは最初の予約日時で生成
  const formatGCDate = (dateStr) => new Date(dateStr).toISOString().replace(/-|:|\.\d{3}/g, '');
  const gcStart = firstResult.startTime;
  const gcEnd = new Date(new Date(gcStart).getTime() + bookingState.menu.duration * 60000).toISOString();
  const googleCalendarUrl = new URL('https://www.google.com/calendar/render');
  googleCalendarUrl.searchParams.append('action', 'TEMPLATE');
  googleCalendarUrl.searchParams.append('text', firstResult.eventTitle);
  googleCalendarUrl.searchParams.append('dates', `${formatGCDate(gcStart)}/${formatGCDate(gcEnd)}`);
  const calDetails = sortedResults.length > 1
    ? `店舗: ${shopName}\n全${sortedResults.length}件のご予約ありがとうございます。`
    : `店舗: ${shopName}\nご予約ありがとうございます。`;
  googleCalendarUrl.searchParams.append('details', calDetails);
  document.getElementById('googleCalendarLink').href = googleCalendarUrl.toString();

  document.getElementById('bookingComplete').style.display = 'block';
}