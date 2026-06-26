/**
 * LINE予約システム 自動オンボーディングサーバー
 * Cloudflare Workers で動作する OAuth 2.0 フローと GAS プロビジョニングを処理する。
 *
 * ルート:
 *   GET /          - ランディングページ（導入開始ボタン）
 *   GET /start     - Google OAuth 認可フロー開始
 *   GET /callback   - OAuth コールバック・プロビジョニング実行
 *   GET /continue-setup - STEP 0 完了後にプロビジョニング再開
 *   GET /complete  - 完了ページ（URLと次の手順を表示）
 *   GET /admin/login     - 管理ログイン（POST でパスワード → Cookie）
 *   GET /admin/logout    - ログアウト
 *   GET /admin           - デプロイ支援コンソール（Web GUI）
 *   POST /admin/api/push-update  - コード配信 API
 *   POST /admin/api/set-status   - 停止/再開 API
 *   GET /admin/init-registry   - 顧客台帳シート初期化
 *   GET /admin/set-status      - サービス停止/再開（ssId指定）
 *   GET /admin/push-update     - コード配信（ssId / ssIds 指定可）
 *   POST /admin/api/error-logs/ack - エラーログ既読 API
 *   POST /api/report-error     - GAS からのシステムエラー報告（HMAC）
 *   GET /docs/initial-setup-manual - 初期導入マニュアル（仮）
 */

import {
  REGISTRY_SHEET,
  REGISTRY_HEADERS,
  initCustomerRegistrySheet,
  upsertRegistryCustomer,
} from './customer-registry.js';
import {
  fetchAdminCustomers,
  isSpreadsheetAvailable,
  executePushUpdate,
  executeSetStatus,
  handleAdminApiPush,
  handleAdminApiSetStatus,
  renderAdminConsole,
  resolveTestEnvContext,
} from './admin-console.js';
import {
  handleAdminLogin,
  handleAdminLogout,
  adminAuthOrRedirect,
  adminAuthOrJsonError,
} from './admin-auth.js';
import {
  handleReportError,
  handleAdminApiErrorLogs,
  handleAdminApiErrorLogsAck,
  loadErrorLogState,
} from './error-log.js';

const GOOGLE_AUTH_URL  = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const DRIVE_API        = 'https://www.googleapis.com/drive/v3';
const SHEETS_API       = 'https://sheets.googleapis.com/v4/spreadsheets';
const SCRIPT_API       = 'https://script.googleapis.com/v1';
const APPS_SCRIPT_USER_SETTINGS_URL = 'https://script.google.com/home/usersettings';
const OPERATIONS_MANUAL_PATH = '/docs/initial-setup-manual';

/** 環境変数未設定時は Worker 上の仮マニュアルページを返す */
function getOperationsManualUrl(env) {
  const configured = (env.OPERATIONS_MANUAL_URL || '').trim();
  if (configured) return configured;
  const base = (env.WORKER_URL || '').replace(/\/$/, '');
  return base ? `${base}${OPERATIONS_MANUAL_PATH}` : '';
}

// GAS デプロイに必要な OAuth スコープ
// Drive操作はサービスアカウントが行うため、ユーザーにはDriveスコープを要求しない
const OAUTH_SCOPES = [
  'https://www.googleapis.com/auth/spreadsheets',
  'https://www.googleapis.com/auth/script.projects',
  'https://www.googleapis.com/auth/script.deployments',
  'https://www.googleapis.com/auth/script.scriptapp',
  'email',
  'profile',
].join(' ');

// GitHub から取得するスクリプトファイル定義
const SCRIPT_FILES_META = [
  { name: 'Code',           type: 'SERVER_JS', file: 'Code.js' },
  { name: 'calendar-addon', type: 'SERVER_JS', file: 'calendar-addon.js' },
  { name: 'settings',       type: 'HTML',      file: 'settings.html' },
  { name: 'kanri',          type: 'HTML',      file: 'kanri.html' },
  { name: 'unauthorized',   type: 'HTML',      file: 'unauthorized.html' },
  { name: 'appsscript',     type: 'JSON',      file: 'appsscript.json' },
];

/** テスト店舗向け（コード配信「テストスイート含む」ON 時のみ同梱） */
const TEST_SCRIPT_FILE_META = { name: 'tests', type: 'SERVER_JS', file: 'tests.js' };

// ============================================================
// メインルーター
// ============================================================
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    try {
      switch (url.pathname) {
        case '/':                   return handleIndex(env);
        case '/start':              return handleStart(request, env);
        case '/callback':           return handleCallback(request, env);
        case '/continue-setup':     return handleContinueSetup(request, env);
        case '/complete':           return handleComplete(url, env);
        case '/admin/login':        return handleAdminLogin(request, env);
        case '/admin/logout':       return handleAdminLogout(request, env);
        case '/admin':              return handleAdmin(request, env);
        case '/admin/api/push-update': return handleAdminApiPushRoute(request, env);
        case '/admin/api/set-status':  return handleAdminApiSetStatusRoute(request, env);
        case '/admin/api/error-logs':  return handleAdminApiErrorLogsRoute(request, env);
        case '/admin/api/error-logs/ack': return handleAdminApiErrorLogsAckRoute(request, env);
        case '/api/report-error':      return handleReportError(request, env);
        case '/admin/init-registry': return handleInitRegistry(request, env);
        case '/admin/sync-registry': return handleSyncRegistry(request, env);
        case '/admin/set-status':   return handleSetStatus(request, env);
        case '/admin/push-update':  return handlePushUpdate(request, env);
        case '/admin/kv-cleanup':   return handleKvCleanup(request, env);
        case '/privacy':            return handlePrivacy();
        case '/docs/initial-setup-manual': return handleInitialSetupManual();
        case '/ics':                return handleIcsServe(url);
        default:           return new Response('Not Found', { status: 404 });
      }
    } catch (err) {
      console.error('Unhandled error:', err);
      if (isAppsScriptApiDisabledMessage(err.message)) {
        return renderProvisionError(err);
      }
      return renderError(`予期しないエラーが発生しました。<br><code>${escapeHtml(err.message)}</code>`);
    }
  },
};

// ============================================================
// デプロイ支援コンソール（Web GUI）
// 認証: Cloudflare Access（Gmail）+ HttpOnly セッション Cookie
// ============================================================
function pushUpdateDeps(env) {
  return {
    getSaToken: getServiceAccountToken,
    fetchRawFiles,
    pushCodeToCustomer,
    syncServiceSuspendedToCustomer,
    kvGet: (key) => env.ONBOARDING_KV.get(key),
    kvPut: (key, val, opts) => env.ONBOARDING_KV.put(key, val, opts),
    kvList: () => env.ONBOARDING_KV.list({ prefix: 'store:' }),
  };
}

async function handleAdmin(request, env) {
  const gate = await adminAuthOrRedirect(request, env);
  if (gate.response) return gate.response;

  const kvList = await env.ONBOARDING_KV.list({ prefix: 'store:' });
  const kvMap = {};
  for (const k of kvList.keys) {
    const raw = await env.ONBOARDING_KV.get(k.name);
    if (raw) kvMap[k.name.replace(/^store:/, '')] = JSON.parse(raw);
  }

  const adminData = await fetchAdminCustomers(env, kvMap, getServiceAccountToken);
  const testEnv = await resolveTestEnvContext(env, adminData.customers, kvMap, getServiceAccountToken);
  const errorLogState = await loadErrorLogState(env.ONBOARDING_KV);
  return new Response(renderAdminConsole(env, gate.auth, { ...adminData, testEnv, errorLogState }), {
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

async function handleAdminApiPushRoute(request, env) {
  const gate = await adminAuthOrJsonError(request, env);
  if (gate.response) return gate.response;
  return handleAdminApiPush(request, env, pushUpdateDeps(env));
}

async function handleAdminApiSetStatusRoute(request, env) {
  const gate = await adminAuthOrJsonError(request, env);
  if (gate.response) return gate.response;
  return handleAdminApiSetStatus(request, env, pushUpdateDeps(env));
}

async function handleAdminApiErrorLogsRoute(request, env) {
  const gate = await adminAuthOrJsonError(request, env);
  if (gate.response) return gate.response;
  return handleAdminApiErrorLogs(request, env);
}

async function handleAdminApiErrorLogsAckRoute(request, env) {
  const gate = await adminAuthOrJsonError(request, env);
  if (gate.response) return gate.response;
  return handleAdminApiErrorLogsAck(request, env);
}

// ============================================================
// Apps Script API（ユーザー設定）— 自動 ON 不可のため UX で案内
// ============================================================
function isAppsScriptApiDisabledMessage(message) {
  const msg = String(message || '');
  return msg.includes('has not enabled the Apps Script API');
}

function buildAppsScriptApiHelpHtml() {
  return `
    <p style="text-align:left;">自動セットアップの前に、<strong>導入に使う Google アカウント</strong>で次の設定が必要です（初回のみ・約1分）。</p>
    <ol class="help-steps">
      <li>下のボタンから Google の設定ページを開く</li>
      <li><strong>「Google Apps Script API」</strong> のスイッチを<strong>オン</strong>にする</li>
      <li>このページに戻り、導入を続ける</li>
    </ol>
    <p style="text-align:center;margin:20px 0;">
      <a href="${APPS_SCRIPT_USER_SETTINGS_URL}" target="_blank" rel="noopener noreferrer" class="btn-outline-link">
        Google Apps Script API の設定を開く
      </a>
    </p>
    <p class="help-note">※ 設定をオンにした直後は、反映まで数分かかることがあります。</p>
  `;
}

/** ユーザーの Apps Script API（usersettings）が ON か軽量プローブで確認 */
async function checkAppsScriptApiEnabled(userAuth) {
  const probe = await callApi(
    `${SCRIPT_API}/projects`,
    'POST',
    userAuth,
    { title: '__onboarding_api_probe__' }
  );
  if (probe.error) {
    if (isAppsScriptApiDisabledMessage(probe.error.message)) return false;
    console.warn('Apps Script API probe (non-disable):', probe.error.message);
    return true;
  }
  if (probe.scriptId) {
    try {
      await callApi(`${SCRIPT_API}/projects/${probe.scriptId}`, 'DELETE', userAuth, null);
    } catch (e) {
      console.warn('Probe project cleanup skipped:', e.message);
    }
  }
  return true;
}

async function saveResumeSession(env, session) {
  const resumeId = crypto.randomUUID();
  await env.ONBOARDING_KV.put(
    `resume:${resumeId}`,
    JSON.stringify(session),
    { expirationTtl: 1800 }
  );
  return resumeId;
}

function renderAppsScriptApiSetupPage(resumeId, env, { stillDisabled = false } = {}) {
  const continueUrl = `${env.WORKER_URL}/continue-setup?id=${encodeURIComponent(resumeId)}`;
  const warn = stillDisabled
    ? `<p class="step-zero-warn">まだ設定が反映されていない可能性があります。オンにしてから数分待ってから「続行」を押してください。</p>`
    : '';
  const html = buildPage('あと1ステップでセットアップできます', `
    <div class="page-preflight">
    <div class="preflight-banner">
      <h1 class="preflight-title">Google の設定が1つ必要です</h1>
      <p class="preflight-lead">Google ログインは完了しました。自動構築を続ける前に、下記の設定をお願いします。</p>
    </div>
    ${buildAppsScriptApiHelpHtml()}
    ${warn}
    <div class="cta-area" style="margin-top:28px;">
      <a href="${escapeHtml(continueUrl)}" class="btn-start">設定したので続行する</a>
      <p class="note"><a href="/" style="color:#888;">最初からやり直す</a></p>
    </div>
    </div>
  `);
  return htmlResponse(html);
}

function isJsonParseOrHtmlError(message) {
  const msg = String(message || '');
  return msg.includes('is not valid JSON')
    || msg.includes('HTML エラーページ')
    || msg.includes('応答の解析に失敗');
}

function renderProvisionError(err) {
  const message = err?.message || String(err);
  if (isAppsScriptApiDisabledMessage(message)) {
    const html = buildPage('設定が必要です', `
      <div class="error-box" style="text-align:left;">
        <h2 style="text-align:center;">⚠️ セットアップを続けるには設定が必要です</h2>
        ${buildAppsScriptApiHelpHtml()}
        <p style="text-align:center;margin-top:20px;">
          <a href="/" class="btn-start" style="display:inline-flex;">設定後、最初からやり直す</a>
        </p>
      </div>
    `);
    return htmlResponse(html, 500);
  }
  if (isJsonParseOrHtmlError(message)) {
    return renderError(
      `セットアップ中に通信エラーが発生しました。<br><br>` +
      `Google API が正しく応答しませんでした。次を確認してください：<br>` +
      `・OAuth クライアントの GCP プロジェクトで <strong>Apps Script API</strong> / <strong>Google Sheets API</strong> が有効<br>` +
      `・<strong>Apps Script API をオンにした Googleアカウント</strong>でセットアップしている<br>` +
      `・数分待ってから <a href="/">最初から</a> 再試行<br><br>` +
      `<details style="text-align:left;font-size:12px;color:#888;"><summary>技術詳細</summary>` +
      `<code>${escapeHtml(message)}</code></details>`
    );
  }
  return renderError(
    `セットアップ中にエラーが発生しました。<br><code>${escapeHtml(message)}</code><br><br>
      もう一度 <a href="/">最初から</a> お試しください。`
  );
}

// ============================================================
// ランディングページ
// ============================================================
function handleIndex(env) {
  const html = buildPage('LINE予約システム 導入ガイド', `
    <div class="page-landing">
    <div class="hero">
      <h1>LINE予約システム</h1>
    </div>

    <div class="steps">
      <div class="step">
        <div class="step-num">1</div>
        <div class="step-body">
          <strong>Google Apps Script APIをオンにする</strong>
        </div>
      </div>
      <div class="step">
        <div class="step-num">2</div>
        <div class="step-body">
          <strong>Googleアカウントでログイン</strong>
        </div>
      </div>
      <div class="step">
        <div class="step-num">3</div>
        <div class="step-body">
          <div class="step-title"><strong>自動セットアップ</strong><span class="step-note">※約3分</span></div>
        </div>
      </div>
      <div class="step">
        <div class="step-num">4</div>
        <div class="step-body">
          <strong>予約システム設定画面で初期設定・保存</strong>
        </div>
      </div>
    </div>

    <div class="setup-notice">
      <p><strong>セットアップ時の注意：</strong>Google Apps Script API をオンにした<strong>Googleアカウント</strong>でセットアップしてください。</p>
    </div>

    <div class="cta-area">
      <a href="${APPS_SCRIPT_USER_SETTINGS_URL}" target="_blank" rel="noopener noreferrer" class="btn-pill btn-settings">
        Google Apps Script API をオンにする
      </a>
      <a href="/start" class="btn-pill btn-start btn-start-gated" id="btnStart" tabindex="-1" aria-disabled="true">
        セットアップ開始
      </a>
      <label class="step-zero-check cta-check">
        <input type="checkbox" id="step0Check">
        <span>Google Apps Script API をオンにしました</span>
      </label>
    </div>
    </div>
    <script>
      (function() {
        const chk = document.getElementById('step0Check');
        const btn = document.getElementById('btnStart');
        function sync() {
          const ok = chk.checked;
          btn.classList.toggle('btn-start-ready', ok);
          btn.setAttribute('aria-disabled', ok ? 'false' : 'true');
          btn.tabIndex = ok ? 0 : -1;
        }
        chk.addEventListener('change', sync);
        btn.addEventListener('click', function(e) {
          if (!chk.checked) {
            e.preventDefault();
            alert('Google Apps Script API をオンにし、チェックを入れてから開始してください。');
          }
        });
        sync();
      })();
    </script>
  `);
  return htmlResponse(html);
}

// ============================================================
// OAuth 開始 — state を KV に保存してリダイレクト
// ============================================================
async function handleStart(request, env) {
  const state = crypto.randomUUID();
  // 10分間有効
  await env.ONBOARDING_KV.put(`state:${state}`, '1', { expirationTtl: 600 });

  const params = new URLSearchParams({
    client_id:     env.GOOGLE_CLIENT_ID,
    redirect_uri:  `${env.WORKER_URL}/callback`,
    response_type: 'code',
    scope:         OAUTH_SCOPES,
    access_type:   'offline',
    prompt:        'consent',
    state,
  });
  return Response.redirect(`${GOOGLE_AUTH_URL}?${params}`, 302);
}

// ============================================================
// OAuth コールバック → プロビジョニング
// ============================================================
async function handleCallback(request, env) {
  const url    = new URL(request.url);
  const code   = url.searchParams.get('code');
  const state  = url.searchParams.get('state');
  const error  = url.searchParams.get('error');

  if (error) {
    return renderError(`Google認証でエラーが発生しました: <strong>${escapeHtml(error)}</strong>`);
  }
  if (!code || !state) {
    return renderError('必要なパラメーターが不足しています。もう一度最初からお試しください。');
  }

  // state 検証
  const stored = await env.ONBOARDING_KV.get(`state:${state}`);
  if (!stored) {
    return renderError('セッションが無効または期限切れです。もう一度最初からお試しください。');
  }
  await env.ONBOARDING_KV.delete(`state:${state}`);

  let result;
  try {
    const tokens = await exchangeCodeForTokens(code, env);
    if (!tokens.access_token) {
      throw new Error(`トークン取得失敗: ${JSON.stringify(tokens.error || tokens)}`);
    }
    const userEmail = getEmailFromIdToken(tokens.id_token) || await getUserEmail(tokens.access_token);
    console.log('onboarding userEmail:', userEmail);

    const userAuth = `Bearer ${tokens.access_token}`;
    const apiReady = await checkAppsScriptApiEnabled(userAuth);
    if (!apiReady) {
      console.log('Apps Script API not enabled for user; showing setup page');
      const resumeId = await saveResumeSession(env, {
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token || null,
        userEmail: userEmail || '',
      });
      return renderAppsScriptApiSetupPage(resumeId, env);
    }

    result = await provision(tokens.access_token, tokens.refresh_token, env, userEmail);
  } catch (err) {
    console.error('Provision error:', err);
    return renderProvisionError(err);
  }

  const params = new URLSearchParams({
    deployUrl: result.deployUrl,
    ssUrl:     result.ssUrl,
    gasUrl:    result.gasUrl,
    triggersSetup: result.triggersSetup ? '1' : '0',
  });
  return Response.redirect(`${env.WORKER_URL}/complete?${params}`, 302);
}

// ============================================================
// STEP 0 完了後 — 保存済み OAuth でプロビジョニング再開
// ============================================================
async function handleContinueSetup(request, env) {
  const url = new URL(request.url);
  const resumeId = url.searchParams.get('id');
  if (!resumeId) {
    return renderError('無効なリンクです。<a href="/">最初から</a> お試しください。');
  }

  const raw = await env.ONBOARDING_KV.get(`resume:${resumeId}`);
  if (!raw) {
    return renderError(
      'セットアップの再開期限（30分）が切れました。<br><br><a href="/">最初から</a> お試しください。'
    );
  }

  let session;
  try {
    session = JSON.parse(raw);
  } catch {
    return renderError('セッション情報が不正です。<a href="/">最初から</a> お試しください。');
  }

  const userAuth = `Bearer ${session.accessToken}`;
  const apiReady = await checkAppsScriptApiEnabled(userAuth);
  if (!apiReady) {
    return renderAppsScriptApiSetupPage(resumeId, env, { stillDisabled: true });
  }

  await env.ONBOARDING_KV.delete(`resume:${resumeId}`);

  let result;
  try {
    result = await provision(
      session.accessToken,
      session.refreshToken,
      env,
      session.userEmail || ''
    );
  } catch (err) {
    console.error('Provision error (continue):', err);
    return renderProvisionError(err);
  }

  const params = new URLSearchParams({
    deployUrl: result.deployUrl,
    ssUrl:     result.ssUrl,
    gasUrl:    result.gasUrl,
    triggersSetup: result.triggersSetup ? '1' : '0',
  });
  return Response.redirect(`${env.WORKER_URL}/complete?${params}`, 302);
}

// ============================================================
// 完了ページ
// ============================================================
function handleComplete(url, env) {
  const deployUrl = url.searchParams.get('deployUrl') || '';
  const manualUrl = getOperationsManualUrl(env);
  const manualLink = manualUrl
    ? `<p class="manual-link">LINE設定・GoogleカレンダーIDの取得方法は<a href="${escapeHtml(manualUrl)}" target="_blank" rel="noopener noreferrer">初期導入マニュアル</a>を参照してください。</p>`
    : '';

  const html = buildPage('自動セットアップ完了', `
    <div class="page-complete page-landing">
    <div class="hero">
      <h1>LINE予約システム</h1>
    </div>

    <div class="steps">
      <div class="step step-done">
        <div class="step-num">1</div>
        <div class="step-body">
          <strong>Google Apps Script APIをオンにする</strong>
        </div>
      </div>
      <div class="step step-done">
        <div class="step-num">2</div>
        <div class="step-body">
          <strong>Googleアカウントでログイン</strong>
        </div>
      </div>
      <div class="step step-done">
        <div class="step-num">3</div>
        <div class="step-body">
          <div class="step-title"><strong>自動セットアップ</strong><span class="step-note">※約3分 · 完了</span></div>
        </div>
      </div>
      <div class="step step-current">
        <div class="step-num">4</div>
        <div class="step-body">
          <strong>予約システム設定画面で初期設定・保存</strong>
        </div>
      </div>
    </div>

    <div class="url-card">
      <div class="url-label">システムURL（大切に保管してください）</div>
      <a class="url-value url-link" id="deployUrl" href="${escapeHtml(deployUrl)}" target="_blank" rel="noopener noreferrer">${escapeHtml(deployUrl)}</a>
      <div class="url-card-actions">
        <button type="button" class="copy-btn" onclick="copyUrl(this)">コピー</button>
      </div>
      <p class="url-note">このURLが予約システムの入口です。必ずブックマークしてください。</p>
    </div>

    <div class="setup-notice">
      <p>「設定画面を開く」ボタンをクリック後「Review Permissions」ボタンをクリックし権限承認後に店舗の設定を行ってください。</p>
    </div>

    <div class="cta-area">
      <a href="${escapeHtml(deployUrl)}" target="_blank" rel="noopener noreferrer" class="btn-pill btn-start btn-open-settings">
        設定画面を開く
      </a>
      ${manualLink}
    </div>

    <script>
      function copyUrl(btn) {
        navigator.clipboard.writeText(${JSON.stringify(deployUrl)}).then(() => {
          btn.textContent = 'コピーしました！';
          btn.style.background = '#388e3c';
          setTimeout(() => { btn.textContent = 'コピー'; btn.style.background = ''; }, 2000);
        });
      }
    </script>
    </div>
  `);
  return htmlResponse(html);
}

// ============================================================
// トークン交換
// ============================================================
async function exchangeCodeForTokens(code, env) {
  return fetchJson(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id:     env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      redirect_uri:  `${env.WORKER_URL}/callback`,
      grant_type:    'authorization_code',
    }),
  }, 'OAuth token exchange');
}

// ============================================================
// プロビジョニング本体
// ============================================================
async function provision(accessToken, refreshToken, env, userEmail) {
  const userAuth = `Bearer ${accessToken}`;

  // Step 1: ユーザーのMy Driveに新しいスプレッドシートを作成
  // （SAのDriveに作成しないためストレージ問題が発生しない）
  console.log('Step 1: Creating new spreadsheet in user\'s My Drive...');
  const newSS = await callApi(
    SHEETS_API,
    'POST',
    userAuth,
    { properties: { title: '予約管理システム' } }
  );
  if (newSS.error) throw new Error(`スプレッドシートの作成に失敗: ${newSS.error.message}`);
  const ssId  = newSS.spreadsheetId;
  const ssUrl = `https://docs.google.com/spreadsheets/d/${ssId}/edit`;

  // Step 1b: テンプレートから全シートをコピー（Sheets API copyTo）
  // テンプレートは「リンクを知っている全員が編集可」に設定が必要
  console.log('Step 1b: Copying sheets from template...');
  await copySheetsFromTemplate(ssId, userAuth, env);

  // Step 1c: 導入台帳をCloudflare KVに記録（顧客データは含まない）
  console.log('Step 1c: Logging onboarding record to KV (initial)...');
  const onboardingRecord = {
    ssId,
    ssUrl: `https://docs.google.com/spreadsheets/d/${ssId}/edit`,
    onboardedAt: new Date().toISOString(),
    refreshToken: refreshToken || null,
  };
  await env.ONBOARDING_KV.put(
    `store:${ssId}`,
    JSON.stringify(onboardingRecord),
    { expirationTtl: 60 * 60 * 24 * 365 * 3 } // 3年保持
  );

  // Step 1d: ConfigシートのreservationSheetIdに新しいスプレッドシートIDを書き込む
  console.log('Step 1d: Writing spreadsheetId to Config sheet...');
  await writeConfigValue(ssId, userAuth, 'reservationSheetId', ssId);

  // Step 1e: adminEmailをConfigシートに書き込む（doGet認証に必要）
  if (userEmail) {
    console.log('Step 1e: Writing adminEmail to Config sheet:', userEmail);
    await writeConfigValue(ssId, userAuth, 'adminEmail', userEmail);
  }

  const manualUrl = getOperationsManualUrl(env);
  if (manualUrl) {
    console.log('Step 1f: Writing operationsManualUrl to Config sheet');
    await ensureConfigValue(ssId, userAuth, 'operationsManualUrl', manualUrl);
  }

  // Step 2: スタンドアロン GAS プロジェクト作成（ユーザーのOAuthトークン使用）
  console.log('Step 2: Creating GAS project...');
  const proj = await callApi(
    `${SCRIPT_API}/projects`,
    'POST',
    userAuth,
    { title: '予約管理システム_GAS' }
  );
  if (proj.error) throw new Error(`GASプロジェクト作成に失敗: ${proj.error.message}`);
  const scriptId = proj.scriptId;
  const gasUrl   = `https://script.google.com/d/${scriptId}/edit`;

  // Step 3: GitHubからスクリプトファイルを取得してスプレッドシートIDを埋め込む
  console.log('Step 3: Fetching script files from GitHub...');
  let files;
  try {
    files = await fetchAndPrepareFiles(ssId, env);
  } catch (e) {
    throw new Error(`Step 3 GitHub取得: ${e.message}`);
  }

  // Step 4: GASプロジェクトにコンテンツをプッシュ
  console.log('Step 4: Pushing content to GAS project...');
  const gasFiles = files.map(({ name, type, source }) => ({ name, type, source }));
  const content = await callApi(
    `${SCRIPT_API}/projects/${scriptId}/content`,
    'PUT',
    userAuth,
    { files: gasFiles }
  );
  if (content.error) throw new Error(`スクリプトのアップロードに失敗: ${content.error.message}`);

  // Step 5: バージョン作成
  console.log('Step 5: Creating version...');
  const version = await callApi(
    `${SCRIPT_API}/projects/${scriptId}/versions`,
    'POST',
    userAuth,
    { description: '初回デプロイ (自動オンボーディング)' }
  );
  if (version.error) throw new Error(`バージョン作成に失敗: ${version.error.message}`);

  // Step 6: Webアプリデプロイ
  console.log('Step 6: Deploying web app...');
  const deploy = await callApi(
    `${SCRIPT_API}/projects/${scriptId}/deployments`,
    'POST',
    userAuth,
    {
      versionNumber:        version.versionNumber,
      manifestFileName:     'appsscript',
      description:          '初回デプロイ (自動オンボーディング)',
    }
  );
  if (deploy.error) throw new Error(`デプロイに失敗: ${deploy.error.message}`);

  // デプロイURLを取得
  const webAppEntryPoint = (deploy.entryPoints || []).find(ep => ep.entryPointType === 'WEB_APP');
  const deployUrl    = webAppEntryPoint?.webApp?.url || `https://script.google.com/macros/s/${deploy.deploymentId}/exec`;
  const deploymentId = deploy.deploymentId;

  // KV レコードを scriptId・deploymentId で更新（コード更新配信に必要）
  console.log('Step 6b: Updating KV record with scriptId and deploymentId...');
  onboardingRecord.scriptId    = scriptId;
  onboardingRecord.deploymentId = deploymentId;
  if (userEmail) onboardingRecord.adminEmail = userEmail;
  await env.ONBOARDING_KV.put(
    `store:${ssId}`,
    JSON.stringify(onboardingRecord),
    { expirationTtl: 60 * 60 * 24 * 365 * 3 }
  );

  // 顧客台帳スプレッドシートへ登録
  if (env.CUSTOMER_REGISTRY_SS_ID) {
    try {
      await upsertRegistryCustomer(env, getServiceAccountToken, {
        ssId,
        adminEmail: userEmail || '',
        deployUrl,
        scriptId,
        shopName: '',
        paymentStatus: 'トライアル',
        serviceStatus: '稼働中',
      });
    } catch (regErr) {
      console.warn('顧客台帳登録に失敗（オンボーディングは継続）:', regErr.message);
    }
  }

  // サービス停止フラグの初期値
  await writeConfigValue(ssId, userAuth, 'serviceSuspended', 'false');

  // Step 10: GAS 時間主導トリガー自動設定（§14.4）
  console.log('Step 10: Setting up GAS time-driven triggers...');
  const triggersResult = await setupGasTriggers(scriptId, userAuth);

  console.log('Provisioning complete!', { ssId, scriptId, deployUrl, triggersSetup: triggersResult.ok });
  return { deployUrl, ssUrl, gasUrl, triggersSetup: triggersResult.ok, triggersMessage: triggersResult.message || '' };
}

// ============================================================
// テンプレートSSから全シートをコピーしてシート名を整理する
// テンプレートは「リンクを知っている全員が編集可」に設定しておくこと
// ============================================================
async function copySheetsFromTemplate(destSsId, userAuth, env) {
  const templateId = env.TEMPLATE_SS_ID;

  // テンプレートのシート一覧を取得
  const templateData = await fetchJson(
    `${SHEETS_API}/${templateId}?fields=sheets.properties`,
    { headers: { Authorization: userAuth } },
    'テンプレートSS読み込み'
  );
  if (templateData.error) {
    throw new Error(`テンプレート読み込み失敗: ${templateData.error.message} — テンプレートSSが「リンクを知っている全員が編集可」に設定されているか確認してください`);
  }
  const templateSheets = templateData.sheets || [];

  // コピー先SSのデフォルトシートID（後で削除する）
  const destData = await fetchJson(
    `${SHEETS_API}/${destSsId}?fields=sheets.properties`,
    { headers: { Authorization: userAuth } },
    'コピー先SS読み込み'
  );
  if (destData.error) throw new Error(`コピー先SS読み込み失敗: ${destData.error.message}`);
  const defaultSheetId = destData.sheets?.[0]?.properties?.sheetId;

  // テンプレートの各シートをコピー先SSにコピー
  const copiedSheets = [];
  for (const sheet of templateSheets) {
    const data = await fetchJson(
      `${SHEETS_API}/${templateId}/sheets/${sheet.properties.sheetId}:copyTo`,
      {
        method: 'POST',
        headers: { Authorization: userAuth, 'Content-Type': 'application/json' },
        body: JSON.stringify({ destinationSpreadsheetId: destSsId }),
      },
      `シートコピー (${sheet.properties.title})`
    );
    if (data.error) throw new Error(`シートコピー失敗 (${sheet.properties.title}): ${data.error.message}`);
    copiedSheets.push({ newSheetId: data.sheetId, originalTitle: sheet.properties.title });
  }

  // デフォルトシートを削除 & コピーされたシートのシート名から "Copy of " を除去
  const requests = [
    ...(defaultSheetId !== undefined ? [{ deleteSheet: { sheetId: defaultSheetId } }] : []),
    ...copiedSheets.map(({ newSheetId, originalTitle }) => ({
      updateSheetProperties: {
        properties: { sheetId: newSheetId, title: originalTitle },
        fields: 'title',
      },
    })),
  ];

  const batchData = await fetchJson(
    `${SHEETS_API}/${destSsId}:batchUpdate`,
    {
      method: 'POST',
      headers: { Authorization: userAuth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ requests }),
    },
    'シート整理 batchUpdate'
  );
  if (batchData.error) throw new Error(`シート整理失敗: ${batchData.error.message}`);
  console.log(`Copied ${copiedSheets.length} sheets from template.`);
}

// ============================================================
// Configシートの指定キーに値を書き込む汎用関数
// ============================================================
async function writeConfigValue(spreadsheetId, authHeader, key, value) {
  // まずConfigシートのA列（キー列）を取得して該当キーの行番号を探す
  const rangeData = await fetchJson(
    `${SHEETS_API}/${spreadsheetId}/values/Config!A:A`,
    { headers: { Authorization: authHeader } },
    `Config読込 (${key})`
  );
  if (rangeData.error) {
    console.warn(`Config sheet read warning (${key}):`, rangeData.error.message);
    return;
  }

  const rows = rangeData.values || [];
  const rowIndex = rows.findIndex(r => r[0] === key);
  if (rowIndex === -1) {
    console.warn(`${key} key not found in Config sheet`);
    return;
  }

  // B列（値列）の該当行に値を書き込む
  const targetRange = `Config!B${rowIndex + 1}`;
  const updateData = await fetchJson(
    `${SHEETS_API}/${spreadsheetId}/values/${encodeURIComponent(targetRange)}?valueInputOption=RAW`,
    {
      method: 'PUT',
      headers: { Authorization: authHeader, 'Content-Type': 'application/json' },
      body: JSON.stringify({ values: [[value]] }),
    },
    `Config書込 (${key})`
  );
  if (updateData.error) {
    console.warn(`Config sheet write warning (${key}):`, updateData.error.message);
  } else {
    console.log(`${key} written to Config sheet:`, value);
  }
}

// ============================================================
// サービスアカウントのアクセストークンを取得
// env.GOOGLE_SA_KEY にサービスアカウントのJSONキーを設定すること
// ============================================================
async function getServiceAccountToken(env, scope) {
  const saScope = scope || 'https://www.googleapis.com/auth/drive';
  if (!env.GOOGLE_SA_KEY) {
    throw new Error('GOOGLE_SA_KEY が設定されていません。Cloudflare Workers の Secrets に追加してください。');
  }

  let sa;
  try {
    sa = JSON.parse(env.GOOGLE_SA_KEY);
  } catch (e) {
    throw new Error('GOOGLE_SA_KEY のJSONパースに失敗しました。');
  }

  const now = Math.floor(Date.now() / 1000);
  const header  = { alg: 'RS256', typ: 'JWT' };
  const payload = {
    iss:   sa.client_email,
    scope: saScope,
    aud:   'https://oauth2.googleapis.com/token',
    exp:   now + 3600,
    iat:   now,
  };

  const b64url = (obj) =>
    btoa(JSON.stringify(obj)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

  const signingInput = `${b64url(header)}.${b64url(payload)}`;

  // PEM秘密鍵をArrayBufferに変換してインポート
  const pemKey  = sa.private_key.replace(/\\n/g, '\n');
  const b64Key  = pemKey.replace(/-----[^-]+-----/g, '').replace(/\s/g, '');
  const keyBuffer = Uint8Array.from(atob(b64Key), c => c.charCodeAt(0)).buffer;

  const cryptoKey = await crypto.subtle.importKey(
    'pkcs8',
    keyBuffer,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign']
  );

  const sigBuffer = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    cryptoKey,
    new TextEncoder().encode(signingInput)
  );

  const sig = btoa(String.fromCharCode(...new Uint8Array(sigBuffer)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

  const jwt = `${signingInput}.${sig}`;

  // JWTをアクセストークンに交換
  const data = await fetchJson('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion:  jwt,
    }),
  }, 'サービスアカウント token');
  if (!data.access_token) {
    throw new Error(`サービスアカウントトークン取得失敗: ${JSON.stringify(data.error || data)}`);
  }
  return data.access_token;
}

// ============================================================
// refresh_token を使って新しい access_token を取得
// ============================================================
async function refreshAccessToken(refreshToken, env) {
  return fetchJson(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id:     env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      refresh_token: refreshToken,
      grant_type:    'refresh_token',
    }),
  }, 'refresh token');
}

// ============================================================
// Config: キーが無ければ行を追加してから値を書き込む
// ============================================================
async function ensureConfigValue(spreadsheetId, authHeader, key, value) {
  const rangeRes = await fetch(
    `${SHEETS_API}/${spreadsheetId}/values/Config!A:A`,
    { headers: { Authorization: authHeader } }
  );
  const rangeData = await rangeRes.json();
  if (rangeData.error) {
    console.warn(`Config read warning (${key}):`, rangeData.error.message);
    return;
  }
  const rows = rangeData.values || [];
  const rowIndex = rows.findIndex(r => r[0] === key);
  if (rowIndex === -1) {
    const appendRes = await fetch(
      `${SHEETS_API}/${spreadsheetId}/values/Config!A:B:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`,
      {
        method: 'POST',
        headers: { Authorization: authHeader, 'Content-Type': 'application/json' },
        body: JSON.stringify({ values: [[key, value]] }),
      }
    );
    const appendData = await appendRes.json();
    if (appendData.error) console.warn(`Config append warning (${key}):`, appendData.error.message);
    else console.log(`${key} appended to Config:`, value);
  } else {
    await writeConfigValue(spreadsheetId, authHeader, key, value);
  }
}

async function syncServiceSuspendedToCustomer(ssId, serviceStatus, kvRecord, env) {
  if (!kvRecord?.refreshToken) {
    throw new Error('refreshToken 未保存のため Config 同期不可');
  }
  const tokens = await refreshAccessToken(kvRecord.refreshToken, env);
  if (!tokens.access_token) {
    throw new Error(`トークンリフレッシュ失敗: ${JSON.stringify(tokens.error || tokens)}`);
  }
  const auth = `Bearer ${tokens.access_token}`;
  const suspended = serviceStatus === '停止';
  await ensureConfigValue(ssId, auth, 'serviceSuspended', suspended ? 'true' : 'false');
  if (tokens.refresh_token && tokens.refresh_token !== kvRecord.refreshToken) {
    kvRecord.refreshToken = tokens.refresh_token;
    await env.ONBOARDING_KV.put(`store:${ssId}`, JSON.stringify(kvRecord), { expirationTtl: 60 * 60 * 24 * 365 * 3 });
  }
}

async function pushCodeToCustomer(ssId, kvRecord, rawFiles, env) {
  const { scriptId, deploymentId, refreshToken } = kvRecord;
  if (!refreshToken || !scriptId || !deploymentId) {
    return { ssId, status: 'skipped', reason: 'refreshToken/scriptId/deploymentId 未保存（再オンボーディングが必要）' };
  }

  const tokens = await refreshAccessToken(refreshToken, env);
  if (!tokens.access_token) {
    throw new Error(`トークンリフレッシュ失敗: ${JSON.stringify(tokens.error || tokens)}`);
  }
  const auth = `Bearer ${tokens.access_token}`;

  if (tokens.refresh_token && tokens.refresh_token !== refreshToken) {
    kvRecord.refreshToken = tokens.refresh_token;
    await env.ONBOARDING_KV.put(`store:${ssId}`, JSON.stringify(kvRecord), { expirationTtl: 60 * 60 * 24 * 365 * 3 });
  }

  const files = substituteProvisionedValues(rawFiles, ssId, env);
  const content = await callApi(`${SCRIPT_API}/projects/${scriptId}/content`, 'PUT', auth, { files });
  if (content.error) throw new Error(`content push 失敗: ${content.error.message}`);

  const version = await callApi(`${SCRIPT_API}/projects/${scriptId}/versions`, 'POST', auth, {
    description: `管理者プッシュ更新 ${new Date().toISOString()}`,
  });
  if (version.error) throw new Error(`version 作成失敗: ${version.error.message}`);

  const updated = await callApi(
    `${SCRIPT_API}/projects/${scriptId}/deployments/${deploymentId}`,
    'PUT',
    auth,
    {
      deploymentConfig: {
        versionNumber:    version.versionNumber,
        manifestFileName: 'appsscript',
        description:      `管理者プッシュ更新 ${new Date().toISOString()}`,
      },
    }
  );
  if (updated.error) throw new Error(`deployment 更新失敗: ${updated.error.message}`);

  const triggersResult = await setupGasTriggers(scriptId, auth);

  return {
    ssId,
    status: 'success',
    versionNumber: version.versionNumber,
    triggersSetup: triggersResult.ok,
    triggersMessage: triggersResult.message || '',
  };
}

// ============================================================
// 管理者: 顧客台帳シート初期化
// GET /admin/init-registry?key=
// ============================================================
async function handleInitRegistry(request, env) {
  const gate = await adminAuthOrRedirect(request, env);
  if (gate.response) return gate.response;
  try {
    const result = await initCustomerRegistrySheet(env, getServiceAccountToken);
    const html = buildPage('顧客台帳 初期化完了', `
      <h2>✅ 顧客台帳シートを初期化しました</h2>
      <p style="margin:16px 0;">シート名: <strong>${REGISTRY_SHEET}</strong></p>
      <p><a href="${escapeHtml(result.sheetUrl)}" target="_blank">スプレッドシートを開く</a></p>
      <p style="margin-top:16px; color:#666; font-size:13px;">列: ${REGISTRY_HEADERS.join(' / ')}</p>
      <p style="margin-top:12px;"><a href="/admin/sync-registry">KVから既存顧客を台帳へ同期</a></p>
    `);
    return htmlResponse(html);
  } catch (err) {
    return renderError(escapeHtml(err.message));
  }
}

// KVの導入記録を顧客台帳へ同期（既存顧客の移行用）
async function handleSyncRegistry(request, env) {
  const gate = await adminAuthOrRedirect(request, env);
  if (gate.response) return gate.response;
  if (!env.CUSTOMER_REGISTRY_SS_ID) {
    return renderError('CUSTOMER_REGISTRY_SS_ID が未設定です。');
  }

  const list = await env.ONBOARDING_KV.list({ prefix: 'store:' });
  const synced = [];
  for (const kvKey of list.keys) {
    const raw = await env.ONBOARDING_KV.get(kvKey.name);
    if (!raw) continue;
    const rec = JSON.parse(raw);
    const ssId = rec.ssId || kvKey.name.replace(/^store:/, '');
    try {
      await upsertRegistryCustomer(env, getServiceAccountToken, {
        ssId,
        adminEmail: rec.adminEmail || '',
        deployUrl: rec.deployUrl || '',
        scriptId: rec.scriptId || '',
        onboardedAt: rec.onboardedAt || new Date().toISOString(),
        paymentStatus: 'トライアル',
        serviceStatus: '稼働中',
      });
      synced.push(ssId);
    } catch (e) {
      synced.push(`${ssId} (error: ${e.message})`);
    }
  }

  const html = buildPage('KV → 顧客台帳 同期', `
    <h2>✅ ${synced.length} 件を同期しました</h2>
    <ul style="margin-top:16px; font-family:monospace; font-size:12px;">
      ${synced.map(s => `<li>${escapeHtml(s)}</li>`).join('') || '<li>対象なし</li>'}
    </ul>
    <p style="margin-top:20px;"><a href="/admin">← 顧客管理に戻る</a></p>
  `);
  return htmlResponse(html);
}

// ============================================================
// 管理者: サービス停止 / 再開
// GET /admin/set-status?ssId=&serviceStatus=停止|稼働中&paymentStatus=
// ============================================================
async function handleSetStatus(request, env) {
  const gate = await adminAuthOrRedirect(request, env);
  if (gate.response) return gate.response;

  const url = new URL(request.url);
  const ssId          = url.searchParams.get('ssId');
  const serviceStatus = url.searchParams.get('serviceStatus');
  const paymentStatus = url.searchParams.get('paymentStatus');

  if (!ssId) return renderError('ssId パラメータが必要です。');
  if (!serviceStatus && !paymentStatus) {
    return renderError('serviceStatus または paymentStatus を指定してください。');
  }

  try {
    const data = await executeSetStatus(env, pushUpdateDeps(env), {
      ssId,
      serviceStatus: serviceStatus || null,
      paymentStatus: paymentStatus || null,
    });

    const html = buildPage('ステータス更新', `
      <h2>✅ 顧客ステータスを更新しました</h2>
      <p><strong>ssId:</strong> <code>${escapeHtml(ssId)}</code></p>
      <p><strong>サービス状態:</strong> ${escapeHtml(data.updated.serviceStatus)}</p>
      <p><strong>決済ステータス:</strong> ${escapeHtml(data.updated.paymentStatus)}</p>
      <p><strong>GAS Config 同期:</strong> ${escapeHtml(data.configSync)}</p>
      <p style="margin-top:20px;"><a href="/admin">← デプロイ支援コンソールに戻る</a></p>
    `);
    return htmlResponse(html);
  } catch (err) {
    return renderError(escapeHtml(err.message));
  }
}

// ============================================================
// 管理者: 指定顧客の GAS プロジェクトに最新コードを配信
// GET /admin/push-update?ssId= | &ssIds=a,b | （省略時=稼働中全件）
// ============================================================
async function handlePushUpdate(request, env) {
  const gate = await adminAuthOrRedirect(request, env);
  if (gate.response) return gate.response;

  const url = new URL(request.url);
  const ssIdParam  = url.searchParams.get('ssId');
  const ssIdsParam = url.searchParams.get('ssIds');
  let ssIds = null;
  if (ssIdParam) ssIds = [ssIdParam.trim()];
  else if (ssIdsParam) ssIds = ssIdsParam.split(',').map(s => s.trim()).filter(Boolean);

  const includeStopped = url.searchParams.get('includeStopped') === '1';

  let data;
  try {
    data = await executePushUpdate(env, pushUpdateDeps(env), { ssIds, includeStopped, allActive: !ssIds?.length });
  } catch (err) {
    return renderError(escapeHtml(err.message));
  }

  const { targetDesc, results, successCount, skipCount, errorCount } = data;

  if (results.length === 0) {
    const html = buildPage('コード更新配信結果', `
      <h2>🚀 コード更新配信結果</h2>
      <p>対象: ${escapeHtml(targetDesc)}</p>
      <p style="color:#999; margin-top:16px;">配信対象の顧客がありません。</p>
      <p style="margin-top:20px;"><a href="/admin">← デプロイ支援コンソールに戻る</a></p>
    `);
    return htmlResponse(html);
  }

  const html = buildPage('コード更新配信結果', `
    <h2 style="margin-bottom:20px;">🚀 コード更新配信結果</h2>
    <p style="margin-bottom:12px; color:#555;">対象: <strong>${escapeHtml(targetDesc)}</strong></p>
    <p style="margin-bottom:16px; color:#555;">
      成功: <strong style="color:#06c755;">${successCount}</strong> 件 ／
      スキップ: <strong style="color:#999;">${skipCount}</strong> 件 ／
      エラー: <strong style="color:#d32f2f;">${errorCount}</strong> 件
    </p>
    <table style="width:100%; border-collapse:collapse; font-size:13px;">
      <thead>
        <tr style="background:#f0f4f8;">
          <th style="padding:8px; text-align:left; border-bottom:2px solid #dee2e6;">ssId</th>
          <th style="padding:8px; text-align:left; border-bottom:2px solid #dee2e6;">結果</th>
          <th style="padding:8px; text-align:left; border-bottom:2px solid #dee2e6;">詳細</th>
        </tr>
      </thead>
      <tbody>
        ${results.map(r => `
          <tr>
            <td style="padding:8px; border-bottom:1px solid #eee; font-family:monospace; font-size:12px;">${escapeHtml(r.ssId || '')}</td>
            <td style="padding:8px; border-bottom:1px solid #eee; color:${r.status === 'success' ? '#06c755' : r.status === 'skipped' ? '#999' : '#d32f2f'};">
              ${r.status === 'success' ? '✅ 成功' : r.status === 'skipped' ? '⏭️ スキップ' : '❌ エラー'}
            </td>
            <td style="padding:8px; border-bottom:1px solid #eee; color:#666;">
              ${escapeHtml(r.reason || (r.status === 'success' ? `v${r.versionNumber} にデプロイ済み${r.configSyncWarning ? '（停止フラグ同期警告: ' + r.configSyncWarning + '）' : ''}` : ''))}
            </td>
          </tr>
        `).join('')}
      </tbody>
    </table>
    <p style="margin-top:20px;"><a href="/admin">← デプロイ支援コンソールに戻る</a></p>
    <p style="margin-top:8px; color:#999; font-size:12px;">実行日時: ${new Date().toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' })}</p>
  `);
  return htmlResponse(html);
}

// ============================================================
// GET /admin/kv-cleanup
// 壊れた KV エントリ（refreshToken 未保存 or GASプロジェクト削除済み）を削除する。
// ============================================================
async function handleKvCleanup(request, env) {
  const gate = await adminAuthOrRedirect(request, env);
  if (gate.response) return gate.response;

  const list    = await env.ONBOARDING_KV.list({ prefix: 'store:' });
  const deleted = [];
  const kept    = [];

  for (const kvKey of list.keys) {
    const raw    = await env.ONBOARDING_KV.get(kvKey.name);
    const record = raw ? JSON.parse(raw) : null;

    if (!record) {
      await env.ONBOARDING_KV.delete(kvKey.name);
      deleted.push({ key: kvKey.name, ssId: '(不明)', reason: 'レコードなし' });
      continue;
    }

    const { ssId, scriptId, deploymentId, refreshToken } = record;

    if (ssId && !(await isSpreadsheetAvailable(env, getServiceAccountToken, ssId))) {
      await env.ONBOARDING_KV.delete(kvKey.name);
      deleted.push({ ssId, key: kvKey.name, reason: 'スプレッドシートが存在しない（削除済み）' });
      continue;
    }

    // refreshToken / scriptId / deploymentId が揃っていないエントリは再オンボーディング不可 → 削除
    if (!refreshToken || !scriptId || !deploymentId) {
      await env.ONBOARDING_KV.delete(kvKey.name);
      deleted.push({ ssId, key: kvKey.name, reason: 'refreshToken/scriptId/deploymentId 未保存' });
      continue;
    }

    // GASプロジェクトが実際に存在するか確認
    try {
      const tokens = await refreshAccessToken(refreshToken, env);
      if (!tokens.access_token) {
        await env.ONBOARDING_KV.delete(kvKey.name);
        deleted.push({ ssId, key: kvKey.name, reason: 'トークンリフレッシュ失敗（アクセス権が失効した可能性）' });
        continue;
      }
      // refresh_token がローテーションされた場合はKVを更新しておく
      if (tokens.refresh_token && tokens.refresh_token !== refreshToken) {
        record.refreshToken = tokens.refresh_token;
        await env.ONBOARDING_KV.put(kvKey.name, JSON.stringify(record), { expirationTtl: 60 * 60 * 24 * 365 * 3 });
      }
      const projRes = await fetch(`${SCRIPT_API}/projects/${scriptId}`, {
        headers: { Authorization: `Bearer ${tokens.access_token}` },
      });
      if (projRes.status === 404) {
        await env.ONBOARDING_KV.delete(kvKey.name);
        deleted.push({ ssId, key: kvKey.name, reason: 'GASプロジェクトが存在しない (404)' });
        continue;
      }
      kept.push({ ssId, key: kvKey.name });
    } catch (err) {
      // 確認中にエラーが出たエントリは念のため残す
      kept.push({ ssId, key: kvKey.name, note: `確認エラー（保持）: ${err.message}` });
    }
  }

  const html = buildPage('KV クリーンアップ結果', `
    <h2 style="margin-bottom:20px;">🧹 KV クリーンアップ結果</h2>
    <p style="margin-bottom:16px; color:#555;">
      削除: <strong style="color:#d32f2f;">${deleted.length}</strong> 件 ／
      保持: <strong style="color:#06c755;">${kept.length}</strong> 件
    </p>

    <h3 style="margin:24px 0 12px; font-size:15px;">✅ 保持（有効な顧客）</h3>
    <table style="width:100%; border-collapse:collapse; font-size:13px; margin-bottom:24px;">
      <thead>
        <tr style="background:#f0f4f8;">
          <th style="padding:8px; text-align:left; border-bottom:2px solid #dee2e6;">スプレッドシートID</th>
          <th style="padding:8px; text-align:left; border-bottom:2px solid #dee2e6;">備考</th>
        </tr>
      </thead>
      <tbody>
        ${kept.length === 0 ? '<tr><td colspan="2" style="padding:8px; color:#999;">なし</td></tr>' :
          kept.map(r => `<tr>
            <td style="padding:8px; border-bottom:1px solid #eee; font-family:monospace; font-size:12px;">${escapeHtml(r.ssId)}</td>
            <td style="padding:8px; border-bottom:1px solid #eee; color:#666;">${escapeHtml(r.note || '正常')}</td>
          </tr>`).join('')}
      </tbody>
    </table>

    <h3 style="margin:0 0 12px; font-size:15px;">🗑️ 削除済み</h3>
    <table style="width:100%; border-collapse:collapse; font-size:13px;">
      <thead>
        <tr style="background:#f0f4f8;">
          <th style="padding:8px; text-align:left; border-bottom:2px solid #dee2e6;">スプレッドシートID</th>
          <th style="padding:8px; text-align:left; border-bottom:2px solid #dee2e6;">削除理由</th>
        </tr>
      </thead>
      <tbody>
        ${deleted.length === 0 ? '<tr><td colspan="2" style="padding:8px; color:#999;">なし</td></tr>' :
          deleted.map(r => `<tr>
            <td style="padding:8px; border-bottom:1px solid #eee; font-family:monospace; font-size:12px;">${escapeHtml(r.ssId || r.key)}</td>
            <td style="padding:8px; border-bottom:1px solid #eee; color:#666;">${escapeHtml(r.reason)}</td>
          </tr>`).join('')}
      </tbody>
    </table>
    <p style="margin-top:20px;"><a href="/admin">← デプロイ支援コンソールに戻る</a></p>
    <p style="margin-top:8px; color:#999; font-size:12px;">実行日時: ${new Date().toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' })}</p>
  `);
  return htmlResponse(html);
}

// ============================================================
// id_token（JWT）のペイロードからメールアドレスを取得（最優先）
// ============================================================
function getEmailFromIdToken(idToken) {
  if (!idToken) return null;
  try {
    const payload = idToken.split('.')[1];
    // base64url → base64 変換してデコード
    const base64 = payload.replace(/-/g, '+').replace(/_/g, '/');
    const padded  = base64.padEnd(base64.length + (4 - base64.length % 4) % 4, '=');
    const decoded = JSON.parse(atob(padded));
    return decoded.email || null;
  } catch (e) {
    console.warn('getEmailFromIdToken failed:', e.message);
    return null;
  }
}

// ============================================================
// Google userinfo APIからメールアドレスを取得（フォールバック）
// ============================================================
async function getUserEmail(accessToken) {
  try {
    const res = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    const data = await res.json();
    return data.email || null;
  } catch (e) {
    console.warn('getUserEmail failed:', e.message);
    return null;
  }
}

// GitHubからスクリプトファイルを取得する（プレースホルダーはそのまま）
// push-update では全顧客共通なのでループ外で1回だけ呼ぶ。
// ============================================================
async function fetchRawFiles(env, options) {
  const includeTests = !!(options && options.includeTests);
  const meta = includeTests
    ? SCRIPT_FILES_META.concat([TEST_SCRIPT_FILE_META])
    : SCRIPT_FILES_META;
  const repo   = env.GITHUB_REPO;
  const branch = env.GITHUB_BRANCH || 'main';
  const base   = `https://raw.githubusercontent.com/${repo}/${branch}`;

  return Promise.all(
    meta.map(async ({ name, type, file }) => {
      const res = await fetch(`${base}/${file}`);
      if (!res.ok) throw new Error(`GitHubからのファイル取得失敗: ${file} (${res.status})`);
      const source = await res.text();
      return { name, type, file, source };
    })
  );
}

// 取得済みファイル配列に顧客固有のスプレッドシートIDを埋め込む（外部リクエストなし）
// 定数宣言行のみ置換する（比較式内の 'PLACEHOLDER_SPREADSHEET_ID' リテラルは触らない）
// ============================================================
function substituteProvisionedValues(rawFiles, spreadsheetId, env) {
  const ssIdPattern = /const _PROVISIONED_SS_ID = 'PLACEHOLDER_SPREADSHEET_ID';/;
  const ssIdReplacement = `const _PROVISIONED_SS_ID = '${spreadsheetId}';`;
  const secretPattern = /const _ERROR_REPORT_SECRET = 'PLACEHOLDER_ERROR_REPORT_SECRET';/;
  const secretRaw = env.ERROR_REPORT_SECRET || 'PLACEHOLDER_ERROR_REPORT_SECRET';
  const secretEscaped = String(secretRaw).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
  const secretReplacement = `const _ERROR_REPORT_SECRET = '${secretEscaped}';`;
  return rawFiles.map(({ name, type, file, source }) => ({
    name,
    type,
    source: file === 'Code.js'
      ? source.replace(ssIdPattern, ssIdReplacement).replace(secretPattern, secretReplacement)
      : source,
  }));
}

/** @deprecated substituteProvisionedValues を使用 */
function substituteSpreadsheetId(rawFiles, spreadsheetId) {
  return substituteProvisionedValues(rawFiles, spreadsheetId, {});
}

// オンボーディング時など単一顧客向けにまとめて呼ぶラッパー
// ============================================================
async function fetchAndPrepareFiles(spreadsheetId, env) {
  const rawFiles = await fetchRawFiles(env);
  return substituteProvisionedValues(rawFiles, spreadsheetId, env);
}

// ============================================================
// 汎用 API 呼び出しヘルパー
// ============================================================
async function readJsonResponse(res, context) {
  const text = await res.text();
  if (!text || !text.trim()) {
    if (!res.ok) {
      throw new Error(`${context}: HTTP ${res.status}（応答ボディなし）`);
    }
    return {};
  }
  const trimmed = text.trimStart();
  if (trimmed.startsWith('<!DOCTYPE') || trimmed.startsWith('<html') || trimmed.startsWith('<')) {
    throw new Error(
      `${context}: サーバーが HTML エラーページを返しました（HTTP ${res.status}）。` +
      ' Google Cloud プロジェクトで Apps Script API / Sheets API が有効か、OAuth 設定を確認してください。'
    );
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${context}: 応答の解析に失敗しました（HTTP ${res.status}）`);
  }
}

async function fetchJson(url, options, context) {
  const res = await fetch(url, options);
  return readJsonResponse(res, context);
}

async function callApi(url, method, authHeader, body) {
  const headers = { Authorization: authHeader };
  if (body !== undefined && body !== null) {
    headers['Content-Type'] = 'application/json';
  }
  return fetchJson(url, {
    method,
    headers,
    body: body !== undefined && body !== null ? JSON.stringify(body) : undefined,
  }, `${method} ${url}`);
}

/**
 * Apps Script API で GAS 関数をリモート実行する（オンボーディング Step 10 等）。
 */
async function runGasFunction(scriptId, authHeader, functionName, parameters = []) {
  const result = await callApi(
    `${SCRIPT_API}/scripts/${scriptId}:run`,
    'POST',
    authHeader,
    { function: functionName, parameters, devMode: false }
  );
  if (result.error) {
    const detail = result.error.details?.[0]?.errorMessage || result.error.message;
    throw new Error(detail || JSON.stringify(result.error));
  }
  if (result.response?.error) {
    throw new Error(JSON.stringify(result.response.error));
  }
  return result.response?.result;
}

/**
 * setupTriggers() をリモート実行。失敗しても provision / push は中断しない。
 */
async function setupGasTriggers(scriptId, authHeader) {
  try {
    await runGasFunction(scriptId, authHeader, 'setupTriggers', []);
    return { ok: true };
  } catch (e) {
    console.warn('setupGasTriggers failed:', e.message);
    return { ok: false, message: e.message };
  }
}

// ============================================================
// HTML ページビルダー
// ============================================================
function buildPage(title, content) {
  return `<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(title)} | LINE予約システム</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Helvetica Neue', Arial, sans-serif;
      background: #f0f4f8;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 12px;
    }
    .card {
      background: #fff;
      border-radius: 16px;
      box-shadow: 0 4px 24px rgba(0,0,0,0.10);
      padding: 48px 40px;
      max-width: 640px;
      width: 100%;
    }
    .card:has(.page-landing),
    .card:has(.page-complete),
    .card:has(.page-preflight) { padding: 28px 24px 24px; max-width: 640px; }
    /* Hero */
    .hero { text-align: center; margin-bottom: 40px; }
    .logo { font-size: 56px; margin-bottom: 12px; }
    .hero h1 { font-size: 28px; font-weight: 700; color: #111; }
    .subtitle { color: #666; margin-top: 6px; font-size: 15px; }
    .page-landing .hero { margin-bottom: 16px; }
    .page-landing .hero h1 { font-size: 21px; }
    /* Steps */
    .steps { display: flex; flex-direction: column; gap: 16px; margin-bottom: 40px; }
    .step { display: flex; align-items: flex-start; gap: 16px; }
    .page-landing .steps { gap: 8px; margin-bottom: 14px; }
    .page-landing .step { gap: 10px; align-items: center; }
    .step-num {
      width: 36px; height: 36px; border-radius: 50%;
      background: #06c755; color: #fff;
      font-weight: 700; font-size: 16px;
      display: flex; align-items: center; justify-content: center;
      flex-shrink: 0;
    }
    .step-body { display: flex; flex-direction: column; gap: 2px; padding-top: 6px; min-width: 0; }
    .step-title { line-height: 1.35; }
    .step-body strong { font-size: 15px; color: #111; }
    .page-landing .step-num { width: 26px; height: 26px; font-size: 13px; }
    .page-landing .step-body { padding-top: 0; }
    .page-landing .step-body strong { font-size: 13px; line-height: 1.35; font-weight: 600; }
    .step-note {
      display: inline; font-size: 11px; color: #888; font-weight: 400;
      margin-left: 4px; white-space: nowrap;
    }
    .step-done { opacity: 0.55; }
    .step-done.step-current { opacity: 1; }
    .step-current .step-num { box-shadow: 0 0 0 2px #fff, 0 0 0 4px #06c755; }
    /* CTA */
    .setup-notice {
      background: #f0f7ff; border: 1px solid #bfdbfe; border-radius: 10px;
      padding: 14px 16px; margin-bottom: 24px; text-align: left;
    }
    .setup-notice p { font-size: 13px; color: #334155; line-height: 1.55; margin: 0; }
    .setup-notice strong { color: #1e40af; font-weight: 700; }
    .page-landing .setup-notice { padding: 8px 12px; margin-bottom: 12px; }
    .page-landing .setup-notice p { font-size: 12px; line-height: 1.45; }
    .cta-area { text-align: center; display: flex; flex-direction: column; align-items: center; gap: 14px; }
    .page-landing .cta-area { gap: 8px; }
    .cta-check { justify-content: center; margin-top: 0; font-weight: 500; font-size: 13px; color: #555; }
    .page-landing .cta-check { font-size: 12px; }
    .page-landing .step-zero-check input { width: 16px; height: 16px; margin-top: 2px; }
    .btn-pill {
      display: inline-flex; align-items: center; justify-content: center;
      width: 100%; max-width: 360px; box-sizing: border-box;
      padding: 16px 32px; border-radius: 50px;
      font-size: 16px; font-weight: 700;
      text-decoration: none;
      transition: background 0.2s, transform 0.1s, opacity 0.2s;
    }
    .page-landing .btn-pill { padding: 11px 20px; font-size: 14px; max-width: 100%; }
    .btn-settings {
      background: #4285f4; color: #fff;
    }
    .btn-settings:hover { background: #3367d6; transform: translateY(-1px); }
    .btn-start {
      background: #06c755; color: #fff;
    }
    .btn-start:hover { background: #05a548; transform: translateY(-1px); }
    .btn-start-gated { opacity: 0.45; pointer-events: none; cursor: not-allowed; }
    .btn-start-gated.btn-start-ready { opacity: 1; pointer-events: auto; cursor: pointer; }
    .note { color: #999; font-size: 12px; margin-top: 12px; }
    /* STEP 0 */
    .step-zero {
      background: #fffbeb; border: 1.5px solid #f59e0b; border-radius: 12px;
      padding: 20px 22px; margin-bottom: 28px;
    }
    .step-zero-head { display: flex; align-items: center; gap: 10px; margin-bottom: 10px; flex-wrap: wrap; }
    .step-zero-badge {
      background: #f59e0b; color: #fff; font-size: 11px; font-weight: 800;
      padding: 3px 8px; border-radius: 6px; letter-spacing: 0.04em;
    }
    .step-zero-lead { font-size: 13px; color: #555; line-height: 1.55; margin-bottom: 12px; }
    .step-zero-check {
      display: flex; align-items: flex-start; gap: 10px; cursor: pointer;
      font-size: 14px; font-weight: 600; color: #333; margin-top: 8px;
    }
    .step-zero-check input { margin-top: 3px; width: 18px; height: 18px; flex-shrink: 0; }
    .step-zero-warn {
      background: #fff5f5; border: 1px solid #fca5a5; border-radius: 8px;
      padding: 12px 14px; font-size: 13px; color: #b91c1c; margin-top: 16px;
    }
    .help-steps {
      text-align: left; padding-left: 20px; margin: 12px 0;
      font-size: 14px; color: #333; line-height: 1.7;
    }
    .help-steps li { margin-bottom: 6px; }
    .help-note { font-size: 12px; color: #888; text-align: center; margin-top: 8px; }
    .btn-outline-link {
      display: inline-block; background: #fff; border: 1.5px solid #06c755; color: #047857;
      padding: 10px 20px; border-radius: 8px; text-decoration: none; font-weight: 700; font-size: 14px;
    }
    .btn-outline-link:hover { background: #f0faf4; }
    .preflight-banner { text-align: center; margin-bottom: 24px; }
    .preflight-title { font-size: 20px; font-weight: 700; color: #111; margin-bottom: 8px; }
    .preflight-lead { color: #555; font-size: 14px; line-height: 1.5; }
    /* Success / Complete */
    .success-banner { text-align: center; margin-bottom: 24px; }
    .success-icon { font-size: 56px; margin-bottom: 12px; }
    .success-banner h1 { font-size: 24px; font-weight: 700; color: #111; }
    .success-banner p { color: #555; margin-top: 8px; font-size: 14px; }
    .page-complete .success-banner h1 { font-size: 22px; }
    .triggers-notice { margin-top: 12px; font-size: 13px; line-height: 1.55; text-align: left; }
    .triggers-notice-ok { color: #2e7d32; text-align: center; }
    .triggers-notice-warn {
      background: #fff8e1; border: 1px solid #ffe082; border-radius: 10px;
      padding: 12px 14px; color: #5d4037;
    }
    .triggers-notice-warn strong { display: block; margin-bottom: 6px; color: #e65100; }
    .triggers-notice-warn p { margin: 0; }
    /* URL Cards */
    .url-card {
      background: #f0faf4; border: 1.5px solid #06c755;
      border-radius: 12px; padding: 16px; margin-bottom: 16px;
    }
    .url-card.secondary { background: #f8f9fa; border-color: #dee2e6; }
    .url-label { font-size: 13px; font-weight: 600; color: #555; margin-bottom: 8px; }
    .url-value {
      font-family: 'Courier New', monospace; font-size: 13px;
      color: #111; word-break: break-all; background: #fff;
      border: 1px solid #e0e0e0; border-radius: 8px; padding: 10px 12px;
      margin-bottom: 8px; display: block;
    }
    .url-link {
      color: #0066cc; text-decoration: underline; cursor: pointer;
    }
    .url-link:hover { color: #004a99; }
    .url-note { font-size: 12px; color: #666; margin-top: 8px; }
    .url-card-actions { margin-top: 8px; }
    .copy-btn {
      background: #06c755; color: #fff; border: none; border-radius: 8px;
      padding: 8px 16px; font-size: 14px; cursor: pointer; font-weight: 600;
      transition: background 0.2s; min-height: 44px;
    }
    .copy-btn:hover { background: #05a548; }
    /* Next Steps */
    .next-steps { margin-top: 24px; }
    .next-steps h2 { font-size: 17px; font-weight: 700; color: #111; margin-bottom: 14px; }
    .cta-settings-box {
      background: #e8f5e9; border: 2px solid #4caf50; border-radius: 12px;
      padding: 16px; margin-bottom: 18px;
    }
    .cta-settings-lead { font-size: 13px; color: #555; line-height: 1.55; margin: 0 0 14px; }
    .manual-link { margin-top: 0; font-size: 12px; color: #555; line-height: 1.55; text-align: center; }
    .manual-link a { color: #0066cc; font-weight: 600; }
    .btn-open-settings { color: #fff; max-width: 100%; }
    .btn-open-settings:hover { color: #fff; }
    .page-complete .url-card { margin-bottom: 12px; }
    .page-complete .setup-notice { margin-bottom: 12px; }
    .auth-steps {
      margin: 14px 0 0; padding-left: 20px; font-size: 13px; color: #555; line-height: 1.65;
    }
    .steps-after {
      padding-left: 20px; display: flex; flex-direction: column; gap: 14px;
      font-size: 14px; color: #333; line-height: 1.55;
    }
    .steps-after li strong { display: block; color: #111; margin-bottom: 4px; }
    .steps-after li span { display: block; color: #555; font-size: 13px; }
    .liff-url-sample {
      display: block; margin-top: 8px; padding: 10px; background: #f8f9fa;
      border-radius: 8px; font-size: 11px; word-break: break-all; line-height: 1.5;
    }
    .complete-footer { margin-top: 16px; font-size: 12px; color: #888; text-align: center; }
    .next-steps ol { padding-left: 20px; display: flex; flex-direction: column; gap: 16px; }
    .next-steps li { font-size: 14px; color: #333; line-height: 1.6; }
    .next-steps li strong { display: block; color: #111; margin-bottom: 2px; }
    .next-steps a { color: #0066cc; }
    /* Error */
    .error-box {
      background: #fff5f5; border: 1.5px solid #f44336;
      border-radius: 12px; padding: 24px; text-align: center;
    }
    .error-box h2 { color: #d32f2f; margin-bottom: 12px; }
    .error-box p { color: #555; font-size: 14px; line-height: 1.6; margin-bottom: 16px; }
    .error-box a {
      display: inline-block; background: #d32f2f; color: #fff;
      padding: 10px 24px; border-radius: 8px; text-decoration: none; font-weight: 600;
    }
    @media (max-width: 480px) {
      body { padding: 8px; align-items: flex-start; padding-top: 10px; }
      .card { padding: 24px 16px; border-radius: 12px; }
      .card:has(.page-landing),
      .card:has(.page-complete),
      .card:has(.page-preflight) { padding: 18px 14px 16px; max-width: 100%; }
      .page-landing .hero h1 { font-size: 18px; }
      .page-landing .step-body strong { font-size: 12px; }
      .page-landing .btn-pill { padding: 12px 16px; font-size: 13px; min-height: 44px; }
      .page-landing .setup-notice p { font-size: 11px; }
      .page-complete .success-banner h1 { font-size: 19px; }
      .triggers-notice { font-size: 12px; }
      .url-value { font-size: 11px; padding: 8px 10px; }
      .copy-btn, .btn-open-settings { display: block; width: 100%; text-align: center; box-sizing: border-box; }
      .cta-settings-box { padding: 14px 12px; }
      .auth-steps, .steps-after { padding-left: 18px; }
      .preflight-title { font-size: 18px; }
    }
  </style>
</head>
<body>
  <div class="card">
    ${content}
  </div>
</body>
</html>`;
}

function handleInitialSetupManual() {
  const html = buildPage('初期導入マニュアル（準備中）', `
    <div style="max-width:700px;margin:0 auto;padding:2rem;line-height:1.8;color:#333;">
      <h1 style="font-size:1.5rem;border-bottom:2px solid #06c755;padding-bottom:.5rem;margin-bottom:1.5rem;">初期導入マニュアル（準備中）</h1>
      <p>このページは <strong>仮のマニュアルURL</strong> です。正式版の初期導入マニュアルは現在作成中です。</p>

      <h2 style="font-size:1.1rem;margin-top:2rem;">このマニュアルで案内予定の内容</h2>
      <ul style="padding-left:1.25rem;">
        <li>GoogleカレンダーID（予約カレンダー・店舗ブロックカレンダー）の取得方法</li>
        <li>LINE Developers でのチャネル設定
          <ul style="margin-top:8px;">
            <li>チャネルID</li>
            <li>チャネルシークレット</li>
            <li>チャネルアクセストークン（長期）</li>
            <li>LIFF ID</li>
            <li>Webhook URL の設定</li>
            <li>LIFF エンドポイントURL の設定</li>
          </ul>
        </li>
      </ul>

      <p style="margin-top:1.5rem;font-size:.9rem;color:#666;">正式版が公開されたら、システム管理者がマニュアルURLを差し替えます。</p>
      <p style="margin-top:2rem;font-size:.85rem;color:#999;">最終更新日：2026年6月19日（仮）</p>
      <p style="margin-top:1rem;"><a href="/" style="color:#06c755;">← トップページに戻る</a></p>
    </div>
  `);
  return htmlResponse(html);
}

function handlePrivacy() {
  const html = buildPage('プライバシーポリシー', `
    <div style="max-width:700px;margin:0 auto;padding:2rem;line-height:1.8;color:#333;">
      <h1 style="font-size:1.5rem;border-bottom:2px solid #06c755;padding-bottom:.5rem;margin-bottom:1.5rem;">プライバシーポリシー</h1>
      <p>本サービス「LINE予約システム」（以下「本サービス」）は、店舗向けのLINE連動型予約システムです。本ポリシーは、本サービスが収集・利用する情報について説明します。</p>

      <h2 style="font-size:1.1rem;margin-top:2rem;">1. 収集する情報</h2>
      <p>本サービスは、導入時にGoogleアカウントによる認証を行います。認証時に取得する情報は以下の通りです：</p>
      <ul>
        <li>Googleアカウントのメールアドレス（本人確認・管理者設定のため）</li>
        <li>Googleスプレッドシートへのアクセス権（初期設定データの書き込みのため）</li>
        <li>Google Apps Scriptへのアクセス権（バックエンドプログラムの自動設定・デプロイのため）</li>
      </ul>
      <p style="margin-top:8px;">※ Googleドライブへの広範なアクセス権は要求しません。スプレッドシートの自動作成はサーバー側の処理で行います。</p>

      <h2 style="font-size:1.1rem;margin-top:2rem;">2. 情報の利用目的</h2>
      <p>取得した情報は、お客様のシステム環境の自動構築のみに使用します。第三者への提供や広告目的での利用は行いません。</p>

      <h2 style="font-size:1.1rem;margin-top:2rem;">3. データの保管</h2>
      <p>認証情報（アクセストークン）は処理完了後に破棄されます。スプレッドシート等のデータはお客様自身のGoogleドライブに保管され、当サービス運営者はアクセスしません。</p>

      <h2 style="font-size:1.1rem;margin-top:2rem;">4. お問い合わせ</h2>
      <p>プライバシーに関するご質問は、サービス提供者までお問い合わせください。</p>

      <p style="margin-top:2rem;font-size:.85rem;color:#999;">最終更新日：2026年6月17日</p>
      <p style="margin-top:1rem;"><a href="/" style="color:#06c755;">← トップページに戻る</a></p>
    </div>
  `);
  return htmlResponse(html);
}

function renderError(message) {
  const html = buildPage('エラーが発生しました', `
    <div class="error-box">
      <h2>⚠️ エラーが発生しました</h2>
      <p>${message}</p>
      <a href="/">最初からやり直す</a>
    </div>
  `);
  return htmlResponse(html, 500);
}

function htmlResponse(html, status = 200) {
  return new Response(html, {
    status,
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  });
}

/**
 * LIFF（iOS Safari）向け ICS 配信。
 * script.google.com は Safari の Google ログイン状態で Drive エラーになるため、
 * workers.dev 上で text/calendar を inline 返却する。
 * GET /ics?d=<base64(utf8 ICS)>
 */
function handleIcsServe(url) {
  const encoded = url.searchParams.get('d');
  if (!encoded) {
    return new Response('ICS data missing', { status: 400, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
  }

  let icsContent;
  try {
    const binary = atob(encoded);
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    icsContent = new TextDecoder('utf-8').decode(bytes);
  } catch {
    return new Response('Invalid ICS data', { status: 400, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
  }

  if (!icsContent.includes('BEGIN:VCALENDAR')) {
    return new Response('Invalid ICS format', { status: 400, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
  }

  return new Response(icsContent, {
    status: 200,
    headers: {
      'Content-Type': 'text/calendar; charset=utf-8',
      'Content-Disposition': 'inline; filename="reservation.ics"',
      'Cache-Control': 'no-store',
    },
  });
}

function escapeHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
