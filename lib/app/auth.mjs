import { randomBytes, createHash } from 'node:crypto';
import { AppError, seal, unseal, requireValue, bounded } from '../security.mjs';
import { appOrigin, serviceOrigin } from './config.mjs';

/** Select a host-only secure cookie name on HTTPS; loopback development remains usable. */
function cookieName(name) { return `${appOrigin().startsWith('https:') ? '__Host-' : ''}canvasly_${name}`; }

/** Read one exact cookie without interpreting untrusted fields as configuration. */
export function readCookie(req, name) {
  const prefix = `${cookieName(name)}=`;
  for (const part of String(req.headers.cookie || '').split(';')) if (part.trim().startsWith(prefix)) return part.trim().slice(prefix.length);
  return null;
}

/** Append, rather than replace, cookies when a callback sets a session and clears PKCE state. */
export function writeCookie(res, name, value, seconds = 2592000) {
  const cookie = `${cookieName(name)}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${seconds}${appOrigin().startsWith('https:') ? '; Secure' : ''}`;
  const old = res.getHeader('Set-Cookie');
  res.setHeader('Set-Cookie', [...(Array.isArray(old) ? old : old ? [old] : []), cookie]);
}

/** Call Supabase Auth using its public project key; service-role credentials never enter auth flows. */
export async function authRequest(path, data, token, method = 'POST', fetchImpl = fetch) {
  const response = await fetchImpl(`${serviceOrigin('SUPABASE_URL')}/auth/v1/${path}`, {
    method, headers: { apikey: requireValue('SUPABASE_PUBLISHABLE_KEY'), 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    ...(data === undefined ? {} : { body: JSON.stringify(data) }), redirect: 'error', signal: AbortSignal.timeout(15000)
  });
  const body = response.status === 204 ? {} : await response.json().catch(/* Do not leak malformed provider replies. */ () => ({}));
  if (!response.ok) throw new AppError(response.status === 429 ? 'Too many sign-in attempts. Try again later.' : String(body.msg || body.error_description || body.message || 'Authentication failed.').slice(0, 200), response.status === 429 ? 429 : 401);
  return body;
}

/** Save encrypted provider tokens in an HttpOnly cookie, never in localStorage or model context. */
export function saveSession(res, session) {
  if (!session.access_token || !session.refresh_token) throw new AppError('The sign-in provider returned no session.', 401);
  const value = seal({ access_token: session.access_token, refresh_token: session.refresh_token, expires_at: session.expires_at || Math.floor(Date.now() / 1000) + Number(session.expires_in || 3600) }, 'v3-session');
  if (value.length > 3800) throw new AppError('The authentication session is too large for a secure cookie.', 500);
  writeCookie(res, 'session', value);
}

/** Refresh a web session as needed and verify its user with Supabase on every request. */
export async function authenticate(req, res, fetchImpl = fetch) {
  const cookie = readCookie(req, 'session');
  if (!cookie) throw new AppError('Sign in to continue.', 401);
  let session = unseal(cookie, 'v3-session');
  if (session.expires_at < Date.now() / 1000 + 60) {
    session = await authRequest('token?grant_type=refresh_token', { refresh_token: session.refresh_token }, undefined, 'POST', fetchImpl);
    saveSession(res, session);
  }
  const user = await authRequest('user', undefined, session.access_token, 'GET', fetchImpl);
  if (!user.id || !user.email_confirmed_at) throw new AppError('Confirm your email before continuing.', 401);
  return { user, session };
}

/** Keep return paths on this site; preserve MCP consent without accepting open redirects. */
export function safeReturn(value) {
  if (typeof value !== 'string' || !value.startsWith('/') || value.startsWith('//') || value.includes('\\') || value.length > 1500) return '/#agent';
  const url = new URL(value, appOrigin());
  return url.origin === appOrigin() ? url.pathname + url.search + url.hash : '/#agent';
}

/** Bind the next OAuth/email callback to this browser with a short-lived encrypted PKCE verifier. */
function beginPkce(res, next, recovery = false) {
  const verifier = randomBytes(48).toString('base64url');
  writeCookie(res, 'pkce', seal({ verifier, next: safeReturn(next), recovery, expires: Date.now() + 1800000 }, 'v3-pkce'), 1800);
  return createHash('sha256').update(verifier).digest('base64url');
}

/** Start Google sign-in at Supabase; users enter Google credentials only at Google. */
export function googleSignIn(res, next) {
  const challenge = beginPkce(res, next);
  const url = new URL(`${serviceOrigin('SUPABASE_URL')}/auth/v1/authorize`);
  url.search = new URLSearchParams({ provider: 'google', redirect_to: `${appOrigin()}/auth/callback`, code_challenge: challenge, code_challenge_method: 's256' });
  return { url: url.href };
}

/** Complete a PKCE callback once; a confirmation opened on another device can still sign in afterward. */
export async function finishSignIn(req, res, code, fetchImpl = fetch) {
  const raw = readCookie(req, 'pkce');
  if (!raw) throw new AppError('This sign-in link was opened in a different browser or expired. Return to Canvasly and sign in.', 401);
  const state = unseal(raw, 'v3-pkce');
  if (state.expires < Date.now()) throw new AppError('Sign-in expired. Start again.', 401);
  writeCookie(res, 'pkce', '', 0);
  const session = await authRequest('token?grant_type=pkce', { auth_code: bounded(code, 2000), code_verifier: state.verifier }, undefined, 'POST', fetchImpl);
  saveSession(res, session);
  return state.recovery ? '/#reset-password' : safeReturn(state.next);
}

/** Handle ordinary email/password signup and login with public registration and email confirmation. */
export async function emailSignIn(res, input, fetchImpl = fetch) {
  const email = bounded(input.email || '', 320).trim(), password = bounded(input.password || '', 512);
  if (!email.includes('@') || password.length < 8) throw new AppError('Enter your email and a password of at least eight characters.');
  if (input.signup === true) {
    const challenge = beginPkce(res, input.next);
    const session = await authRequest(`signup?redirect_to=${encodeURIComponent(appOrigin() + '/auth/callback')}`, { email, password, data: { full_name: bounded(input.name || '', 100) }, code_challenge: challenge, code_challenge_method: 's256' }, undefined, 'POST', fetchImpl);
    if (session.access_token) { saveSession(res, session); return { signed_in: true }; }
    return { confirmation_required: true, message: 'Check your email to confirm your account, then sign in.' };
  }
  const session = await authRequest('token?grant_type=password', { email, password }, undefined, 'POST', fetchImpl);
  saveSession(res, session);
  return { signed_in: true };
}

/** Send a recovery email without revealing whether a particular email address is registered. */
export async function recoverPassword(res, input, fetchImpl = fetch) {
  const challenge = beginPkce(res, '/#reset-password', true);
  await authRequest(`recover?redirect_to=${encodeURIComponent(appOrigin() + '/auth/callback')}`, { email: bounded(input.email || '', 320), code_challenge: challenge, code_challenge_method: 's256' }, undefined, 'POST', fetchImpl);
  return { message: 'Check your inbox for a password-reset link.' };
}

/** End the provider session and clear this browser's cookie even if remote logout is unavailable. */
export async function signOut(res, session, fetchImpl = fetch) {
  try { await authRequest('logout?scope=local', {}, session.access_token, 'POST', fetchImpl); }
  finally { writeCookie(res, 'session', '', 0); }
  return { signed_out: true };
}
