/**
 * 開発者向けシステムエラーログ集約（GAS push → KV → /admin 表示）
 */

import { hmacVerify } from './admin-auth.js';
import { jsonResponse } from './admin-console.js';

export const ERROR_LOG_GLOBAL_KEY = 'errorLog:global';
export const ERROR_UNREAD_META_KEY = 'errorUnread:meta';
export const ERROR_DEDUP_PREFIX = 'errorDedup:';
export const ERROR_LOG_MAX_ENTRIES = 200;
export const ERROR_DEDUP_TTL_SEC = 900;
export const ERROR_STACK_MAX_LEN = 2048;
export const ERROR_SIG_MAX_AGE_SEC = 300;

export function buildErrorFingerprintInput(ssId, functionName, message) {
  const msg = String(message || '').slice(0, 200);
  return `${ssId}|${functionName}|${msg}`;
}

async function sha256HexAsync(input) {
  const data = new TextEncoder().encode(input);
  const hash = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(hash)].map(b => b.toString(16).padStart(2, '0')).join('');
}

function truncate(str, max) {
  const s = String(str || '');
  return s.length <= max ? s : s.slice(0, max);
}

function parseGlobalList(raw) {
  if (!raw) return [];
  try {
    const list = JSON.parse(raw);
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

function parseUnreadMeta(raw) {
  if (!raw) return { total: 0, bySsId: {} };
  try {
    const meta = JSON.parse(raw);
    return {
      total: Number(meta.total) || 0,
      bySsId: meta.bySsId && typeof meta.bySsId === 'object' ? meta.bySsId : {},
    };
  } catch {
    return { total: 0, bySsId: {} };
  }
}

export async function loadErrorLogState(kv) {
  const [globalRaw, metaRaw] = await Promise.all([
    kv.get(ERROR_LOG_GLOBAL_KEY),
    kv.get(ERROR_UNREAD_META_KEY),
  ]);
  return {
    events: parseGlobalList(globalRaw),
    unread: parseUnreadMeta(metaRaw),
  };
}

async function verifyReportSignature(request, bodyText, env) {
  const secret = (env.ERROR_REPORT_SECRET || '').trim();
  if (!secret) return { ok: false, message: 'ERROR_REPORT_SECRET 未設定' };

  const url = new URL(request.url);
  // GAS UrlFetch はカスタムヘッダーが届かないことがあるため ?ts=&sig= も受け付ける
  const timestamp = (url.searchParams.get('ts') || request.headers.get('X-Error-Timestamp') || '').trim();
  const signature = (url.searchParams.get('sig') || request.headers.get('X-Error-Signature') || '').trim();
  if (!timestamp || !signature) {
    return { ok: false, message: '署名パラメーターが不足しています（?ts=&sig= または X-Error-* ヘッダー）' };
  }

  const ts = Number(timestamp);
  if (!Number.isFinite(ts)) {
    return { ok: false, message: 'タイムスタンプが不正です' };
  }
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - ts) > ERROR_SIG_MAX_AGE_SEC) {
    return { ok: false, message: 'タイムスタンプが期限切れです' };
  }

  const message = `${timestamp}.${bodyText}`;
  if (!(await hmacVerify(secret, message, signature))) {
    return { ok: false, message: '署名が不正です' };
  }
  return { ok: true };
}

/**
 * GAS からのエラー報告を KV に蓄積する。
 */
export async function reportErrorEvent(env, payload) {
  const ssId = String(payload.ssId || '').trim();
  const functionName = String(payload.functionName || '').trim();
  const message = String(payload.message || '').trim();
  if (!ssId || !functionName || !message) {
    throw new Error('ssId, functionName, message は必須です');
  }
  if (ssId === 'PLACEHOLDER_SPREADSHEET_ID') {
    throw new Error('未プロビジョニングの ssId です');
  }

  const fingerprint = await sha256HexAsync(buildErrorFingerprintInput(ssId, functionName, message));
  const dedupKey = `${ERROR_DEDUP_PREFIX}${fingerprint}`;
  const dedupExists = await env.ONBOARDING_KV.get(dedupKey);

  const globalRaw = await env.ONBOARDING_KV.get(ERROR_LOG_GLOBAL_KEY);
  let events = parseGlobalList(globalRaw);

  if (dedupExists) {
    const idx = events.findIndex(e => e.fingerprint === fingerprint);
    if (idx >= 0) {
      events[idx].repeatCount = (events[idx].repeatCount || 1) + 1;
      events[idx].lastSeenAt = payload.timestamp || new Date().toISOString();
      await env.ONBOARDING_KV.put(ERROR_LOG_GLOBAL_KEY, JSON.stringify(events));
    }
    return { ok: true, deduped: true, id: idx >= 0 ? events[idx].id : null };
  }

  const event = {
    id: crypto.randomUUID(),
    fingerprint,
    ssId,
    shopName: truncate(payload.shopName, 200),
    functionName,
    message: truncate(message, 2000),
    stack: truncate(payload.stack, ERROR_STACK_MAX_LEN),
    timestamp: payload.timestamp || new Date().toISOString(),
    repeatCount: 1,
    lastSeenAt: payload.timestamp || new Date().toISOString(),
  };

  events.unshift(event);
  if (events.length > ERROR_LOG_MAX_ENTRIES) {
    events = events.slice(0, ERROR_LOG_MAX_ENTRIES);
  }

  const metaRaw = await env.ONBOARDING_KV.get(ERROR_UNREAD_META_KEY);
  const unread = parseUnreadMeta(metaRaw);
  unread.total = (unread.total || 0) + 1;
  unread.bySsId[ssId] = (unread.bySsId[ssId] || 0) + 1;

  await Promise.all([
    env.ONBOARDING_KV.put(ERROR_LOG_GLOBAL_KEY, JSON.stringify(events)),
    env.ONBOARDING_KV.put(ERROR_UNREAD_META_KEY, JSON.stringify(unread)),
    env.ONBOARDING_KV.put(dedupKey, '1', { expirationTtl: ERROR_DEDUP_TTL_SEC }),
  ]);

  return { ok: true, deduped: false, id: event.id };
}

export async function ackErrorLogs(env, { ssId = null } = {}) {
  const metaRaw = await env.ONBOARDING_KV.get(ERROR_UNREAD_META_KEY);
  const unread = parseUnreadMeta(metaRaw);

  if (ssId) {
    const count = unread.bySsId[ssId] || 0;
    delete unread.bySsId[ssId];
    unread.total = Math.max(0, (unread.total || 0) - count);
  } else {
    unread.total = 0;
    unread.bySsId = {};
  }

  await env.ONBOARDING_KV.put(ERROR_UNREAD_META_KEY, JSON.stringify(unread));
  return unread;
}

export async function handleReportError(request, env) {
  if (request.method !== 'POST') {
    return jsonResponse({ success: false, message: 'POST のみ対応' }, 405);
  }

  const bodyText = await request.text();
  let payload;
  try {
    payload = JSON.parse(bodyText);
  } catch {
    return jsonResponse({ success: false, message: 'JSON ボディが必要です' }, 400);
  }

  const sig = await verifyReportSignature(request, bodyText, env);
  if (!sig.ok) {
    return jsonResponse({ success: false, message: sig.message }, 401);
  }

  try {
    const result = await reportErrorEvent(env, payload);
    return jsonResponse({ success: true, ...result });
  } catch (err) {
    return jsonResponse({ success: false, message: err.message }, 400);
  }
}

export async function handleAdminApiErrorLogs(request, env) {
  if (request.method !== 'GET') {
    return jsonResponse({ success: false, message: 'GET のみ対応' }, 405);
  }
  const limit = Math.min(100, Math.max(1, Number(new URL(request.url).searchParams.get('limit')) || 50));
  const state = await loadErrorLogState(env.ONBOARDING_KV);
  return jsonResponse({
    success: true,
    events: state.events.slice(0, limit),
    unread: state.unread,
  });
}

export async function handleAdminApiErrorLogsAck(request, env) {
  if (request.method !== 'POST') {
    return jsonResponse({ success: false, message: 'POST のみ対応' }, 405);
  }
  let body = {};
  try {
    body = await request.json();
  } catch {
    body = {};
  }
  const unread = await ackErrorLogs(env, { ssId: body.ssId || null });
  return jsonResponse({ success: true, unread });
}
