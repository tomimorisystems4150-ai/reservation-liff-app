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
    setupNavigation(); // イベントリスナーの役割を変更
    showSection('section-step1-visit-experience'); // 最初のセクションを表示
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
  // この段階ではGASからデータを取得せず、UIの骨格のみを準備
  const response = await fetchApi('getInitData');
  document.getElementById('shopName').textContent = response.shopName || '予約システム';
}

// =================================================================
// 画面遷移（ナビゲーション）
// =================================================================

/**
 * 全てのナビゲーションボタンにイベントリスナーを設定する
 */
function setupNavigation() {
  document.querySelectorAll('[data-next-step]').forEach(button => {
    button.addEventListener('click', (e) => {
      const nextStepId = e.currentTarget.dataset.nextStep;
      if (nextStepId === 'unimplemented') {
        alert('この機能は現在準備中です。');
        return;
      }
      showSection(`section-${nextStepId}`);
    });
  });

  document.querySelectorAll('[data-prev-step]').forEach(button => {
    button.addEventListener('click', (e) => {
      const prevStepId = e.currentTarget.dataset.prevStep;
      showSection(`section-${prevStepId}`);
    });
  });
}

/**
 * 指定されたIDのセクションを表示し、他をすべて非表示にする
 * @param {string} sectionId 表示するセクションのID
 */
function showSection(sectionId) {
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

// (予約確定処理や完了画面表示の関数は、後のステップで再実装します)