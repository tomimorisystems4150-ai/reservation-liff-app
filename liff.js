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

// 予約フロー全体でユーザーの選択を保持するオブジェクト
const bookingState = {
  visitExperience: null,
  bookingType: null,
  menu: null,
  staff: null,
  dateTime: null,
};

// LIFF初期化時にGASから取得するデータ
let initData = {};

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
  initData = await fetchApi('getInitData');
  document.getElementById('shopName').textContent = initData.shopName || '予約システム';
}

// =================================================================
// 画面遷移（ナビゲーション）
// =================================================================

/**
 * 全てのナビゲーションボタンにイベントリスナーを設定する
 */
function setupNavigation() {
  document.querySelectorAll('.selection-button[data-next-step]').forEach(button => {
    button.addEventListener('click', (e) => {
      const nextStepId = e.currentTarget.dataset.nextStep;
      const value = e.currentTarget.dataset.value;
      
      // 現在のステップに応じて状態を保存
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
}

/**
 * 各ステップ完了時の処理をハンドリングする
 */
function handleStepCompletion(completedSectionId, selectedValue, targetElement) {
  switch (completedSectionId) {
    case 'section-step1-visit-experience':
      bookingState.visitExperience = selectedValue;
      if (selectedValue === 'first-time') {
        // TODO: 本来はここで顧客情報登録フォームに遷移する
        console.log("「初めてのご予約」が選択されました。顧客登録フローを実装予定。");
      }
      break;
    case 'section-step3-menu':
      const menu = initData.serviceMenus.find(m => m.name === targetElement.dataset.value);
      bookingState.menu = menu;
      break;
    case 'section-step4-staff':
      const staff = initData.staffs.find(s => s.email === targetElement.dataset.value);
      bookingState.staff = staff;
      break;
  }
}

/**
 * 指定されたIDのセクションを表示し、他をすべて非表示にする
 */
function showSection(sectionId) {
  // 遷移前に、次の画面に必要なデータを準備する
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

/**
 * セクション表示前の準備処理
 */
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
      break;
  }
}

// =================================================================
// UI動的生成
// =================================================================

function renderMenuList() {
  const container = document.getElementById('menu-list-container');
  container.innerHTML = ''; // コンテナをクリア
  initData.serviceMenus.forEach(menu => {
    const button = document.createElement('button');
    button.className = 'selection-button';
    button.textContent = `${menu.name} (${menu.duration}分)`;
    button.dataset.nextStep = initData.isStaffFeatureEnabled ? 'step4-staff' : 'step5-datetime';
    button.dataset.value = menu.name;
    container.appendChild(button);
  });
  // 動的に生成したボタンに再度イベントリスナーを設定
  setupNavigation();
}

function renderStaffList() {
  const container = document.getElementById('staff-list-container');
  container.innerHTML = ''; // コンテナをクリア
  
  // 「指名なし」ボタンを追加
  const noPreferenceButton = document.createElement('button');
  noPreferenceButton.className = 'selection-button';
  noPreferenceButton.textContent = '指名なし';
  noPreferenceButton.dataset.nextStep = 'step5-datetime';
  noPreferenceButton.dataset.value = 'any'; // 指名なしを示す値
  container.appendChild(noPreferenceButton);

  initData.staffs.forEach(staff => {
    const button = document.createElement('button');
    button.className = 'selection-button';
    button.textContent = staff.name;
    button.dataset.nextStep = 'step5-datetime';
    button.dataset.value = staff.email;
    container.appendChild(button);
  });
  // 動的に生成したボタンに再度イベントリスナーを設定
  setupNavigation();
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