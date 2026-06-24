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
/** Cloudflare Worker 上の ICS 配信（Google アカウント非依存） */
const ICS_SERVE_BASE = 'https://reservation-onboarding.reservation-onboarding.workers.dev/ics';
const ICS_SESSION_KEY = 'pending_ics_export';

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
/** 'new-booking' | 'manage-reschedule' */
let flowMode = 'new-booking';
/** 予約確認・変更フロー用 */
const manageState = {
  bookings: [],
  selectedBooking: null,
  reminderMode: 'ICS',
};
/** renderTimetable の世代番号（古い API 応答を DOM に反映しない） */
let timetableRenderGeneration = 0;

function isStaffSelectionRequired() {
  return !!(initData.isStaffFeatureEnabled && initData.staffs && initData.staffs.length > 0);
}

function canRenderTimetable() {
  if (!bookingState.menu || !currentWeekStartDate) return false;
  if (isStaffSelectionRequired() && !bookingState.staff) return false;
  return true;
}

/** "HH:mm" を分に変換 */
function parseTimeToMinutes_(timeStr) {
  const parts = String(timeStr || '00:00').split(':');
  const h = parseInt(parts[0], 10) || 0;
  const m = parseInt(parts[1], 10) || 0;
  return h * 60 + m;
}

/** 分を "HH:mm" に変換 */
function minutesToTimeStr_(minutes) {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

function getBusinessHours_() {
  return initData.businessHours || { start: '10:00', end: '19:00' };
}

function clearSelectedSlots() {
  bookingState.selectedSlots = [];
  document.querySelectorAll('#timetable .slot.selected').forEach((slot) => {
    slot.classList.remove('selected');
  });
  updateSubmitButton();
  updateBulkCounter();
}

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
  const loginRedirectUri = window.location.href.split('#')[0];

  if (!liff.isLoggedIn()) {
    liff.login({ redirectUri: loginRedirectUri });
    await new Promise(() => {});
  }

  // openid スコープ未取得などで ID Token が空の場合は再ログイン
  if (!liff.getIDToken()) {
    liff.logout();
    liff.login({ redirectUri: loginRedirectUri });
    await new Promise(() => {});
  }

  userProfile = await liff.getProfile();
  document.getElementById('welcomeMessage').textContent = `${userProfile.displayName}様、こんにちは！`;
}

async function initializeApp() {
  initData = await fetchApi('getInitData', { lineUserId: userProfile.userId });
  isCustomerRegistered = initData.isRegistered === true;
  updateStep1ButtonTargets();
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
    if (!staffEmail) return; // プレースホルダー選択時は無視
    const staff = initData.staffs.find(s => s.email === staffEmail);
    bookingState.staff = staff || { name: '指名なし', email: 'any' };
    clearSelectedSlots();
    document.getElementById('timetable-container').style.display = 'block';
    renderTimetable();
  });

  // 顧客情報登録ボタン
  document.getElementById('register-customer-button').addEventListener('click', handleCustomerRegistration);

  const customerNameInput = document.getElementById('customer-name');
  if (customerNameInput) {
    customerNameInput.addEventListener('input', () => {
      const normalized = customerNameInput.value.replace(/\s+/g, '');
      if (customerNameInput.value !== normalized) customerNameInput.value = normalized;
    });
  }

  // 登録済み案内 / 新規登録完了 → 予約に進む
  document.getElementById('proceed-to-booking-button').addEventListener('click', proceedToBookingStep2);
  document.getElementById('registration-complete-proceed-button').addEventListener('click', proceedToBookingStep2);

  // 予約確定ボタン
  document.getElementById('submitButton').addEventListener('click', () => {
    if (flowMode === 'manage-reschedule') {
      handleRescheduleSubmit();
    } else {
      handleBookingSubmit();
    }
  });

  document.getElementById('manage-reschedule-button').addEventListener('click', () => {
    if (!manageState.selectedBooking) return;
    flowMode = 'manage-reschedule';
    showSection('section-step4-datetime');
  });

  document.getElementById('manage-cancel-button').addEventListener('click', handleManageCancel);

  document.getElementById('manage-complete-close-button').addEventListener('click', () => {
    if (typeof liff !== 'undefined' && liff.isInClient()) {
      liff.closeWindow();
    } else {
      window.location.reload();
    }
  });

  document.getElementById('icsDownloadLink').addEventListener('click', handleIcsDownloadClick);

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
  if (button.disabled) return;

  const nextStepId = button.dataset.nextStep;
  const value = button.dataset.value;
  const currentSectionId = button.closest('.page-section').id;
  
  handleStepCompletion(currentSectionId, value, button);

  if (currentSectionId === 'section-step1-visit-experience') {
    showSection(resolveStep1Destination(value, nextStepId));
    return;
  }

  showSection(`section-${nextStepId}`);
}

/**
 * Step1 の選択に応じた遷移先を決定する。
 * 初めて + 未登録 → 顧客情報登録
 * 初めて + 登録済み → 登録済み案内
 * 2回目以降 + 登録済み → 予約種別選択
 */
function resolveStep1Destination(selectedValue, nextStepId) {
  if (selectedValue === 'first-time' && !isCustomerRegistered) {
    return 'section-customer-registration';
  }
  if (selectedValue === 'first-time') {
    return 'section-customer-already-registered';
  }
  return `section-${nextStepId || 'step2-booking-type'}`;
}

/** 予約種別選択（Step2）へ進む */
function proceedToBookingStep2() {
  showSection('section-step2-booking-type');
}

/** Step1 ボタンの遷移先・活性状態を登録状態に合わせて更新する */
function updateStep1ButtonTargets() {
  const firstTimeBtn = document.querySelector(
    '#section-step1-visit-experience .selection-button[data-value="first-time"]'
  );
  if (firstTimeBtn) {
    firstTimeBtn.dataset.nextStep = isCustomerRegistered
      ? 'customer-already-registered'
      : 'customer-registration';
  }

  const repeatBtn = document.querySelector(
    '#section-step1-visit-experience .selection-button[data-value="repeat"]'
  );
  if (repeatBtn) {
    repeatBtn.disabled = !isCustomerRegistered;
  }
}

function handleBackButtonClick(button) {
  const prevStepId = button.dataset.prevStep;
  if (prevStepId === 'step2-booking-type' || prevStepId === 'step3-menu') {
    flowMode = 'new-booking';
  }
  if (prevStepId === 'manage-booking-detail') {
    flowMode = 'manage-reschedule';
  }
  showSection(`section-${prevStepId}`);
}

function getMaxSelectableSlots() {
  return flowMode === 'manage-reschedule' ? 1 : (initData.maxBulkBookings || 1);
}

function clearSlotSelectionVisual_() {
  document.querySelectorAll('#timetable .slot.selected').forEach((s) => {
    s.classList.remove('selected');
  });
}

function handleSlotClick(slot) {
  if (slot.classList.contains('unavailable') ||
      slot.classList.contains('bulk-limit-reached') ||
      slot.classList.contains('slot-conflict')) return;

  const dateTime = slot.dataset.datetime;
  const maxBulk = getMaxSelectableSlots();

  if (slot.classList.contains('selected')) {
    // 選択解除
    slot.classList.remove('selected');
    bookingState.selectedSlots = bookingState.selectedSlots.filter(s => s !== dateTime);
  } else if (maxBulk === 1) {
    // 単一選択: 別週で選択済みでも新しい枠を選べるよう、既存選択を置き換える
    clearSlotSelectionVisual_();
    slot.classList.add('selected');
    bookingState.selectedSlots = [dateTime];
  } else if (bookingState.selectedSlots.length < maxBulk) {
    slot.classList.add('selected');
    bookingState.selectedSlots.push(dateTime);
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
  const maxBulk = getMaxSelectableSlots();

  if (flowMode === 'manage-reschedule') {
    if (count === 0) {
      submitButton.disabled = true;
      submitButton.textContent = '新しい日時を選択してください';
    } else {
      submitButton.disabled = false;
      submitButton.textContent = '変更を確定';
    }
    return;
  }

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
  const maxBulk = getMaxSelectableSlots();
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
 * 表示中の週に存在する枠のみ検証し、× になった枠だけ selectedSlots から除去する。
 * （別週で選択した枠は DOM に無いため selectedSlots に残す）
 */
function restoreSlotSelections() {
  if (bookingState.selectedSlots.length === 0) return;

  const removedDateTimes = [];
  document.querySelectorAll('#timetable .slot[data-datetime]').forEach((slot) => {
    const dateTime = slot.dataset.datetime;
    if (!bookingState.selectedSlots.includes(dateTime)) return;

    if (slot.classList.contains('unavailable')) {
      slot.classList.remove('selected');
      removedDateTimes.push(dateTime);
      return;
    }
    slot.classList.add('selected');
  });

  if (removedDateTimes.length > 0) {
    bookingState.selectedSlots = bookingState.selectedSlots.filter(
      (dt) => !removedDateTimes.includes(dt)
    );
    updateSubmitButton();
    updateBulkCounter();
  }
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
    case 'section-manage-bookings-list':
      loadManageBookingsList();
      break;
    case 'section-manage-booking-detail':
      renderManageBookingDetail();
      break;
    case 'section-manage-action-complete':
      break;
    case 'section-customer-registration':
      document.getElementById('customer-name').value = '';
      document.querySelectorAll('input[name="customer-gender"]').forEach(r => { r.checked = false; });
      document.getElementById('customer-age-group').value = '';
      break;
    case 'section-step3-menu':
      renderMenuList();
      break;
    case 'section-step4-datetime':
      bookingState.selectedSlots = [];
      if (flowMode === 'manage-reschedule' && manageState.selectedBooking) {
        prepareRescheduleDatetimeSection();
      } else {
        flowMode = 'new-booking';
        prepareNewBookingDatetimeSection();
      }
      break;
  }
}

function prepareNewBookingDatetimeSection() {
  document.getElementById('bulk-chip-container').style.display = '';
  document.getElementById('selected-menu-display').style.display = '';
  document.getElementById('selected-staff-display').style.display = 'none';
  document.getElementById('reschedule-target-display').style.display = 'none';
  const backBtn = document.querySelector('#section-step4-datetime .back-button');
  if (backBtn) backBtn.dataset.prevStep = 'step3-menu';

  if (bookingState.menu) {
    document.getElementById('current-selected-menu').textContent =
      `${bookingState.menu.name} (${bookingState.menu.duration}分)`;
  }
  renderStaffSelector();
  const infoEl = document.getElementById('lookahead-days-info');
  const infoParts = [];
  if (initData.bookingLookaheadDays) {
    infoParts.push(`※本日より${initData.bookingLookaheadDays}日後までのご予約が可能です。`);
  }
  if (initData.allowSameDayBooking === false) {
    infoParts.push('※当日予約は受け付けておりません。');
  }
  if (infoParts.length) {
    infoEl.textContent = infoParts.join('\n');
    infoEl.style.whiteSpace = 'pre-line';
    infoEl.style.display = '';
  } else {
    infoEl.textContent = '';
    infoEl.style.display = 'none';
  }
  updateSubmitButton();
  updateBulkCounter();
  if (canRenderTimetable()) {
    renderTimetable();
  }
}

function prepareRescheduleDatetimeSection() {
  const booking = manageState.selectedBooking;
  bookingState.menu = initData.serviceMenus.find((m) => m.name === booking.menuName)
    || { name: booking.menuName, duration: booking.duration || 60 };

  if (booking.staffEmail && booking.staffEmail !== 'any') {
    bookingState.staff = initData.staffs.find((s) => s.email === booking.staffEmail)
      || { name: booking.staffName || '担当者', email: booking.staffEmail };
  } else {
    bookingState.staff = { name: '指名なし', email: 'any' };
  }

  document.getElementById('staff-selector-container').style.display = 'none';
  document.getElementById('bulk-chip-container').style.display = 'none';
  document.getElementById('timetable-container').style.display = 'block';
  document.getElementById('selected-menu-display').style.display = 'none';
  document.getElementById('selected-staff-display').style.display = 'none';

  const targetDisplayEl = document.getElementById('reschedule-target-display');
  const targetBodyEl = document.getElementById('reschedule-target-body');
  targetBodyEl.innerHTML = formatBookingInfoHtml(booking);
  targetDisplayEl.style.display = 'block';

  const backBtn = document.querySelector('#section-step4-datetime .back-button');
  if (backBtn) backBtn.dataset.prevStep = 'manage-booking-detail';

  const infoEl = document.getElementById('lookahead-days-info');
  const infoParts = ['※新しい日時を1つ選択してください。'];
  if (initData.bookingLookaheadDays) {
    infoParts.push(`※本日より${initData.bookingLookaheadDays}日後まで変更可能です。`);
  }
  if (initData.allowSameDayBooking === false) {
    infoParts.push('※当日への変更は受け付けておりません。');
  }
  infoEl.textContent = infoParts.join('\n');
  infoEl.style.whiteSpace = 'pre-line';
  infoEl.style.display = '';

  updateSubmitButton();
  if (canRenderTimetable()) {
    renderTimetable();
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
    // プレースホルダーを先頭に配置し、初期状態では未選択にする
    selector.innerHTML = '<option value="" disabled selected>担当者を選択してください</option><option value="any">指名なし</option>';
    initData.staffs.forEach(staff => {
      const option = document.createElement('option');
      option.value = staff.email;
      option.textContent = staff.name;
      selector.appendChild(option);
    });
    container.style.display = 'block';
    // 初期状態は未選択（カレンダー非表示）
    bookingState.staff = null;
    document.getElementById('timetable-container').style.display = 'none';
  } else {
    container.style.display = 'none';
    bookingState.staff = null;
    // 担当者機能OFF の場合はカレンダーをそのまま表示
    document.getElementById('timetable-container').style.display = 'block';
  }
}

// ...（既存のrenderTimetable関数を完全に置き換え）...

async function renderTimetable() {
  if (!canRenderTimetable()) return;

  const renderGeneration = ++timetableRenderGeneration;
  const weekStartMs = currentWeekStartDate.getTime();
  const staffEmailAtRequest = bookingState.staff ? bookingState.staff.email : null;

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
  maxDate.setHours(0, 0, 0, 0);
  maxDate.setDate(maxDate.getDate() + (initData.bookingLookaheadDays || 90));
  document.getElementById('next-week-button').disabled = currentWeekStartDate.getTime() >= maxDate.getTime();

  const slotRequest = {
    date: `${currentWeekStartDate.getFullYear()}-${String(currentWeekStartDate.getMonth() + 1).padStart(2, '0')}-${String(currentWeekStartDate.getDate()).padStart(2, '0')}`,
    duration: bookingState.menu.duration,
    staffEmail: staffEmailAtRequest,
  };
  if (flowMode === 'manage-reschedule' && manageState.selectedBooking?.bookingId) {
    slotRequest.excludeBookingId = manageState.selectedBooking.bookingId;
  }
  const weeklyAvailableSlots = await fetchApi('getAvailableSlots', slotRequest);

  if (renderGeneration !== timetableRenderGeneration) return;
  if (currentWeekStartDate.getTime() !== weekStartMs) return;
  const staffEmailNow = bookingState.staff ? bookingState.staff.email : null;
  if (staffEmailNow !== staffEmailAtRequest) return;

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
  const businessHours = getBusinessHours_();
  const startMinutes = parseTimeToMinutes_(businessHours.start);
  const endMinutes = parseTimeToMinutes_(businessHours.end);

  for (let slotMinutes = startMinutes; slotMinutes < endMinutes; slotMinutes += timeUnit) {
    const timeStr = minutesToTimeStr_(slotMinutes);
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
      `<span>選択済み: <strong>${count}</strong> / ${maxBulk} 件　<small style="font-weight:normal;color:#5d9ec4;">（タップで確認）</small></span>`
      + `<span class="bulk-counter-arrow">${isOpen ? '▲' : '▼'}</span>`;
    counterEl.style.cursor = 'pointer';
    counterEl.setAttribute('aria-expanded', isOpen);
  } else {
    counterEl.innerHTML = `<span style="font-weight:normal;color:#5d9ec4;">カレンダーから日時を選んでください（最大${maxBulk}件）</span>`;
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
  document.getElementById('liff-header').style.display = 'block';
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
  if (!liff.isLoggedIn()) {
    throw new Error('LINEログインが必要です。もう一度お試しください。');
  }
  const idToken = liff.getIDToken();
  if (!idToken) {
    throw new Error('LINE認証トークンを取得できませんでした。LINEアプリから開き直してください。');
  }

  const response = await fetch(GAS_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'text/plain;charset=utf-8',
    },
    body: JSON.stringify({
      action,
      idToken,
      lineUserId: userProfile ? userProfile.userId : undefined,
      ...payload,
    }),
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
  const ageGroupInput = document.getElementById('customer-age-group');
  const genderInput = document.querySelector('input[name="customer-gender"]:checked');
  const registerButton = document.getElementById('register-customer-button');

  const customerName = nameInput.value.trim().replace(/\s+/g, '');
  if (!customerName) {
    alert('氏名を入力してください。（空白は使用できません）');
    nameInput.focus();
    return;
  }
  if (!genderInput) {
    alert('性別を選択してください。');
    return;
  }
  if (!ageGroupInput.value) {
    alert('年代を選択してください。');
    ageGroupInput.focus();
    return;
  }

  registerButton.disabled = true;
  registerButton.textContent = '登録中...';

  try {
    await fetchApi('registerCustomer', {
      lineUserId: userProfile.userId,
      customerName: customerName,
      gender: genderInput.value,
      ageGroup: ageGroupInput.value,
    });

    isCustomerRegistered = true;
    updateStep1ButtonTargets();
    // 新規登録直後は「登録済み案内」を挟まず Step2 へ（テスト仕様 ST-P1-01 準拠）
    proceedToBookingStep2();

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

    const bookingUserName = (initData.customerName || userProfile.displayName || '').replace(/\s+/g, '') || userProfile.displayName;
    const baseData = {
      lineUserId: userProfile.userId,
      userName: bookingUserName,
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
  } else {
    document.getElementById('completeStaffP').style.display = 'none';
  }

  const icsContent = generateICS(sortedResults, shopName);
  sessionStorage.setItem(ICS_SESSION_KEY, icsContent);

  const icsLink = document.getElementById('icsDownloadLink');
  const inClient = typeof liff !== 'undefined' && liff.isInClient();
  const icsFilename = `reservation_${firstResult.bookingId}.ics`;
  if (icsLink) {
    icsLink.dataset.icsStorageKey = ICS_SESSION_KEY;
    icsLink.dataset.icsFilename = icsFilename;
    icsLink.href = '#';
    icsLink.removeAttribute('target');
  }

  const helpEl = document.getElementById('icsHelpText');
  if (helpEl) {
    if (!inClient) {
      helpEl.textContent =
        'ボタンを押すと予約ファイル（.ics）を保存できます。保存後、ファイルをタップして「カレンダーに追加」を選んでください。（共有メニューにカレンダーは表示されないことがあります）';
      helpEl.style.display = 'block';
    } else {
      helpEl.style.display = 'none';
    }
  }

  document.getElementById('bookingComplete').style.display = 'block';
}

function base64EncodeUtf8(str) {
  const bytes = new TextEncoder().encode(str);
  let binary = '';
  bytes.forEach((b) => { binary += String.fromCharCode(b); });
  return btoa(binary);
}

function buildIcsServeUrl(icsContent) {
  const url = new URL(ICS_SERVE_BASE);
  url.searchParams.set('d', base64EncodeUtf8(icsContent));
  return url.toString();
}

function downloadIcsBlob(content, filename) {
  const blob = new Blob([content], { type: 'text/calendar;charset=utf-8' });
  const blobUrl = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = blobUrl;
  anchor.download = filename || 'reservation.ics';
  anchor.style.display = 'none';
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  setTimeout(() => URL.revokeObjectURL(blobUrl), 2000);
}

function handleIcsDownloadClick(e) {
  const link = e.currentTarget;
  const storageKey = link.dataset.icsStorageKey || ICS_SESSION_KEY;
  const filename = link.dataset.icsFilename || 'reservation.ics';
  const icsContent = sessionStorage.getItem(storageKey);
  const inClient = typeof liff !== 'undefined' && liff.isInClient();

  e.preventDefault();
  if (!icsContent) return;

  if (!inClient) {
    downloadIcsBlob(icsContent, filename);
    return;
  }

  if (typeof liff !== 'undefined' && typeof liff.openWindow === 'function') {
    liff.openWindow({ url: buildIcsServeUrl(icsContent), external: true });
  }
}

/**
 * ICS（iCalendar）形式の文字列を生成する（予約APIレスポンスから即時生成）
 */
function generateICS(results, shopName) {
  const formatICSDate = (isoStr) =>
    new Date(isoStr).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const now = formatICSDate(new Date().toISOString());

  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//ReservationSystem//JP',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
  ];

  results.forEach(result => {
    lines.push(
      'BEGIN:VEVENT',
      `UID:${result.bookingId}@reservation-system`,
      `DTSTAMP:${now}`,
      `DTSTART:${formatICSDate(result.startTime)}`,
      `DTEND:${formatICSDate(result.endTime)}`,
      `SUMMARY:${result.eventTitle}`,
      `DESCRIPTION:店舗: ${shopName}\\nご予約ありがとうございます。`,
      'BEGIN:VALARM',
      'TRIGGER:-PT1H',
      'ACTION:DISPLAY',
      'DESCRIPTION:ご予約の1時間前です',
      'END:VALARM',
      'END:VEVENT'
    );
  });

  lines.push('END:VCALENDAR');
  return lines.join('\r\n');
}

// =================================================================
// 予約確認・変更
// =================================================================

function formatBookingDateTime(isoStr) {
  const d = new Date(isoStr);
  const days = ['日', '月', '火', '水', '木', '金', '土'];
  const datePart = `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日(${days[d.getDay()]})`;
  const timePart = d.toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' });
  return `${datePart} ${timePart}`;
}

function getStaffDisplayText(booking) {
  const staffName = booking && booking.staffName ? String(booking.staffName).trim() : '';
  if (staffName && staffName !== '指名なし') {
    return staffName;
  }
  return initData.isStaffFeatureEnabled ? '指名なし' : '';
}

/**
 * 予約情報（日時・メニュー・担当者）を HTML で返す
 */
function formatBookingInfoHtml(booking, options = {}) {
  const {
    datetimeLabel = '日時',
    datetimeIso = booking.startTime,
    introText = '',
  } = options;

  let html = introText ? `<p>${introText}</p>` : '';
  html += `<p><strong>${datetimeLabel}:</strong> ${formatBookingDateTime(datetimeIso)}</p>`;
  html += `<p><strong>メニュー:</strong> ${booking.menuName}</p>`;
  if (initData.isStaffFeatureEnabled) {
    html += `<p><strong>担当者:</strong> ${getStaffDisplayText(booking) || '指名なし'}</p>`;
  }
  return html;
}

function formatBookingInfoText(booking, options = {}) {
  const lines = [
    formatBookingDateTime(options.datetimeIso || booking.startTime),
    booking.menuName,
  ];
  const staffText = getStaffDisplayText(booking);
  if (initData.isStaffFeatureEnabled) {
    lines.push(`担当: ${staffText || '指名なし'}`);
  }
  return lines.join('\n');
}

async function loadManageBookingsList() {
  const loadingEl = document.getElementById('manage-bookings-loading');
  const emptyEl = document.getElementById('manage-bookings-empty');
  const container = document.getElementById('manage-bookings-list-container');

  loadingEl.style.display = 'block';
  emptyEl.style.display = 'none';
  container.innerHTML = '';
  flowMode = 'new-booking';
  manageState.selectedBooking = null;

  try {
    const data = await fetchApi('getMyBookings', { lineUserId: userProfile.userId });
    manageState.bookings = data.bookings || [];
    manageState.reminderMode = data.reminderMode || initData.reminderMode || 'ICS';
    loadingEl.style.display = 'none';

    if (manageState.bookings.length === 0) {
      emptyEl.style.display = 'block';
      return;
    }

    manageState.bookings.forEach((booking) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'selection-button manage-booking-item';
      button.dataset.bookingId = booking.bookingId;
      const staffText = getStaffDisplayText(booking);
      const staffHtml = staffText
        ? `<span class="manage-booking-staff">担当: ${staffText}</span>`
        : '';
      button.innerHTML = `
        <span class="manage-booking-datetime">${formatBookingDateTime(booking.startTime)}</span>
        <span class="manage-booking-menu">${booking.menuName}</span>
        ${staffHtml}
      `;
      button.addEventListener('click', () => {
        manageState.selectedBooking = booking;
        showSection('section-manage-booking-detail');
      });
      container.appendChild(button);
    });
  } catch (error) {
    loadingEl.style.display = 'none';
    console.error('予約一覧の取得に失敗しました:', error);
    alert(`予約一覧の取得に失敗しました: ${error.message}`);
  }
}

function renderManageBookingDetail() {
  const booking = manageState.selectedBooking;
  const bodyEl = document.getElementById('manage-booking-detail-body');
  if (!booking || !bodyEl) return;
  bodyEl.innerHTML = formatBookingInfoHtml(booking);
}

async function handleManageCancel() {
  const booking = manageState.selectedBooking;
  if (!booking) return;

  const confirmed = window.confirm(
    `以下の予約をキャンセルします。よろしいですか？\n\n${formatBookingInfoText(booking)}`
  );
  if (!confirmed) return;

  const cancelButton = document.getElementById('manage-cancel-button');
  const rescheduleButton = document.getElementById('manage-reschedule-button');
  cancelButton.disabled = true;
  rescheduleButton.disabled = true;
  cancelButton.textContent = '処理中...';

  try {
    const result = await fetchApi('cancelBookingByUser', {
      lineUserId: userProfile.userId,
      bookingId: booking.bookingId,
    });
    showManageActionComplete('cancel', result, booking);
  } catch (error) {
    console.error('キャンセルに失敗しました:', error);
    alert(`キャンセルに失敗しました: ${error.message}`);
  } finally {
    cancelButton.disabled = false;
    rescheduleButton.disabled = false;
    cancelButton.textContent = '予約をキャンセル';
  }
}

async function handleRescheduleSubmit() {
  const booking = manageState.selectedBooking;
  const newSlot = bookingState.selectedSlots[0];
  if (!booking || !newSlot) return;

  const confirmed = window.confirm(
    `予約日時を以下に変更します。よろしいですか？\n\n${formatBookingInfoText(booking, { datetimeIso: newSlot })}`
  );
  if (!confirmed) return;

  const submitButton = document.getElementById('submitButton');
  submitButton.disabled = true;
  submitButton.textContent = '変更処理中...';

  try {
    const result = await fetchApi('rescheduleBookingByUser', {
      lineUserId: userProfile.userId,
      bookingId: booking.bookingId,
      newStartDateTime: newSlot,
    });
    showManageActionComplete('reschedule', result, booking);
  } catch (error) {
    console.error('予約変更に失敗しました:', error);
    alert(`予約変更に失敗しました: ${error.message}`);
    submitButton.textContent = '空き枠を更新中...';
    try {
      await renderTimetable();
    } finally {
      updateSubmitButton();
    }
  }
}

function showManageActionComplete(actionType, result, previousBooking) {
  flowMode = 'new-booking';
  manageState.selectedBooking = null;

  const titleEl = document.getElementById('manage-complete-title');
  const bodyEl = document.getElementById('manage-complete-body');
  const icsEl = document.getElementById('manage-ics-reminder');
  const reminderMode = result.reminderMode || manageState.reminderMode || 'ICS';

  if (actionType === 'cancel') {
    titleEl.textContent = '予約をキャンセルしました';
    bodyEl.innerHTML = formatBookingInfoHtml(previousBooking, {
      introText: '以下のご予約をキャンセルしました。',
    });
  } else {
    titleEl.textContent = '予約日時を変更しました';
    bodyEl.innerHTML = formatBookingInfoHtml(
      { ...previousBooking, menuName: result.menuName || previousBooking.menuName },
      {
        introText: 'ご予約日時を変更しました。',
        datetimeLabel: '変更後',
        datetimeIso: result.startTime,
      }
    );
  }

  if (reminderMode === 'ICS') {
    icsEl.textContent =
      'カレンダーに追加済みの予定がある場合は、端末のカレンダーアプリから手動で削除または修正してください。';
    icsEl.style.display = 'block';
  } else {
    icsEl.style.display = 'none';
  }

  showSection('section-manage-action-complete');
}
