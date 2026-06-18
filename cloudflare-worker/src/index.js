/**
 * LINE予約システム 自動オンボーディングサーバー
 * Cloudflare Workers で動作する OAuth 2.0 フローと GAS プロビジョニングを処理する。
 *
 * ルート:
 *   GET /          - ランディングページ（導入開始ボタン）
 *   GET /start     - Google OAuth 認可フロー開始
 *   GET /callback  - OAuth コールバック・プロビジョニング実行
 *   GET /complete  - 完了ページ（URLと次の手順を表示）
 */

const GOOGLE_AUTH_URL  = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const DRIVE_API        = 'https://www.googleapis.com/drive/v3';
const SHEETS_API       = 'https://sheets.googleapis.com/v4/spreadsheets';
const SCRIPT_API       = 'https://script.googleapis.com/v1';

// GAS デプロイに必要な OAuth スコープ
// Drive操作はサービスアカウントが行うため、ユーザーにはDriveスコープを要求しない
const OAUTH_SCOPES = [
  'https://www.googleapis.com/auth/spreadsheets',
  'https://www.googleapis.com/auth/script.projects',
  'https://www.googleapis.com/auth/script.deployments',
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
        case '/complete':           return handleComplete(url);
        case '/admin':              return handleAdmin(request, env);
        case '/admin/push-update':  return handlePushUpdate(request, env);
        case '/privacy':            return handlePrivacy();
        default:           return new Response('Not Found', { status: 404 });
      }
    } catch (err) {
      console.error('Unhandled error:', err);
      return renderError(`予期しないエラーが発生しました。<br><code>${escapeHtml(err.message)}</code>`);
    }
  },
};

// ============================================================
// 開発者用管理ページ（導入台帳 — 顧客データなし）
// ============================================================
async function handleAdmin(request, env) {
  // 簡易パスワード保護
  const url    = new URL(request.url);
  const secret = url.searchParams.get('key');
  if (!env.ADMIN_SECRET_KEY || secret !== env.ADMIN_SECRET_KEY) {
    return new Response('Unauthorized', { status: 401 });
  }

  // KVから全導入レコードを取得
  const list = await env.ONBOARDING_KV.list({ prefix: 'store:' });
  const records = await Promise.all(
    list.keys.map(async k => {
      const val = await env.ONBOARDING_KV.get(k.name);
      return val ? JSON.parse(val) : null;
    })
  );
  const valid = records.filter(Boolean).sort((a, b) =>
    new Date(b.onboardedAt) - new Date(a.onboardedAt)
  );

  const rows = valid.map(r => `
    <tr>
      <td>${escapeHtml(new Date(r.onboardedAt).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' }))}</td>
      <td><a href="${escapeHtml(r.ssUrl)}" target="_blank">${escapeHtml(r.ssId)}</a></td>
    </tr>
  `).join('');

  const html = buildPage('導入台帳（開発者用）', `
    <h2 style="margin-bottom:20px;">📋 導入台帳</h2>
    <p style="color:#666; font-size:13px; margin-bottom:16px;">
      ※ この画面にはスプレッドシートIDと導入日時のみ記録されています。顧客の予約・個人情報は含みません。
    </p>
    <table style="width:100%; border-collapse:collapse; font-size:14px;">
      <thead>
        <tr style="background:#f0f4f8;">
          <th style="padding:10px; text-align:left; border-bottom:2px solid #dee2e6;">導入日時</th>
          <th style="padding:10px; text-align:left; border-bottom:2px solid #dee2e6;">スプレッドシートID</th>
        </tr>
      </thead>
      <tbody>${rows || '<tr><td colspan="2" style="padding:20px; color:#999; text-align:center;">導入済み店舗はありません</td></tr>'}</tbody>
    </table>
    <p style="margin-top:20px; color:#999; font-size:12px;">合計: ${valid.length} 件</p>
  `);
  return htmlResponse(html);
}

// ============================================================
// ランディングページ
// ============================================================
function handleIndex(env) {
  const html = buildPage('LINE予約システム 導入ガイド', `
    <div class="hero">
      <div class="logo">📅</div>
      <h1>LINE予約システム</h1>
      <p class="subtitle">3ステップで導入完了</p>
    </div>

    <div class="steps">
      <div class="step">
        <div class="step-num">1</div>
        <div class="step-body">
          <strong>Googleアカウントでログイン</strong>
          <span>スプレッドシートとスクリプトの作成権限を許可します</span>
        </div>
      </div>
      <div class="step">
        <div class="step-num">2</div>
        <div class="step-body">
          <strong>自動セットアップ（約30秒）</strong>
          <span>スプレッドシート・GASプロジェクト・デプロイを自動作成します</span>
        </div>
      </div>
      <div class="step">
        <div class="step-num">3</div>
        <div class="step-body">
          <strong>LINE DevelopersにURLを設定</strong>
          <span>発行されたURLを2箇所に貼り付けるだけで完了です</span>
        </div>
      </div>
    </div>

    <div class="cta-area">
      <a href="/start" class="btn-start">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4"/>
          <polyline points="10 17 15 12 10 7"/>
          <line x1="15" y1="12" x2="3" y2="12"/>
        </svg>
        Googleアカウントで導入開始
      </a>
      <p class="note">※ Googleドライブにスプレッドシートとスクリプトが作成されます</p>
    </div>
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

  // プログレス画面を先に返し、裏でプロビジョニングを実行
  // → Workers の waitUntil を使って非同期実行
  // ただし Worker は streaming response が限定的なので、同期的に進捗表示なしで実行する
  const progressHtml = buildPage('セットアップ中...', `
    <div style="text-align:center; padding: 60px 20px;">
      <div class="spinner"></div>
      <h2 style="margin-top:24px; color:#333;">セットアップ中です...</h2>
      <p style="color:#666; margin-top:8px;">スプレッドシートとGASプロジェクトを自動作成しています。<br>このまましばらくお待ちください（約30秒）。</p>
    </div>
    <style>
      .spinner { width:56px; height:56px; border:5px solid #e0e0e0; border-top-color:#06c755;
                 border-radius:50%; animation:spin 1s linear infinite; margin:0 auto; }
      @keyframes spin { to { transform:rotate(360deg); } }
    </style>
    <script>
      // トークン交換とプロビジョニングは別リクエストで実行させるため、
      // このページからAPI呼び出しを行う
      (async () => {
        try {
          const res = await fetch('/provision', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ code: ${JSON.stringify(code)}, state: ${JSON.stringify(state)} })
          });
          const data = await res.json();
          if (data.error) throw new Error(data.error);
          const params = new URLSearchParams({
            deployUrl: data.deployUrl,
            ssUrl:     data.ssUrl,
            gasUrl:    data.gasUrl,
          });
          location.href = '/complete?' + params;
        } catch(e) {
          document.body.innerHTML = '<div style="text-align:center;padding:60px;color:#d32f2f;font-size:16px;">エラーが発生しました: ' + e.message + '<br><br><a href="/">最初からやり直す</a></div>';
        }
      })();
    </script>
  `);

  // 実際はシンプルに同期実行してリダイレクトする方式に変更
  // (Workers Streaming の制限を回避)
  let result;
  try {
    const tokens = await exchangeCodeForTokens(code, env);
    if (!tokens.access_token) {
      throw new Error(`トークン取得失敗: ${JSON.stringify(tokens.error || tokens)}`);
    }
    // id_token（JWT）からメール取得 → 失敗時はuserinfo APIにフォールバック
    const userEmail = getEmailFromIdToken(tokens.id_token) || await getUserEmail(tokens.access_token);
    console.log('onboarding userEmail:', userEmail);
    result = await provision(tokens.access_token, tokens.refresh_token, env, userEmail);
  } catch (err) {
    console.error('Provision error:', err);
    return renderError(`セットアップ中にエラーが発生しました。<br><code>${escapeHtml(err.message)}</code><br><br>
      もう一度 <a href="/">最初から</a> お試しください。`);
  }

  const params = new URLSearchParams({
    deployUrl: result.deployUrl,
    ssUrl:     result.ssUrl,
    gasUrl:    result.gasUrl,
  });
  return Response.redirect(`${env.WORKER_URL}/complete?${params}`, 302);
}

// ============================================================
// 完了ページ
// ============================================================
function handleComplete(url) {
  const deployUrl = url.searchParams.get('deployUrl') || '';
  const gasUrl    = url.searchParams.get('gasUrl')    || '';

  const html = buildPage('セットアップ完了！', `
    <div class="success-banner">
      <div class="success-icon">✅</div>
      <h1>セットアップ完了！</h1>
      <p>システムの自動構築が完了しました。</p>
    </div>

    <div class="url-card">
      <div class="url-label">🌐 システムURL（大切に保管してください）</div>
      <a class="url-value url-link" id="deployUrl" href="${escapeHtml(deployUrl)}" target="_blank" rel="noopener noreferrer">${escapeHtml(deployUrl)}</a>
      <button class="copy-btn" onclick="copyUrl(this)">コピー</button>
      <p class="url-note">⚠️ このURLが予約システムの入口です。必ずブックマークしてください。</p>
    </div>

    <div class="next-steps">
      <h2>📋 次の手順</h2>

      <div style="background:#e8f5e9; border:2px solid #4caf50; border-radius:12px; padding:20px; margin-bottom:20px;">
        <p style="font-size:15px; font-weight:700; margin:0 0 16px;">設定画面を開いて初期設定を行ってください</p>
        <a href="${escapeHtml(deployUrl)}" target="_blank" rel="noopener noreferrer"
           style="display:inline-block; background:#4caf50; color:#fff; font-size:15px; font-weight:700;
                  padding:12px 28px; border-radius:8px; text-decoration:none;">
          設定画面を開く →
        </a>
        <p style="margin:16px 0 0; color:#555; font-size:14px; line-height:1.6;">
          Googleの権限確認ダイアログが表示されたら <strong>「許可」</strong> をクリックしてください。
        </p>
      </div>

      <ol style="line-height:1.9; padding-left:20px;">
        <li style="margin-bottom:14px;">
          <strong>設定画面で初期設定を入力して保存</strong><br>
          <span style="color:#555; font-size:14px;">店舗名・営業時間・サービスメニュー・担当者・LINEトークンなどを入力</span>
        </li>
        <li style="margin-bottom:14px;">
          <strong>LINE Developers → Messaging API → Webhook URL にシステムURLを貼り付けて「検証」</strong>
        </li>
        <li>
          <strong>LINE Developers → LIFFアプリ → エンドポイントURL にシステムURLを貼り付けて保存</strong>
        </li>
      </ol>
    </div>

    <details style="margin-top:20px; padding:14px; background:#f5f5f5; border-radius:8px; font-size:13px; color:#666;">
      <summary style="cursor:pointer; font-weight:600; color:#555;">問題が発生した場合</summary>
      <div style="margin-top:12px; line-height:1.8;">
        システム開発者にお問い合わせください。
      </div>
    </details>

    <script>
      function copyUrl(btn) {
        navigator.clipboard.writeText(${JSON.stringify(deployUrl)}).then(() => {
          btn.textContent = 'コピーしました！';
          btn.style.background = '#388e3c';
          setTimeout(() => { btn.textContent = 'コピー'; btn.style.background = ''; }, 2000);
        });
      }
    </script>
  `);
  return htmlResponse(html);
}

// ============================================================
// トークン交換
// ============================================================
async function exchangeCodeForTokens(code, env) {
  const res = await fetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id:     env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      redirect_uri:  `${env.WORKER_URL}/callback`,
      grant_type:    'authorization_code',
    }),
  });
  return res.json();
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
  const files = await fetchAndPrepareFiles(ssId, env);

  // Step 4: GASプロジェクトにコンテンツをプッシュ
  console.log('Step 4: Pushing content to GAS project...');
  const content = await callApi(
    `${SCRIPT_API}/projects/${scriptId}/content`,
    'PUT',
    userAuth,
    { files }
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
  await env.ONBOARDING_KV.put(
    `store:${ssId}`,
    JSON.stringify(onboardingRecord),
    { expirationTtl: 60 * 60 * 24 * 365 * 3 }
  );

  console.log('Provisioning complete!', { ssId, scriptId, deployUrl });
  return { deployUrl, ssUrl, gasUrl };
}

// ============================================================
// テンプレートSSから全シートをコピーしてシート名を整理する
// テンプレートは「リンクを知っている全員が編集可」に設定しておくこと
// ============================================================
async function copySheetsFromTemplate(destSsId, userAuth, env) {
  const templateId = env.TEMPLATE_SS_ID;

  // テンプレートのシート一覧を取得
  const templateRes = await fetch(
    `${SHEETS_API}/${templateId}?fields=sheets.properties`,
    { headers: { Authorization: userAuth } }
  );
  const templateData = await templateRes.json();
  if (templateData.error) {
    throw new Error(`テンプレート読み込み失敗: ${templateData.error.message} — テンプレートSSが「リンクを知っている全員が編集可」に設定されているか確認してください`);
  }
  const templateSheets = templateData.sheets || [];

  // コピー先SSのデフォルトシートID（後で削除する）
  const destRes = await fetch(
    `${SHEETS_API}/${destSsId}?fields=sheets.properties`,
    { headers: { Authorization: userAuth } }
  );
  const destData = await destRes.json();
  if (destData.error) throw new Error(`コピー先SS読み込み失敗: ${destData.error.message}`);
  const defaultSheetId = destData.sheets?.[0]?.properties?.sheetId;

  // テンプレートの各シートをコピー先SSにコピー
  const copiedSheets = [];
  for (const sheet of templateSheets) {
    const res = await fetch(
      `${SHEETS_API}/${templateId}/sheets/${sheet.properties.sheetId}:copyTo`,
      {
        method: 'POST',
        headers: { Authorization: userAuth, 'Content-Type': 'application/json' },
        body: JSON.stringify({ destinationSpreadsheetId: destSsId }),
      }
    );
    const data = await res.json();
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

  const batchRes = await fetch(
    `${SHEETS_API}/${destSsId}:batchUpdate`,
    {
      method: 'POST',
      headers: { Authorization: userAuth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ requests }),
    }
  );
  const batchData = await batchRes.json();
  if (batchData.error) throw new Error(`シート整理失敗: ${batchData.error.message}`);
  console.log(`Copied ${copiedSheets.length} sheets from template.`);
}

// ============================================================
// Configシートの指定キーに値を書き込む汎用関数
// ============================================================
async function writeConfigValue(spreadsheetId, authHeader, key, value) {
  // まずConfigシートのA列（キー列）を取得して該当キーの行番号を探す
  const rangeRes = await fetch(
    `${SHEETS_API}/${spreadsheetId}/values/Config!A:A`,
    { headers: { Authorization: authHeader } }
  );
  const rangeData = await rangeRes.json();
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
  const updateRes = await fetch(
    `${SHEETS_API}/${spreadsheetId}/values/${encodeURIComponent(targetRange)}?valueInputOption=RAW`,
    {
      method: 'PUT',
      headers: { Authorization: authHeader, 'Content-Type': 'application/json' },
      body: JSON.stringify({ values: [[value]] }),
    }
  );
  const updateData = await updateRes.json();
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
async function getServiceAccountToken(env) {
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
    scope: 'https://www.googleapis.com/auth/drive',
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
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion:  jwt,
    }),
  });
  const data = await res.json();
  if (!data.access_token) {
    throw new Error(`サービスアカウントトークン取得失敗: ${JSON.stringify(data.error || data)}`);
  }
  return data.access_token;
}

// ============================================================
// refresh_token を使って新しい access_token を取得
// ============================================================
async function refreshAccessToken(refreshToken, env) {
  const res = await fetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id:     env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      refresh_token: refreshToken,
      grant_type:    'refresh_token',
    }),
  });
  return res.json();
}

// ============================================================
// 管理者: 全顧客の GAS プロジェクトに最新コードを配信
// GET /admin/push-update?key=<ADMIN_SECRET_KEY>
// ============================================================
async function handlePushUpdate(request, env) {
  const url    = new URL(request.url);
  const secret = url.searchParams.get('key');
  if (!env.ADMIN_SECRET_KEY || secret !== env.ADMIN_SECRET_KEY) {
    return new Response('Unauthorized', { status: 401 });
  }

  // KVから全導入レコードを取得
  const list    = await env.ONBOARDING_KV.list({ prefix: 'store:' });
  const results = [];

  for (const kvKey of list.keys) {
    const raw    = await env.ONBOARDING_KV.get(kvKey.name);
    const record = raw ? JSON.parse(raw) : null;
    if (!record) continue;

    const { ssId, scriptId, deploymentId, refreshToken } = record;

    // 古いレコード（refreshToken/scriptId未保存）はスキップ
    if (!refreshToken || !scriptId || !deploymentId) {
      results.push({ ssId, status: 'skipped', reason: 'refreshToken/scriptId/deploymentId 未保存（再オンボーディングが必要）' });
      continue;
    }

    try {
      // アクセストークンをリフレッシュ
      const tokens = await refreshAccessToken(refreshToken, env);
      if (!tokens.access_token) {
        throw new Error(`トークンリフレッシュ失敗: ${JSON.stringify(tokens.error || tokens)}`);
      }
      const auth = `Bearer ${tokens.access_token}`;

      // refresh_token がローテーションされた場合はKVを更新
      if (tokens.refresh_token && tokens.refresh_token !== refreshToken) {
        record.refreshToken = tokens.refresh_token;
        await env.ONBOARDING_KV.put(kvKey.name, JSON.stringify(record), { expirationTtl: 60 * 60 * 24 * 365 * 3 });
      }

      // 最新コードを GitHub から取得
      const files = await fetchAndPrepareFiles(ssId, env);

      // GAS プロジェクトにコンテンツをプッシュ
      const content = await callApi(`${SCRIPT_API}/projects/${scriptId}/content`, 'PUT', auth, { files });
      if (content.error) throw new Error(`content push 失敗: ${content.error.message}`);

      // 新バージョン作成
      const version = await callApi(`${SCRIPT_API}/projects/${scriptId}/versions`, 'POST', auth, {
        description: `管理者プッシュ更新 ${new Date().toISOString()}`,
      });
      if (version.error) throw new Error(`version 作成失敗: ${version.error.message}`);

      // 既存デプロイを新バージョンに更新（URLは変わらない）
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

      results.push({ ssId, status: 'success', versionNumber: version.versionNumber });
    } catch (err) {
      console.error(`push-update error for ${ssId}:`, err.message);
      results.push({ ssId, status: 'error', reason: err.message });
    }
  }

  const successCount = results.filter(r => r.status === 'success').length;
  const skipCount    = results.filter(r => r.status === 'skipped').length;
  const errorCount   = results.filter(r => r.status === 'error').length;

  const html = buildPage('コード更新配信結果', `
    <h2 style="margin-bottom:20px;">🚀 コード更新配信結果</h2>
    <p style="margin-bottom:16px; color:#555;">
      成功: <strong style="color:#06c755;">${successCount}</strong> 件 ／
      スキップ: <strong style="color:#999;">${skipCount}</strong> 件 ／
      エラー: <strong style="color:#d32f2f;">${errorCount}</strong> 件
    </p>
    <table style="width:100%; border-collapse:collapse; font-size:13px;">
      <thead>
        <tr style="background:#f0f4f8;">
          <th style="padding:8px; text-align:left; border-bottom:2px solid #dee2e6;">スプレッドシートID</th>
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
              ${escapeHtml(r.reason || (r.status === 'success' ? `v${r.versionNumber} にデプロイ済み` : ''))}
            </td>
          </tr>
        `).join('')}
      </tbody>
    </table>
    <p style="margin-top:20px; color:#999; font-size:12px;">実行日時: ${new Date().toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' })}</p>
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

// GitHubからスクリプトファイルを取得し、スプレッドシートIDを埋め込む
// ============================================================
async function fetchAndPrepareFiles(spreadsheetId, env) {
  const repo   = env.GITHUB_REPO;   // e.g. "tomimorisystems4150-ai/reservation-liff-app"
  const branch = env.GITHUB_BRANCH || 'main';
  const base   = `https://raw.githubusercontent.com/${repo}/${branch}`;

  const files = await Promise.all(
    SCRIPT_FILES_META.map(async ({ name, type, file }) => {
      const res = await fetch(`${base}/${file}`);
      if (!res.ok) throw new Error(`GitHubからのファイル取得失敗: ${file} (${res.status})`);
      let source = await res.text();

      // Code.js のプレースホルダーを実際のスプレッドシートIDで置換
      if (file === 'Code.js') {
        source = source.replace(/PLACEHOLDER_SPREADSHEET_ID/g, spreadsheetId);
      }

      return { name, type, source };
    })
  );
  return files;
}

// ============================================================
// 汎用 API 呼び出しヘルパー
// ============================================================
async function callApi(url, method, authHeader, body) {
  const res = await fetch(url, {
    method,
    headers: {
      'Authorization': authHeader,
      'Content-Type':  'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  return res.json();
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
      padding: 20px;
    }
    .card {
      background: #fff;
      border-radius: 16px;
      box-shadow: 0 4px 24px rgba(0,0,0,0.10);
      padding: 48px 40px;
      max-width: 640px;
      width: 100%;
    }
    /* Hero */
    .hero { text-align: center; margin-bottom: 40px; }
    .logo { font-size: 56px; margin-bottom: 12px; }
    .hero h1 { font-size: 28px; font-weight: 700; color: #111; }
    .subtitle { color: #666; margin-top: 6px; font-size: 15px; }
    /* Steps */
    .steps { display: flex; flex-direction: column; gap: 16px; margin-bottom: 40px; }
    .step { display: flex; align-items: flex-start; gap: 16px; }
    .step-num {
      width: 36px; height: 36px; border-radius: 50%;
      background: #06c755; color: #fff;
      font-weight: 700; font-size: 16px;
      display: flex; align-items: center; justify-content: center;
      flex-shrink: 0;
    }
    .step-body { display: flex; flex-direction: column; gap: 2px; padding-top: 6px; }
    .step-body strong { font-size: 15px; color: #111; }
    .step-body span { font-size: 13px; color: #666; }
    /* CTA */
    .cta-area { text-align: center; }
    .btn-start {
      display: inline-flex; align-items: center; gap: 10px;
      background: #06c755; color: #fff;
      padding: 16px 32px; border-radius: 50px;
      font-size: 16px; font-weight: 700;
      text-decoration: none;
      transition: background 0.2s, transform 0.1s;
    }
    .btn-start:hover { background: #05a548; transform: translateY(-1px); }
    .note { color: #999; font-size: 12px; margin-top: 12px; }
    /* Success */
    .success-banner { text-align: center; margin-bottom: 36px; }
    .success-icon { font-size: 56px; margin-bottom: 12px; }
    .success-banner h1 { font-size: 26px; font-weight: 700; color: #111; }
    .success-banner p { color: #555; margin-top: 8px; }
    /* URL Cards */
    .url-card {
      background: #f0faf4; border: 1.5px solid #06c755;
      border-radius: 12px; padding: 20px; margin-bottom: 16px; position: relative;
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
    .url-note { font-size: 12px; color: #666; }
    .copy-btn {
      background: #06c755; color: #fff; border: none; border-radius: 6px;
      padding: 6px 14px; font-size: 13px; cursor: pointer; font-weight: 600;
      transition: background 0.2s;
    }
    .copy-btn:hover { background: #05a548; }
    /* Next Steps */
    .next-steps { margin-top: 32px; }
    .next-steps h2 { font-size: 18px; font-weight: 700; color: #111; margin-bottom: 16px; }
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
      .card { padding: 32px 20px; }
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

function escapeHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
