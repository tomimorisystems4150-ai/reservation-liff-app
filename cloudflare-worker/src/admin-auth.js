/**
 * デプロイ支援コンソール認証（二段構え）
 * 1. Cloudflare Access — Cf-Access-Authenticated-User-Email（ダッシュボード側で設定）
 * 2. HttpOnly セッション Cookie — URL に key を載せない
 */

const SESSION_COOKIE = 'admin_session';
const SESSION_MAX_AGE_SEC = 8 * 60 * 60;

/** Set-Cookie 付きリダイレクト（Response.redirect は headers 非対応） */
function redirectResponse(location, status, extraHeaders = {}) {
  return new Response(null, {
    status,
    headers: {
      Location: location,
      'Cache-Control': 'no-store',
      ...extraHeaders,
    },
  });
}

function getAllowedEmails(env) {
  const raw = env.ADMIN_ALLOWED_EMAILS || 'tomimori.systems4150@gmail.com';
  return raw.split(',').map(e => e.trim().toLowerCase()).filter(Boolean);
}

function accessRequired(env) {
  return env.ADMIN_REQUIRE_ACCESS === '1' || env.ADMIN_REQUIRE_ACCESS === 'true';
}

export function getAccessEmail(request) {
  return request.headers.get('Cf-Access-Authenticated-User-Email')?.trim().toLowerCase() || null;
}

function verifyAccessEmail(request, env) {
  const email = getAccessEmail(request);
  const allowed = getAllowedEmails(env);
  if (!email) {
    return accessRequired(env)
      ? { ok: false, reason: 'Cloudflare Access による Google ログインが必要です。' }
      : { ok: true, email: null };
  }
  if (!allowed.includes(email)) {
    return { ok: false, reason: 'この Google アカウントには管理権限がありません。' };
  }
  return { ok: true, email };
}

export async function hmacSign(secret, message) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(message));
  const bytes = new Uint8Array(sig);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export async function hmacVerify(secret, message, signature) {
  const expected = await hmacSign(secret, message);
  if (expected.length !== signature.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ signature.charCodeAt(i);
  return diff === 0;
}

export async function createSessionToken(email, env) {
  const payload = {
    email: email || 'admin',
    exp: Math.floor(Date.now() / 1000) + SESSION_MAX_AGE_SEC,
  };
  const body = JSON.stringify(payload);
  const sig = await hmacSign(env.ADMIN_SECRET_KEY, body);
  return `${btoa(body).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')}.${sig}`;
}

async function parseSessionToken(token, env) {
  if (!token || !env.ADMIN_SECRET_KEY) return null;
  const [bodyB64, sig] = token.split('.');
  if (!bodyB64 || !sig) return null;
  const body = atob(bodyB64.replace(/-/g, '+').replace(/_/g, '/'));
  if (!(await hmacVerify(env.ADMIN_SECRET_KEY, body, sig))) return null;
  try {
    const payload = JSON.parse(body);
    if (!payload.exp || payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch {
    return null;
  }
}

function getSessionCookie(request) {
  const raw = request.headers.get('Cookie') || '';
  for (const part of raw.split(';')) {
    const [name, ...rest] = part.trim().split('=');
    if (name === SESSION_COOKIE) return rest.join('=');
  }
  return null;
}

export function buildSessionCookieHeader(token, env) {
  const secure = (env.WORKER_URL || '').startsWith('https://') ? '; Secure' : '';
  return `${SESSION_COOKIE}=${token}; Path=/admin; HttpOnly; SameSite=Strict; Max-Age=${SESSION_MAX_AGE_SEC}${secure}`;
}

export function buildClearSessionCookieHeader(env) {
  const secure = (env.WORKER_URL || '').startsWith('https://') ? '; Secure' : '';
  return `${SESSION_COOKIE}=; Path=/admin; HttpOnly; SameSite=Strict; Max-Age=0${secure}`;
}

/** 旧 URL（?key=）をセッション Cookie に移行してクリーン URL へリダイレクト */
export async function tryLegacyKeyMigration(request, env) {
  const url = new URL(request.url);
  const legacyKey = url.searchParams.get('key');
  if (!legacyKey || legacyKey !== env.ADMIN_SECRET_KEY) return null;

  const access = verifyAccessEmail(request, env);
  if (!access.ok) {
    return new Response(access.reason, { status: 403 });
  }

  url.searchParams.delete('key');
  const token = await createSessionToken(access.email || 'legacy-admin', env);
  return redirectResponse(url.toString(), 302, {
    'Set-Cookie': buildSessionCookieHeader(token, env),
  });
}

/**
 * 管理 API / ページの認証
 * @returns {{ ok: true, email: string|null } | { ok: false, status: number, message: string, redirect?: string }}
 */
export async function requireAdminAuth(request, env) {
  const migrated = await tryLegacyKeyMigration(request, env);
  if (migrated) return { ok: false, migrated };

  const access = verifyAccessEmail(request, env);
  if (!access.ok) {
    return { ok: false, status: 403, message: access.reason };
  }

  const sessionRaw = getSessionCookie(request);
  const session = await parseSessionToken(sessionRaw, env);
  if (!session) {
    return { ok: false, status: 401, message: 'ログインが必要です', redirect: '/admin/login' };
  }

  if (access.email && session.email && access.email !== session.email.toLowerCase()) {
    return { ok: false, status: 401, message: 'セッションが無効です。再ログインしてください。', redirect: '/admin/login' };
  }

  return { ok: true, email: access.email || session.email || null };
}

export function renderAdminLoginPage(env, { error = '', accessEmail = null, next = '/admin' } = {}) {
  const safeNext = next.startsWith('/admin') ? next : '/admin';
  return `<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>管理ログイン | LINE予約システム</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #eef2f7; min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 20px; }
    .card { background: #fff; border-radius: 12px; box-shadow: 0 2px 16px rgba(0,0,0,0.08); padding: 28px 24px; max-width: 400px; width: 100%; }
    h1 { font-size: 1.1em; color: #2c3e50; margin-bottom: 8px; }
    p { font-size: 0.88em; color: #666; line-height: 1.5; margin-bottom: 16px; }
    .access-user { background: #eafaf1; border: 1px solid #abebc6; color: #1e8449; padding: 10px 12px; border-radius: 8px; font-size: 0.85em; margin-bottom: 16px; word-break: break-all; }
    .err { background: #fdedec; border: 1px solid #f5b7b1; color: #922b21; padding: 10px 12px; border-radius: 8px; font-size: 0.85em; margin-bottom: 14px; }
    label { display: block; font-size: 0.82em; font-weight: 700; color: #555; margin-bottom: 6px; }
    input[type=password] { width: 100%; padding: 10px 12px; border: 1.5px solid #ddd; border-radius: 8px; font-size: 0.95em; margin-bottom: 16px; }
    button { width: 100%; background: #2c3e50; color: #fff; border: none; border-radius: 8px; padding: 12px; font-size: 0.95em; font-weight: 700; cursor: pointer; }
    button:hover { opacity: 0.9; }
    .hint { margin-top: 14px; font-size: 0.75em; color: #999; line-height: 1.45; }
  </style>
</head>
<body>
  <div class="card">
    <h1>デプロイ支援コンソール</h1>
    <p>Cloudflare Access で Google ログイン済みのうえ、管理パスワードを入力してください。URL に秘密情報は載りません。</p>
    ${accessEmail ? `<div class="access-user">✓ Google: ${escapeHtml(accessEmail)}</div>` : ''}
    ${error ? `<div class="err">${escapeHtml(error)}</div>` : ''}
    <form method="POST" action="/admin/login">
      <input type="hidden" name="next" value="${escapeHtml(safeNext)}">
      <label for="adminKey">管理パスワード</label>
      <input type="password" id="adminKey" name="adminKey" autocomplete="current-password" required autofocus>
      <button type="submit">ログイン</button>
    </form>
    <p class="hint">管理パスワードは wrangler secret の ADMIN_SECRET_KEY です。ブラウザのブックマークは <code>/admin</code> のみで構いません。</p>
  </div>
</body>
</html>`;
}

function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export async function handleAdminLogin(request, env) {
  const url = new URL(request.url);
  const next = url.searchParams.get('next') || '/admin';

  if (request.method === 'GET') {
    const access = verifyAccessEmail(request, env);
    if (!access.ok) {
      return new Response(access.reason, { status: 403, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
    }
    const session = await parseSessionToken(getSessionCookie(request), env);
    if (session) {
      const dest = next.startsWith('/admin') ? next : '/admin';
      return Response.redirect(dest, 302);
    }
    return new Response(renderAdminLoginPage(env, { accessEmail: access.email, next }), {
      headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
    });
  }

  if (request.method !== 'POST') {
    return new Response('Method Not Allowed', { status: 405 });
  }

  const access = verifyAccessEmail(request, env);
  if (!access.ok) {
    return new Response(renderAdminLoginPage(env, { error: access.reason, next }), {
      status: 403,
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
    });
  }

  const form = await request.formData();
  const adminKey = String(form.get('adminKey') || '');
  const dest = String(form.get('next') || '/admin');
  const safeDest = dest.startsWith('/admin') ? dest : '/admin';

  if (!env.ADMIN_SECRET_KEY || adminKey !== env.ADMIN_SECRET_KEY) {
    return new Response(renderAdminLoginPage(env, {
      error: '管理パスワードが正しくありません。',
      accessEmail: access.email,
      next: safeDest,
    }), {
      status: 401,
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
    });
  }

  const token = await createSessionToken(access.email || 'admin', env);
  return redirectResponse(safeDest, 302, {
    'Set-Cookie': buildSessionCookieHeader(token, env),
  });
}

export function handleAdminLogout(request, env) {
  return redirectResponse('/admin/login', 302, {
    'Set-Cookie': buildClearSessionCookieHeader(env),
  });
}

/** HTML ページ用 — 未認証ならログインへ */
export async function adminAuthOrRedirect(request, env) {
  const auth = await requireAdminAuth(request, env);
  if (auth.migrated) return { response: auth.migrated };
  if (auth.ok) return { auth };
  if (auth.redirect) {
    const login = new URL('/admin/login', request.url);
    login.searchParams.set('next', new URL(request.url).pathname);
    return { response: Response.redirect(login.toString(), 302) };
  }
  return { response: new Response(auth.message || 'Forbidden', { status: auth.status || 403 }) };
}

/** JSON API 用 */
export async function adminAuthOrJsonError(request, env) {
  const auth = await requireAdminAuth(request, env);
  if (auth.migrated) return { response: auth.migrated };
  if (auth.ok) return { auth };
  return {
    response: new Response(JSON.stringify({ success: false, message: auth.message || 'Unauthorized' }), {
      status: auth.status || 401,
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
    }),
  };
}
