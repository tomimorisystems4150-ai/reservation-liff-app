/**
 * SaaS顧客台帳（開発者管理スプレッドシート）の読み書き
 * env.CUSTOMER_REGISTRY_SS_ID に台帳SSのIDを設定し、SAに編集権限を付与すること
 */

const SHEETS_API = 'https://sheets.googleapis.com/v4/spreadsheets';

export const REGISTRY_SHEET = '顧客台帳';
export const REGISTRY_HEADERS = [
  'ssId',
  '店舗名',
  'adminEmail',
  '導入日時',
  '決済ステータス',
  'サービス状態',
  'GASデプロイURL',
  'scriptId',
  '決済メモ',
  '最終更新日時',
];

const PAYMENT_STATUSES = ['未払い', 'トライアル', '支払済', '督促中'];
const SERVICE_STATUSES = ['稼働中', '停止'];

export function parseRegistryRows(values) {
  if (!values || values.length < 2) return [];
  const header = values[0].map(h => String(h || '').trim());
  const idx = (name) => header.indexOf(name);

  return values.slice(1)
    .filter(row => row && String(row[idx('ssId')] || '').trim())
    .map(row => ({
      ssId:           String(row[idx('ssId')] || '').trim(),
      shopName:       String(row[idx('店舗名')] || '').trim(),
      adminEmail:     String(row[idx('adminEmail')] || '').trim(),
      onboardedAt:    String(row[idx('導入日時')] || '').trim(),
      paymentStatus:  String(row[idx('決済ステータス')] || '未払い').trim(),
      serviceStatus:  String(row[idx('サービス状態')] || '稼働中').trim(),
      deployUrl:      String(row[idx('GASデプロイURL')] || '').trim(),
      scriptId:       String(row[idx('scriptId')] || '').trim(),
      paymentMemo:    String(row[idx('決済メモ')] || '').trim(),
      updatedAt:      String(row[idx('最終更新日時')] || '').trim(),
    }));
}

export async function readCustomerRegistry(env, getSaToken) {
  if (!env.CUSTOMER_REGISTRY_SS_ID) {
    throw new Error('CUSTOMER_REGISTRY_SS_ID が未設定です。wrangler secret put CUSTOMER_REGISTRY_SS_ID で設定してください。');
  }
  const token = await getSaToken('https://www.googleapis.com/auth/spreadsheets');
  const auth  = `Bearer ${token}`;
  const range = encodeURIComponent(`${REGISTRY_SHEET}!A:J`);
  const res   = await fetch(`${SHEETS_API}/${env.CUSTOMER_REGISTRY_SS_ID}/values/${range}`, {
    headers: { Authorization: auth },
  });
  const data = await res.json();
  if (data.error) throw new Error(`顧客台帳の読み込み失敗: ${data.error.message}`);
  return parseRegistryRows(data.values || []);
}

export async function initCustomerRegistrySheet(env, getSaToken) {
  if (!env.CUSTOMER_REGISTRY_SS_ID) {
    throw new Error('CUSTOMER_REGISTRY_SS_ID が未設定です。');
  }
  const token = await getSaToken('https://www.googleapis.com/auth/spreadsheets');
  const auth  = `Bearer ${token}`;
  const ssId  = env.CUSTOMER_REGISTRY_SS_ID;

  const metaRes = await fetch(`${SHEETS_API}/${ssId}`, { headers: { Authorization: auth } });
  const meta    = await metaRes.json();
  if (meta.error) throw new Error(`台帳SS取得失敗: ${meta.error.message}`);

  const exists = (meta.sheets || []).some(s => s.properties?.title === REGISTRY_SHEET);
  if (!exists) {
    const addRes = await fetch(`${SHEETS_API}/${ssId}:batchUpdate`, {
      method: 'POST',
      headers: { Authorization: auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        requests: [{ addSheet: { properties: { title: REGISTRY_SHEET } } }],
      }),
    });
    const addData = await addRes.json();
    if (addData.error) throw new Error(`シート作成失敗: ${addData.error.message}`);
  }

  const headerRange = encodeURIComponent(`${REGISTRY_SHEET}!A1:J1`);
  await fetch(`${SHEETS_API}/${ssId}/values/${headerRange}?valueInputOption=RAW`, {
    method: 'PUT',
    headers: { Authorization: auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ values: [REGISTRY_HEADERS] }),
  });

  return { ssId, sheetUrl: `https://docs.google.com/spreadsheets/d/${ssId}/edit` };
}

export async function upsertRegistryCustomer(env, getSaToken, customer) {
  const rows = await readCustomerRegistry(env, getSaToken);
  const token = await getSaToken('https://www.googleapis.com/auth/spreadsheets');
  const auth  = `Bearer ${token}`;
  const ssId  = env.CUSTOMER_REGISTRY_SS_ID;
  const now   = new Date().toISOString();
  const existing = rows.find(r => r.ssId === customer.ssId);

  const paymentStatus = PAYMENT_STATUSES.includes(customer.paymentStatus)
    ? customer.paymentStatus : (existing?.paymentStatus || 'トライアル');
  const serviceStatus = SERVICE_STATUSES.includes(customer.serviceStatus)
    ? customer.serviceStatus : (existing?.serviceStatus || '稼働中');

  const rowValues = [
    customer.ssId,
    customer.shopName ?? existing?.shopName ?? '',
    customer.adminEmail ?? existing?.adminEmail ?? '',
    customer.onboardedAt ?? existing?.onboardedAt ?? now,
    paymentStatus,
    serviceStatus,
    customer.deployUrl ?? existing?.deployUrl ?? '',
    customer.scriptId ?? existing?.scriptId ?? '',
    customer.paymentMemo ?? existing?.paymentMemo ?? '',
    now,
  ];

  if (existing) {
    const rowIndex = rows.indexOf(existing) + 2;
    const range = encodeURIComponent(`${REGISTRY_SHEET}!A${rowIndex}:J${rowIndex}`);
    const res = await fetch(`${SHEETS_API}/${ssId}/values/${range}?valueInputOption=RAW`, {
      method: 'PUT',
      headers: { Authorization: auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ values: [rowValues] }),
    });
    const data = await res.json();
    if (data.error) throw new Error(`顧客台帳更新失敗: ${data.error.message}`);
  } else {
    const res = await fetch(`${SHEETS_API}/${ssId}/values/${encodeURIComponent(`${REGISTRY_SHEET}!A:J`)}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`, {
      method: 'POST',
      headers: { Authorization: auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ values: [rowValues] }),
    });
    const data = await res.json();
    if (data.error) throw new Error(`顧客台帳追加失敗: ${data.error.message}`);
  }
}

export async function updateRegistryStatus(env, getSaToken, ssId, updates) {
  const rows = await readCustomerRegistry(env, getSaToken);
  const existing = rows.find(r => r.ssId === ssId);
  if (!existing) throw new Error(`ssId ${ssId} は顧客台帳に登録されていません。`);

  if (updates.paymentStatus && !PAYMENT_STATUSES.includes(updates.paymentStatus)) {
    throw new Error(`決済ステータスは ${PAYMENT_STATUSES.join(' / ')} のいずれかです。`);
  }
  if (updates.serviceStatus && !SERVICE_STATUSES.includes(updates.serviceStatus)) {
    throw new Error(`サービス状態は ${SERVICE_STATUSES.join(' / ')} のいずれかです。`);
  }

  await upsertRegistryCustomer(env, getSaToken, {
    ssId,
    shopName:      updates.shopName ?? existing.shopName,
    adminEmail:    updates.adminEmail ?? existing.adminEmail,
    onboardedAt:   existing.onboardedAt,
    deployUrl:     existing.deployUrl,
    scriptId:      existing.scriptId,
    paymentStatus: updates.paymentStatus ?? existing.paymentStatus,
    serviceStatus: updates.serviceStatus ?? existing.serviceStatus,
    paymentMemo:   updates.paymentMemo ?? existing.paymentMemo,
  });

  return { ...existing, ...updates };
}

/**
 * push-update の対象 ssId 一覧を解決する
 */
export async function resolvePushTargets(env, getSaToken, url, kvListKeys) {
  const ssIdParam  = url.searchParams.get('ssId');
  const ssIdsParam = url.searchParams.get('ssIds');
  const includeStopped = url.searchParams.get('includeStopped') === '1';

  let explicitSsIds = null;
  if (ssIdParam) explicitSsIds = [ssIdParam.trim()];
  else if (ssIdsParam) {
    explicitSsIds = ssIdsParam.split(',').map(s => s.trim()).filter(Boolean);
  }

  if (env.CUSTOMER_REGISTRY_SS_ID) {
    let registry = await readCustomerRegistry(env, getSaToken);
    if (explicitSsIds) {
      registry = registry.filter(r => explicitSsIds.includes(r.ssId));
    } else if (!includeStopped) {
      registry = registry.filter(r => r.serviceStatus !== '停止');
    }
    return registry.map(r => ({ ssId: r.ssId, registry: r }));
  }

  // 台帳未設定時は KV のみ（後方互換）
  const targets = [];
  for (const kvKey of kvListKeys) {
    const ssId = kvKey.name.replace(/^store:/, '');
    if (explicitSsIds && !explicitSsIds.includes(ssId)) continue;
    targets.push({ ssId, registry: null });
  }
  return targets;
}

export { PAYMENT_STATUSES, SERVICE_STATUSES };
