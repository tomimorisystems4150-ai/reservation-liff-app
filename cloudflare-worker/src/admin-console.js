/**
 * デプロイ支援コンソール（Web GUI）
 * /admin — 顧客一覧・コード配信・サービス停止をブラウザから操作
 */

import {
  readCustomerRegistry,
  updateRegistryStatus,
  PAYMENT_STATUSES,
  SERVICE_STATUSES,
} from './customer-registry.js';

/** 開発者が検証に使うテスト店舗（本番顧客の ssId はリンク化しない） */
export const TEST_SS_ID = '1yhFUHB-krCKEovh8MbxQeKx_Vo7s1QUCaMeeBlAaj1w';

const SHEETS_API = 'https://sheets.googleapis.com/v4/spreadsheets';

export function verifyAdminKey(request, env) {
  /** @deprecated URL の ?key= は廃止。admin-auth.js のセッション Cookie を使用 */
  const url = new URL(request.url);
  const secret = url.searchParams.get('key');
  if (!env.ADMIN_SECRET_KEY || secret !== env.ADMIN_SECRET_KEY) {
    return null;
  }
  return secret;
}

const DRIVE_API = 'https://www.googleapis.com/drive/v3';

/** スプレッドシートが Drive 上に存在するか（削除済み ssId を除外するため） */
export async function isSpreadsheetAvailable(env, getSaToken, ssId) {
  if (!ssId) return false;
  try {
    const token = await getSaToken('https://www.googleapis.com/auth/drive.readonly');
    const res = await fetch(
      `${DRIVE_API}/files/${encodeURIComponent(ssId)}?fields=id,trashed`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    if (res.status === 404) return false;
    if (!res.ok) return true;
    const data = await res.json();
    return !!(data.id && !data.trashed);
  } catch {
    return true;
  }
}

export async function fetchAdminCustomers(env, kvMap, getSaToken) {
  let registry = [];
  let registryError = null;
  let kvOrphanCount = 0;
  const registryConfigured = !!env.CUSTOMER_REGISTRY_SS_ID;

  if (registryConfigured) {
    try {
      registry = await readCustomerRegistry(env, getSaToken);
    } catch (e) {
      registryError = e.message;
    }
  }

  let displayRows;

  if (registryConfigured) {
    // 顧客台帳が正。台帳に無い ssId は表示しない（KV に残っていても非表示）
    displayRows = registry;
  } else {
    // 台帳未設定時のみ KV を参照し、削除済みスプレッドシートは除外
    displayRows = [];
    for (const [ssId, rec] of Object.entries(kvMap)) {
      const available = await isSpreadsheetAvailable(env, getSaToken, ssId);
      if (!available) {
        kvOrphanCount++;
        continue;
      }
      displayRows.push({
        ssId,
        shopName: '',
        adminEmail: rec.adminEmail || '',
        onboardedAt: rec.onboardedAt || '',
        paymentStatus: '台帳未設定',
        serviceStatus: '台帳未設定',
        deployUrl: '',
        scriptId: rec.scriptId || '',
        paymentMemo: '（顧客台帳未設定）',
      });
    }
  }

  const customers = displayRows.map(r => {
    const kv = kvMap[r.ssId];
    const deployUrl = resolveDeployUrl(r, kv);
    const pushReady = !!(kv && kv.refreshToken && kv.scriptId && kv.deploymentId);
    return {
      ssId: r.ssId,
      adminEmail: r.adminEmail || kv?.adminEmail || '',
      onboardedAt: r.onboardedAt || '',
      paymentStatus: r.paymentStatus || (registryConfigured ? '—' : '台帳未設定'),
      serviceStatus: r.serviceStatus || (registryConfigured ? '—' : '台帳未設定'),
      deployUrl,
      scriptId: r.scriptId || kv?.scriptId || '',
      paymentMemo: r.paymentMemo || '',
      pushReady,
      pushReason: pushReady ? '' : 'refreshToken/scriptId/deploymentId 未保存（再オンボーディングが必要）',
    };
  });

  for (const c of customers) {
    if (c.adminEmail) continue;
    const fromConfig = await readSpreadsheetConfigValue(env, getSaToken, c.ssId, 'adminEmail');
    if (fromConfig) c.adminEmail = fromConfig;
  }

  return { customers, registryError, kvOrphanCount, registryConfigured };
}

function buildLiffPagesBase(env) {
  const repo = env.GITHUB_REPO || 'tomimorisystems4150-ai/reservation-liff-app';
  const [owner, name] = repo.split('/');
  return `https://${owner}.github.io/${name}`;
}

/** 顧客台帳 / KV から GAS デプロイ URL を解決 */
export function resolveDeployUrl(registryRow, kvRecord) {
  if (registryRow?.deployUrl) return registryRow.deployUrl.trim();
  if (kvRecord?.deployUrl) return String(kvRecord.deployUrl).trim();
  if (kvRecord?.deploymentId) {
    return `https://script.google.com/macros/s/${kvRecord.deploymentId}/exec`;
  }
  return '';
}

async function readLiffIdFromConfig(env, getSaToken, ssId) {
  const fromChannel = await readSpreadsheetConfigValue(env, getSaToken, ssId, 'liffChannelId');
  if (fromChannel) return fromChannel;
  return readSpreadsheetConfigValue(env, getSaToken, ssId, 'liffId');
}

async function readSpreadsheetConfigValue(env, getSaToken, ssId, key) {
  try {
    const token = await getSaToken('https://www.googleapis.com/auth/spreadsheets.readonly');
    const res = await fetch(
      `${SHEETS_API}/${encodeURIComponent(ssId)}/values/${encodeURIComponent('Config!A:B')}`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    if (!res.ok) return null;
    const data = await res.json();
    for (const row of data.values || []) {
      if (String(row[0] || '').trim() === key) {
        return String(row[1] || '').trim() || null;
      }
    }
    return null;
  } catch {
    return null;
  }
}

/** テスト環境のプレビュー URL（予約 LIFF / 管理画面 / SS）を解決 */
export async function resolveTestEnvContext(env, customers, kvMap, getSaToken) {
  const customer = customers.find(c => c.ssId === TEST_SS_ID);
  const kv = kvMap[TEST_SS_ID];
  const deployUrl = resolveDeployUrl(customer, kv);
  let adminEmail = customer?.adminEmail || kv?.adminEmail || '';
  if (!adminEmail) {
    const fromConfig = await readSpreadsheetConfigValue(env, getSaToken, TEST_SS_ID, 'adminEmail');
    if (fromConfig) adminEmail = fromConfig;
  }
  const spreadsheetUrl = `https://docs.google.com/spreadsheets/d/${TEST_SS_ID}/edit`;
  const settingsUrl = deployUrl || '';

  const missing = [];
  if (!deployUrl) missing.push('GASデプロイURL（KVに deploymentId なし）');

  let liffId = null;
  if (deployUrl) {
    liffId = await readLiffIdFromConfig(env, getSaToken, TEST_SS_ID);
    if (!liffId) missing.push('Config.liffChannelId（LIFF ID）');
  }

  const liffBase = `${buildLiffPagesBase(env)}/liff.html`;
  const liffUrl = deployUrl && liffId
    ? `${liffBase}?gasApiUrl=${encodeURIComponent(deployUrl)}&liffId=${encodeURIComponent(liffId)}`
    : '';
  const kanriUrl = deployUrl
    ? `${deployUrl}${deployUrl.includes('?') ? '&' : '?'}page=kanri`
    : '';

  return {
    ssId: TEST_SS_ID,
    adminEmail,
    deployUrl,
    settingsUrl,
    liffUrl,
    kanriUrl,
    spreadsheetUrl,
    ready: !!(liffUrl && kanriUrl),
    missing,
  };
}

/**
 * push-update コア処理（GUI / 旧URL 両方から利用）
 */
export async function executePushUpdate(env, deps, options) {
  const { ssIds, includeStopped = false, allActive = false, includeTests = false } = options;
  const { getSaToken, fetchRawFiles, pushCodeToCustomer, syncServiceSuspendedToCustomer, kvGet, kvList } = deps;

  const kvListResult = await kvList();
  let targets = [];

  if (env.CUSTOMER_REGISTRY_SS_ID) {
    let registry = await readCustomerRegistry(env, getSaToken);
    if (ssIds && ssIds.length > 0) {
      registry = registry.filter(r => ssIds.includes(r.ssId));
    } else if (!includeStopped) {
      registry = registry.filter(r => r.serviceStatus !== '停止');
    }
    targets = registry.map(r => ({ ssId: r.ssId, registry: r }));
  } else {
    for (const kvKey of kvListResult.keys) {
      const ssId = kvKey.name.replace(/^store:/, '');
      if (ssIds?.length && !ssIds.includes(ssId)) continue;
      targets.push({ ssId, registry: null });
    }
  }

  let targetDesc = '稼働中の全顧客';
  if (ssIds?.length === 1) targetDesc = `ssId=${ssIds[0]}`;
  else if (ssIds?.length > 1) targetDesc = `${ssIds.length} 件を選択`;
  else if (includeStopped) targetDesc = '全顧客（停止中含む）';
  else if (allActive) targetDesc = '稼働中の全顧客';

  if (targets.length === 0) {
    return {
      targetDesc,
      results: [],
      successCount: 0,
      skipCount: 0,
      errorCount: 0,
    };
  }

  const rawFiles = await fetchRawFiles(env, { includeTests });
  const results = [];

  for (const target of targets) {
    const { ssId, registry } = target;
    const kvRaw = await kvGet(`store:${ssId}`);
    const kvRecord = kvRaw ? JSON.parse(kvRaw) : null;

    if (!kvRecord) {
      results.push({ ssId, status: 'skipped', reason: 'KVに導入記録なし（再オンボーディングが必要）' });
      continue;
    }

    try {
      const pushResult = await pushCodeToCustomer(ssId, kvRecord, rawFiles, env);

      if (registry?.serviceStatus) {
        try {
          await syncServiceSuspendedToCustomer(ssId, registry.serviceStatus, kvRecord, env);
        } catch (syncErr) {
          pushResult.configSyncWarning = syncErr.message;
        }
      }

      results.push(pushResult);
    } catch (err) {
      results.push({ ssId, status: 'error', reason: err.message });
    }
  }

  return {
    targetDesc,
    results,
    successCount: results.filter(r => r.status === 'success').length,
    skipCount: results.filter(r => r.status === 'skipped').length,
    errorCount: results.filter(r => r.status === 'error').length,
  };
}

export async function executeSetStatus(env, deps, { ssId, serviceStatus, paymentStatus }) {
  const { getSaToken, syncServiceSuspendedToCustomer, kvGet, kvPut } = deps;

  if (!env.CUSTOMER_REGISTRY_SS_ID) {
    throw new Error('CUSTOMER_REGISTRY_SS_ID が未設定です。');
  }

  const updates = {};
  if (serviceStatus) updates.serviceStatus = serviceStatus;
  if (paymentStatus) updates.paymentStatus = paymentStatus;
  if (!Object.keys(updates).length) {
    throw new Error('serviceStatus または paymentStatus を指定してください。');
  }

  const updated = await updateRegistryStatus(env, getSaToken, ssId, updates);

  const kvRaw = await kvGet(`store:${ssId}`);
  const kvRecord = kvRaw ? JSON.parse(kvRaw) : null;
  let configSync = 'スキップ（KVなし）';

  if (serviceStatus && kvRecord) {
    await syncServiceSuspendedToCustomer(ssId, serviceStatus, kvRecord, env);
    configSync = 'Config.serviceSuspended を同期しました';
  }

  return { updated, configSync };
}

export function jsonResponse(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
}

export async function handleAdminApiPush(request, env, deps) {
  if (request.method !== 'POST') {
    return jsonResponse({ success: false, message: 'POST のみ対応' }, 405);
  }

  let body = {};
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ success: false, message: 'JSON ボディが必要です' }, 400);
  }

  const ssIds = Array.isArray(body.ssIds) ? body.ssIds.filter(Boolean) : null;
  const includeStopped = !!body.includeStopped;
  const includeTests = !!body.includeTests;

  try {
    const data = await executePushUpdate(env, deps, { ssIds, includeStopped, allActive: !ssIds?.length, includeTests });
    return jsonResponse({ success: true, ...data });
  } catch (err) {
    return jsonResponse({ success: false, message: err.message }, 500);
  }
}

export async function handleAdminApiSetStatus(request, env, deps) {
  if (request.method !== 'POST') {
    return jsonResponse({ success: false, message: 'POST のみ対応' }, 405);
  }

  let body = {};
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ success: false, message: 'JSON ボディが必要です' }, 400);
  }

  if (!body.ssId) {
    return jsonResponse({ success: false, message: 'ssId が必要です' }, 400);
  }

  try {
    const data = await executeSetStatus(env, deps, {
      ssId: body.ssId,
      serviceStatus: body.serviceStatus || null,
      paymentStatus: body.paymentStatus || null,
    });
    return jsonResponse({ success: true, ...data });
  } catch (err) {
    return jsonResponse({ success: false, message: err.message }, 500);
  }
}

export function renderAdminConsole(env, adminUser, { customers, registryError, kvOrphanCount = 0, registryConfigured = false, testEnv = null }) {
  const registryUrl = env.CUSTOMER_REGISTRY_SS_ID
    ? `https://docs.google.com/spreadsheets/d/${env.CUSTOMER_REGISTRY_SS_ID}/edit`
    : '';
  const repo = env.GITHUB_REPO || '（未設定）';
  const branch = env.GITHUB_BRANCH || 'main';
  const customersJson = JSON.stringify(customers);
  const adminEmailLabel = adminUser?.email ? escapeHtml(adminUser.email) : '';
  const test = testEnv || {
    ssId: TEST_SS_ID,
    adminEmail: '',
    deployUrl: '',
    settingsUrl: '',
    liffUrl: '',
    kanriUrl: '',
    spreadsheetUrl: `https://docs.google.com/spreadsheets/d/${TEST_SS_ID}/edit`,
    ready: false,
    missing: ['GASデプロイURL'],
  };
  const testMissingHint = test.missing?.length
    ? `<p class="side-hint test-warn">未設定: ${escapeHtml(test.missing.join(' / '))}（settings.html または台帳を確認）</p>`
    : '';

  return `<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>デプロイ支援コンソール | LINE予約システム</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #eef2f7; color: #1a1a2e; font-size: 14px; line-height: 1.5; }
    .topbar { background: #2c3e50; color: #fff; padding: 14px 24px; display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 10px; }
    .topbar h1 { font-size: 1.15em; font-weight: 700; }
    .topbar-sub { font-size: 0.82em; opacity: 0.75; }
    .btn-logout { color: #fff; font-size: 0.78em; opacity: 0.85; text-decoration: none; border: 1px solid rgba(255,255,255,0.35); padding: 4px 10px; border-radius: 6px; }
    .btn-logout:hover { opacity: 1; }
    .wrap { max-width: 1100px; margin: 0 auto; padding: 20px 16px 48px; }
    .grid { display: grid; grid-template-columns: 1fr; gap: 16px; }
    @media (min-width: 900px) { .grid { grid-template-columns: 340px 1fr; } }
    .panel { background: #fff; border-radius: 12px; box-shadow: 0 2px 12px rgba(0,0,0,0.06); padding: 18px 20px; }
    .panel h2 { font-size: 0.95em; font-weight: 700; color: #2c3e50; margin-bottom: 14px; padding-bottom: 10px; border-bottom: 1px solid #eef0f3; }
    .step-list { list-style: none; counter-reset: step; }
    .step-list li { counter-increment: step; position: relative; padding-left: 32px; margin-bottom: 14px; font-size: 0.88em; color: #555; }
    .step-list li::before { content: counter(step); position: absolute; left: 0; top: 0; width: 22px; height: 22px; background: #3498db; color: #fff; border-radius: 50%; font-size: 11px; font-weight: 700; display: flex; align-items: center; justify-content: center; }
    .step-list strong { display: block; color: #222; margin-bottom: 2px; }
    .meta-box { background: #f8f9fa; border-radius: 8px; padding: 10px 12px; font-size: 0.8em; color: #666; margin-top: 12px; word-break: break-all; }
    .cmd-block { margin-top: 14px; }
    .cmd-block-label { font-size: 0.75em; font-weight: 700; color: #888; text-transform: uppercase; letter-spacing: 0.04em; margin-bottom: 6px; }
    .cmd-row { display: flex; align-items: center; gap: 6px; margin-bottom: 6px; }
    .cmd-row code { flex: 1; background: #1e2533; color: #a8d8a8; font-family: 'Consolas','Menlo',monospace; font-size: 0.78em; padding: 7px 10px; border-radius: 6px; word-break: break-all; line-height: 1.5; }
    .cmd-row .cmd-comment { display: block; font-size: 0.72em; color: #3498db; margin-top: 2px; }
    .btn-copy-cmd { flex-shrink: 0; background: #f0f4f8; border: 1px solid #dde3ea; color: #555; font-size: 0.72em; padding: 5px 10px; border-radius: 6px; cursor: pointer; white-space: nowrap; }
    .btn-copy-cmd:hover { background: #e0e8f0; }
    .cmd-section { margin-bottom: 10px; }
    .toolbar { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 14px; align-items: center; }
    .btn { border: none; border-radius: 8px; padding: 9px 16px; font-size: 0.85em; font-weight: 700; cursor: pointer; font-family: inherit; transition: opacity 0.15s; }
    .btn:hover:not(:disabled) { opacity: 0.88; }
    .btn:disabled { opacity: 0.45; cursor: not-allowed; }
    .btn-primary { background: #27ae60; color: #fff; }
    .btn-secondary { background: #3498db; color: #fff; }
    .btn-warn { background: #e74c3c; color: #fff; }
    .btn-outline { background: #fff; border: 1.5px solid #bdc3c7; color: #555; }
    .btn-sm { padding: 6px 10px; font-size: 0.78em; }
    .filter-row { display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: 10px; font-size: 0.82em; }
    .filter-row label { display: flex; align-items: center; gap: 4px; cursor: pointer; }
    table { width: 100%; border-collapse: collapse; font-size: 0.82em; }
    th, td { padding: 8px 6px; text-align: left; border-bottom: 1px solid #eef0f3; vertical-align: middle; }
    th { background: #f8f9fa; font-weight: 700; color: #555; position: sticky; top: 0; }
    .ss-id { font-family: monospace; font-size: 0.9em; word-break: break-all; max-width: 140px; }
    .admin-email { font-size: 0.9em; word-break: break-all; max-width: 200px; }
    .badge { display: inline-block; padding: 2px 8px; border-radius: 10px; font-size: 0.85em; font-weight: 700; }
    .badge-ok { background: #d5f5e3; color: #1e8449; }
    .badge-stop { background: #fadbd8; color: #cb4335; }
    .badge-warn { background: #fdebd0; color: #9a6110; }
    .badge-muted { background: #eee; color: #888; }
    .table-wrap { max-height: 420px; overflow: auto; border: 1px solid #eef0f3; border-radius: 8px; }
    .log-panel { margin-top: 16px; display: none; }
    .log-panel.show { display: block; }
    .log-summary { padding: 12px 14px; border-radius: 8px; margin-bottom: 10px; font-size: 0.88em; }
    .log-summary.ok { background: #eafaf1; border: 1px solid #abebc6; }
    .log-summary.err { background: #fdedec; border: 1px solid #f5b7b1; }
    .log-table td.reason { color: #666; font-size: 0.9em; }
    .alert { padding: 10px 14px; border-radius: 8px; margin-bottom: 14px; font-size: 0.85em; }
    .alert-warn { background: #fef9e7; border: 1px solid #f9e79f; color: #7d6608; }
    .alert-err { background: #fdedec; border: 1px solid #f5b7b1; color: #922b21; }
    .side-toolbar { display: flex; flex-direction: column; gap: 8px; margin-top: 12px; }
    .side-toolbar .btn { display: block; width: 100%; text-align: center; text-decoration: none; line-height: 1.35; }
    .side-hint { font-size: 0.82em; color: #888; margin-bottom: 4px; line-height: 1.45; }
    .panel-test { border: 2px solid #e67e22; background: linear-gradient(180deg, #fffbf5 0%, #fff 100%); }
    .panel-test h2 { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
    .badge-test-env { display: inline-block; background: #e67e22; color: #fff; font-size: 0.72em; font-weight: 700; padding: 3px 8px; border-radius: 6px; letter-spacing: 0.03em; }
    .test-ss-meta { font-family: monospace; font-size: 0.75em; color: #7d6608; word-break: break-all; margin-bottom: 8px; }
    .test-warn { color: #9a6110; }
    tr.row-test { background: #fffbf0; }
    tr.row-test td:first-of-type + td { border-left: 3px solid #e67e22; }
    .loading { display: none; align-items: center; gap: 8px; color: #666; font-size: 0.85em; margin-bottom: 10px; }
    .loading.show { display: flex; }
    .spinner { width: 18px; height: 18px; border: 2px solid #ddd; border-top-color: #3498db; border-radius: 50%; animation: spin 0.7s linear infinite; }
    @keyframes spin { to { transform: rotate(360deg); } }
    .selected-count { font-size: 0.82em; color: #666; margin-left: auto; }
  </style>
</head>
<body>
  <header class="topbar">
    <div>
      <h1>デプロイ支援コンソール</h1>
      <div class="topbar-sub">顧客環境へのコード配信・サービス停止を Web から操作</div>
    </div>
    <div class="topbar-sub">${customers.length} 店舗</div>
    <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;">
      ${adminEmailLabel ? `<span class="topbar-sub">${adminEmailLabel}</span>` : ''}
      <a href="/admin/logout" class="btn-logout">ログアウト</a>
    </div>
  </header>

  <div class="wrap">
    <div class="grid">
      <aside>
        <div class="panel" style="margin-bottom:16px;">
          <h2>配信の流れ</h2>
          <ol class="step-list">
            <li><strong>GitHub に push</strong>ローカルで修正 → <code>git push origin ${escapeHtml(branch)}</code></li>
            <li><strong>LIFF（自動）</strong>GitHub Pages に liff.js / liff.css が反映（1〜2分）</li>
            <li><strong>GAS（この画面）</strong>対象店舗を選び「コード配信」をクリック</li>
          </ol>
          <div class="meta-box">
            取得元: <strong>${escapeHtml(repo)}</strong> / <strong>${escapeHtml(branch)}</strong><br>
            配信ファイル: Code.js, settings.html, kanri.html 等
          </div>

          <div class="cmd-block">
            <div class="cmd-block-label">よく使う git コマンド（クリックでコピー）</div>
            <div style="font-size:0.75em;color:#e74c3c;background:#fff5f5;border:1px solid #fcc;border-radius:6px;padding:6px 10px;margin-bottom:10px;">
              ⚠️ 以下のコマンドは必ず <strong>リポジトリのルートフォルダ</strong>（reservation-liff-app）で実行してください。
            </div>
            <div class="cmd-row" style="margin-bottom:10px;">
              <code>cd "c:\\Users\\user\\reservation-liff-app"<span class="cmd-comment"># まずルートに移動（毎回実行推奨）</span></code>
              <button class="btn-copy-cmd" onclick="copyCmd(this)">コピー</button>
            </div>

            <div class="cmd-section">
              <div style="font-size:0.75em;color:#e67e22;font-weight:700;margin-bottom:4px;">● GAS ファイル修正後（Code.js / settings.html / kanri.html）→ コード配信も必要</div>
              <div class="cmd-row">
                <code>git add Code.js settings.html kanri.html<span class="cmd-comment"># 変更ファイルをステージング</span></code>
                <button class="btn-copy-cmd" onclick="copyCmd(this)">コピー</button>
              </div>
              <div class="cmd-row">
                <code>git commit -m "fix: 設定画面・管理画面を修正"<span class="cmd-comment"># コミット（メッセージは適宜変更）</span></code>
                <button class="btn-copy-cmd" onclick="copyCmd(this)">コピー</button>
              </div>
              <div class="cmd-row">
                <code>git push origin ${escapeHtml(branch)}<span class="cmd-comment"># push 後にこの画面で「コード配信」</span></code>
                <button class="btn-copy-cmd" onclick="copyCmd(this)">コピー</button>
              </div>
            </div>

            <div class="cmd-section">
              <div style="font-size:0.75em;color:#27ae60;font-weight:700;margin-bottom:4px;">● LIFF 修正後（liff.js / liff.html / liff.css）→ push のみで自動反映</div>
              <div class="cmd-row">
                <code>git add liff.js liff.html liff.css<span class="cmd-comment"># 変更ファイルをステージング</span></code>
                <button class="btn-copy-cmd" onclick="copyCmd(this)">コピー</button>
              </div>
              <div class="cmd-row">
                <code>git commit -m "fix: LIFF 予約画面を修正"<span class="cmd-comment"># コミット</span></code>
                <button class="btn-copy-cmd" onclick="copyCmd(this)">コピー</button>
              </div>
              <div class="cmd-row">
                <code>git push origin ${escapeHtml(branch)}<span class="cmd-comment"># push 後 1〜2分で GitHub Pages に自動反映</span></code>
                <button class="btn-copy-cmd" onclick="copyCmd(this)">コピー</button>
              </div>
            </div>

            <div class="cmd-section">
              <div style="font-size:0.75em;color:#8e44ad;font-weight:700;margin-bottom:4px;">● Worker（コンソール）修正後 → push ＋ wrangler deploy が必要</div>
              <div class="cmd-row">
                <code>git add cloudflare-worker/<span class="cmd-comment"># Worker ファイルをステージング</span></code>
                <button class="btn-copy-cmd" onclick="copyCmd(this)">コピー</button>
              </div>
              <div class="cmd-row">
                <code>git commit -m "fix: Worker を修正"<span class="cmd-comment"># コミット</span></code>
                <button class="btn-copy-cmd" onclick="copyCmd(this)">コピー</button>
              </div>
              <div class="cmd-row">
                <code>git push origin ${escapeHtml(branch)}<span class="cmd-comment"># GitHub に push</span></code>
                <button class="btn-copy-cmd" onclick="copyCmd(this)">コピー</button>
              </div>
              <div class="cmd-row">
                <code>cd cloudflare-worker; npx wrangler deploy<span class="cmd-comment"># Worker を Cloudflare に反映</span></code>
                <button class="btn-copy-cmd" onclick="copyCmd(this)">コピー</button>
              </div>
            </div>
          </div>
        </div>
        <div class="panel panel-test" style="margin-bottom:16px;">
          <h2><span class="badge-test-env">テスト環境</span> 画面確認</h2>
          <p class="test-ss-meta">${escapeHtml(test.ssId)}${test.adminEmail ? `<br>${escapeHtml(test.adminEmail)}` : ''}</p>
          ${testMissingHint}
          <div class="side-toolbar">
            <a href="/" target="_blank" rel="noopener noreferrer" class="btn btn-outline">導入ページを確認する</a>
            ${test.settingsUrl
              ? `<a href="${escapeHtml(test.settingsUrl)}" target="_blank" rel="noopener noreferrer" class="btn btn-secondary">予約システム設定画面を開く</a>`
              : `<span class="btn btn-outline" style="opacity:0.45;cursor:not-allowed;" title="GASデプロイURLが未設定">予約システム設定画面を開く</span>`}
            ${test.liffUrl
              ? `<a href="${escapeHtml(test.liffUrl)}" target="_blank" rel="noopener noreferrer" class="btn btn-secondary">予約画面を確認する</a>`
              : `<span class="btn btn-outline" style="opacity:0.45;cursor:not-allowed;" title="GAS URL または Config.liffChannelId が未設定">予約画面を確認する</span>`}
            ${test.kanriUrl
              ? `<a href="${escapeHtml(test.kanriUrl)}" target="_blank" rel="noopener noreferrer" class="btn btn-secondary">予約管理画面を確認する</a>`
              : `<span class="btn btn-outline" style="opacity:0.45;cursor:not-allowed;" title="GASデプロイURLが未設定">予約管理画面を確認する</span>`}
            <a href="${escapeHtml(test.spreadsheetUrl)}" target="_blank" rel="noopener noreferrer" class="btn btn-outline">テスト用スプレッドシートを開く</a>
          </div>
        </div>
        <div class="panel">
          <h2>顧客台帳・メンテ</h2>
          ${registryUrl
            ? `<p class="side-hint">決済ステータス・決済メモは顧客台帳スプレッドシートで編集します。店舗名は各店舗の予約スプレッドシート内 Config にあります。</p>`
            : `<div class="alert alert-warn" style="margin-bottom:0;">CUSTOMER_REGISTRY_SS_ID が未設定です。先に台帳を初期化してください。</div>`}
          <div class="side-toolbar">
            ${registryUrl
              ? `<a href="${escapeHtml(registryUrl)}" target="_blank" rel="noopener noreferrer" class="btn btn-secondary">📊 顧客台帳を開く</a>`
              : `<a href="/admin/init-registry" class="btn btn-secondary">台帳を初期化</a>`}
            <a href="/admin/sync-registry" class="btn btn-outline">KV → 台帳同期</a>
            <a href="/admin/kv-cleanup" class="btn btn-outline">KV クリーンアップ</a>
          </div>
          <p style="margin-top:12px;font-size:0.78em;color:#999;">
            決済: ${PAYMENT_STATUSES.join(' / ')}<br>
            サービス状態: ${SERVICE_STATUSES.join(' / ')}（停止＝予約受付を一時停止）
          </p>
        </div>
      </aside>

      <main class="panel">
        <h2>顧客一覧と操作</h2>
        <p class="side-hint" style="margin-bottom:12px;">Gmail はオンボーディング時に Google 認証したアカウントです。決済・サービス状態は顧客台帳（CUSTOMER_REGISTRY_SS_ID）設定後に表示されます。</p>
        ${registryError ? `<div class="alert alert-err">台帳読込エラー: ${escapeHtml(registryError)}</div>` : ''}
        ${!registryConfigured ? `<div class="alert alert-warn">顧客台帳（CUSTOMER_REGISTRY_SS_ID）が未設定のため、KV の記録を表示しています。削除済みスプレッドシートは自動で非表示にしています。</div>` : ''}
        ${kvOrphanCount > 0 ? `<div class="alert alert-warn">KV に削除済みスプレッドシートの記録が <strong>${kvOrphanCount}</strong> 件残っています。<a href="/admin/kv-cleanup">KV クリーンアップ</a> で完全に削除できます。</div>` : ''}

        <div class="toolbar">
          <button type="button" class="btn btn-primary" id="btnPushSelected">選択店舗にコード配信</button>
          <button type="button" class="btn btn-warn" id="btnStopSelected">選択店舗を停止</button>
          <button type="button" class="btn btn-outline" id="btnResumeSelected">選択店舗を再開</button>
          <label style="margin-left:8px;font-size:0.88em;cursor:pointer;" title="tests.js を同梱。テスト店舗のみ ON にしてください">
            <input type="checkbox" id="chkIncludeTests"> テストスイート含む
          </label>
          <span class="selected-count" id="selectedCount">0 件選択</span>
        </div>

        <div class="filter-row">
          <label><input type="checkbox" id="chkAll"> すべて選択</label>
          <label><input type="checkbox" id="filterActive" checked> 稼働中のみ表示</label>
        </div>

        <div class="loading" id="loading"><div class="spinner"></div><span id="loadingText">処理中...</span></div>

        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th style="width:36px;"></th>
                <th>ssId</th>
                <th>Gmail</th>
                <th>決済</th>
                <th title="稼働中＝予約受付可 / 停止＝予約を一時停止">サービス状態</th>
                <th>配信</th>
                <th></th>
              </tr>
            </thead>
            <tbody id="customerBody"></tbody>
          </table>
        </div>

        <div class="log-panel" id="logPanel">
          <div class="log-summary" id="logSummary"></div>
          <div class="table-wrap" style="max-height:200px;">
            <table class="log-table">
              <thead><tr><th>ssId</th><th>結果</th><th>詳細</th></tr></thead>
              <tbody id="logBody"></tbody>
            </table>
          </div>
        </div>
      </main>
    </div>
  </div>

  <script>
    const CUSTOMERS = ${customersJson};
    const TEST_SS_ID = ${JSON.stringify(TEST_SS_ID)};

    const tbody = document.getElementById('customerBody');
    const logPanel = document.getElementById('logPanel');
    const logSummary = document.getElementById('logSummary');
    const logBody = document.getElementById('logBody');
    const loading = document.getElementById('loading');
    const selectedCount = document.getElementById('selectedCount');

    function esc(s) {
      const d = document.createElement('div');
      d.textContent = s == null ? '' : String(s);
      return d.innerHTML;
    }

    function serviceBadge(status) {
      if (status === '稼働中') return '<span class="badge badge-ok">稼働中</span>';
      if (status === '停止') return '<span class="badge badge-stop">停止</span>';
      return '<span class="badge badge-muted">' + esc(status) + '</span>';
    }

    function pushBadge(c) {
      if (c.pushReady) return '<span class="badge badge-ok">可</span>';
      return '<span class="badge badge-warn" title="' + esc(c.pushReason) + '">不可</span>';
    }

    function renderSsIdCell(c) {
      const short = esc(c.ssId.slice(0, 12) + '…');
      if (c.ssId === TEST_SS_ID) {
        return '<span class="badge-test-env" style="font-size:0.65em;margin-right:4px;">TEST</span>'
          + '<a href="https://docs.google.com/spreadsheets/d/' + esc(c.ssId) + '/edit" target="_blank" rel="noopener noreferrer">' + short + '</a>';
      }
      return short;
    }

    function renderTable() {
      const activeOnly = document.getElementById('filterActive').checked;
      const rows = CUSTOMERS.filter(c => !activeOnly || c.serviceStatus !== '停止');
      tbody.innerHTML = rows.length === 0
        ? '<tr><td colspan="7" style="text-align:center;padding:24px;color:#999;">表示する顧客がありません</td></tr>'
        : rows.map(c => \`
          <tr class="\${c.ssId === TEST_SS_ID ? 'row-test' : ''}" data-ss-id="\${esc(c.ssId)}" data-active="\${c.serviceStatus !== '停止'}">
            <td><input type="checkbox" class="row-chk" value="\${esc(c.ssId)}"></td>
            <td class="ss-id">\${renderSsIdCell(c)}</td>
            <td class="admin-email">\${esc(c.adminEmail || '—')}</td>
            <td>\${esc(c.paymentStatus)}</td>
            <td>\${serviceBadge(c.serviceStatus)}</td>
            <td>\${pushBadge(c)}</td>
            <td>
              <button type="button" class="btn btn-outline btn-sm btn-push-one" data-ss-id="\${esc(c.ssId)}">配信</button>
            </td>
          </tr>\`).join('');
      updateSelectedCount();
      bindRowEvents();
    }

    function getSelectedSsIds() {
      return [...document.querySelectorAll('.row-chk:checked')].map(el => el.value);
    }

    function updateSelectedCount() {
      selectedCount.textContent = getSelectedSsIds().length + ' 件選択';
    }

    function bindRowEvents() {
      document.querySelectorAll('.row-chk').forEach(el => {
        el.addEventListener('change', updateSelectedCount);
      });
      document.querySelectorAll('.btn-push-one').forEach(btn => {
        btn.addEventListener('click', () => pushUpdate([btn.dataset.ssId]));
      });
    }

    document.getElementById('chkAll').addEventListener('change', function() {
      document.querySelectorAll('.row-chk').forEach(el => { el.checked = this.checked; });
      updateSelectedCount();
    });

    document.getElementById('filterActive').addEventListener('change', renderTable);

    function setLoading(on, text) {
      loading.classList.toggle('show', on);
      if (text) document.getElementById('loadingText').textContent = text;
      document.querySelectorAll('.toolbar .btn').forEach(b => b.disabled = on);
    }

    function showResults(data, title) {
      logPanel.classList.add('show');
      const ok = data.errorCount === 0 && data.successCount > 0;
      logSummary.className = 'log-summary ' + (data.errorCount > 0 ? 'err' : 'ok');
      logSummary.innerHTML = '<strong>' + esc(title) + '</strong><br>'
        + '対象: ' + esc(data.targetDesc) + ' — '
        + '成功 <strong>' + data.successCount + '</strong> / '
        + 'スキップ ' + data.skipCount + ' / '
        + 'エラー <strong>' + data.errorCount + '</strong>';
      logBody.innerHTML = (data.results || []).map(r => {
        const label = r.status === 'success' ? '✅ 成功' : (r.status === 'skipped' ? '⏭ スキップ' : '❌ エラー');
        const detail = r.reason || (r.status === 'success'
          ? 'v' + r.versionNumber + ' にデプロイ'
            + (r.triggersSetup === false ? '（トリガー: 要フォールバック）' : '（トリガー7種設定済）')
            + (r.configSyncWarning ? '（警告: ' + r.configSyncWarning + '）' : '')
          : '');
        return '<tr><td class="ss-id">' + esc(r.ssId) + '</td><td>' + label + '</td><td class="reason">' + esc(detail) + '</td></tr>';
      }).join('') || '<tr><td colspan="3">結果なし</td></tr>';
      logPanel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }

    async function pushUpdate(ssIds, includeStopped) {
      if (!ssIds || ssIds.length === 0) {
        alert('配信する店舗を選択してください。');
        return;
      }
      const includeTests = document.getElementById('chkIncludeTests').checked;
      let confirmMsg = ssIds.length + ' 店舗に GitHub（' + ${JSON.stringify(branch)} + '）の最新コードを配信します。';
      if (includeTests) confirmMsg += '\\n\\n※ tests.js を含みます（テスト店舗向け）。';
      confirmMsg += '\\nよろしいですか？';
      if (!confirm(confirmMsg)) return;

      setLoading(true, 'GitHub からコード取得 → GAS へ配信中...');
      try {
        const res = await fetch('/admin/api/push-update', {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ssIds, includeStopped: !!includeStopped, includeTests }),
        });
        const data = await res.json();
        if (!data.success) throw new Error(data.message || '配信失敗');
        showResults(data, 'コード配信完了');
      } catch (e) {
        alert('エラー: ' + e.message);
      } finally {
        setLoading(false);
      }
    }

    async function setStatusForSelected(serviceStatus) {
      const ssIds = getSelectedSsIds();
      if (ssIds.length === 0) { alert('店舗を選択してください。'); return; }
      const verb = serviceStatus === '停止' ? '停止' : '再開';
      if (!confirm('選択した ' + ssIds.length + ' 店舗のサービスを' + verb + 'します。よろしいですか？')) return;

      setLoading(true, 'サービス' + verb + '処理中...');
      const results = [];
      try {
        for (const ssId of ssIds) {
          const res = await fetch('/admin/api/set-status', {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ssId, serviceStatus }),
          });
          const data = await res.json();
          results.push({ ssId, ok: data.success, message: data.message || data.configSync });
          if (data.success) {
            const c = CUSTOMERS.find(x => x.ssId === ssId);
            if (c) c.serviceStatus = serviceStatus;
          }
        }
        renderTable();
        alert(verb + '完了: ' + results.filter(r => r.ok).length + ' / ' + results.length + ' 件');
      } catch (e) {
        alert('エラー: ' + e.message);
      } finally {
        setLoading(false);
      }
    }

    document.getElementById('btnPushSelected').addEventListener('click', () => pushUpdate(getSelectedSsIds()));
    document.getElementById('btnStopSelected').addEventListener('click', () => setStatusForSelected('停止'));
    document.getElementById('btnResumeSelected').addEventListener('click', () => setStatusForSelected('稼働中'));

    renderTable();

    // コマンドコピーボタン
    function copyCmd(btn) {
      const code = btn.previousElementSibling;
      // <code> 内のテキストから <span class="cmd-comment"> を除いたコマンド部分のみ取得
      const spans = code.querySelectorAll('.cmd-comment');
      spans.forEach(s => s.style.display = 'none');
      const cmd = code.innerText.trim();
      spans.forEach(s => s.style.display = '');
      navigator.clipboard.writeText(cmd).then(() => {
        const orig = btn.textContent;
        btn.textContent = 'コピー済 ✓';
        btn.style.color = '#27ae60';
        setTimeout(() => { btn.textContent = orig; btn.style.color = ''; }, 2000);
      }).catch(() => {
        // フォールバック
        const ta = document.createElement('textarea');
        ta.value = cmd;
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
        btn.textContent = 'コピー済 ✓';
        setTimeout(() => { btn.textContent = 'コピー'; }, 2000);
      });
    }
    window.copyCmd = copyCmd;
  </script>
</body>
</html>`;
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
