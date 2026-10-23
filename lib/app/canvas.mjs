import { randomBytes } from 'node:crypto';
import { Canvas } from '../canvas.mjs';
import { AppError, seal, unseal, digest, bounded } from '../security.mjs';
import { publicOrigin, publicFetch } from './network.mjs';
import { appOrigin, equalSecret } from './config.mjs';
import { readCookie, writeCookie } from './auth.mjs';

/** Look up an approved API registration; this is credential routing, not a school-admission allowlist. */
function registration(origin) {
  let mappings;
  try { mappings = JSON.parse(process.env.CANVAS_OAUTH_CLIENTS_JSON || '{}'); } catch { throw new AppError('Invalid optional Canvas OAuth configuration.', 503); }
  const hostname = new URL(origin).hostname, match = mappings[hostname];
  // Global credentials may go only to Instructure-owned hosts, never an arbitrary supplied website.
  const global = !match && hostname.endsWith('.instructure.com');
  const id = match?.client_id || (global ? process.env.CANVAS_CLIENT_ID : null);
  const secret = match?.client_secret || (global ? process.env.CANVAS_CLIENT_SECRET : null);
  if (!id || !secret) throw new AppError('No approved Canvas API registration is configured for this school. Use Connect cloud browser instead.', 422);
  return { id, secret, scope: match?.scope };
}

/** Build a DNS-pinned official Canvas client without a manually maintained college list. */
export function canvasClient(origin, token, fetchImpl = publicFetch) {
  return new Canvas(publicOrigin(origin), token, fetchImpl, { originValidator: publicOrigin, maxCourses: 100, timeout: 120000 });
}

/** Start institution-approved OAuth; a student's browser session is never converted into an API token. */
export function startCanvas(userId, res, input) {
  const origin = publicOrigin(input.origin), app = registration(origin), state = randomBytes(32).toString('base64url');
  writeCookie(res, 'canvas_oauth', seal({ userId, origin, state, expires: Date.now() + 600000 }, 'v3-canvas-oauth'), 600);
  const url = new URL('/login/oauth2/auth', origin);
  url.search = new URLSearchParams({ client_id: app.id, response_type: 'code', redirect_uri: `${appOrigin()}/canvas/callback`, state, ...(app.scope ? { scope: app.scope } : {}) });
  return { url: url.href };
}

/** Exchange Canvas codes/refresh tokens only at the validated school's origin. */
async function canvasToken(origin, fields, fetchImpl = publicFetch) {
  const app = registration(origin);
  const response = await fetchImpl(new URL('/login/oauth2/token', origin), { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ client_id: app.id, client_secret: app.secret, ...fields }).toString(), redirect: 'error', signal: AbortSignal.timeout(20000) });
  if (!response.ok) throw new AppError('Canvas authorization expired or the application is not enabled at this school. Reconnect or use the cloud browser.', 401);
  const token = await response.json();
  if (!token.access_token) throw new AppError('Canvas returned no API authorization.', 401);
  return { ...token, expires_at: Date.now() + Number(token.expires_in || 3600) * 1000 };
}

/** Validate callback/account state and save the per-user Canvas token encrypted at rest. */
export async function finishCanvas(store, userId, req, res, query, fetchImpl = publicFetch) {
  const raw = readCookie(req, 'canvas_oauth');
  if (!raw) throw new AppError('Canvas sign-in expired. Start again.', 401);
  const state = unseal(raw, 'v3-canvas-oauth');
  writeCookie(res, 'canvas_oauth', '', 0);
  if (state.userId !== userId || state.expires < Date.now() || !equalSecret(state.state, query.get('state')) || query.has('error')) throw new AppError('Canvas authorization was not completed.', 401);
  const token = await canvasToken(state.origin, { grant_type: 'authorization_code', code: bounded(query.get('code') || '', 4000), redirect_uri: `${appOrigin()}/canvas/callback` }, fetchImpl);
  const self = await canvasClient(state.origin, token.access_token, fetchImpl).self();
  const binding = digest([state.origin, self.id]);
  await store.mutate(userId, /* Preserve a cloud session only when both identities match. */ data => {
    const old = data.connection;
    data.connection = { origin: state.origin, name: self.name, canvas_id: self.id, binding, kind: 'api', credentials: seal(token, `v3-canvas:${userId}`), ...(old?.binding === binding && old.browser_state ? { browser_state: old.browser_state } : {}) };
    if (old?.binding !== binding) data.snapshot = { courses: [], assignments: [], warnings: [] };
  });
}

/** Refresh API credentials server-side and return a client scoped to the exact connected account. */
export async function officialCanvas(store, userId, fetchImpl = publicFetch) {
  const row = await store.read(userId), connection = row.data.connection;
  if (!connection?.credentials) return null;
  let token = unseal(connection.credentials, `v3-canvas:${userId}`);
  if (token.expires_at < Date.now() + 60000) {
    if (!token.refresh_token) throw new AppError('Canvas API authorization expired. Reconnect Canvas.', 401);
    const renewed = await canvasToken(connection.origin, { grant_type: 'refresh_token', refresh_token: token.refresh_token }, fetchImpl);
    token = { ...token, ...renewed, refresh_token: renewed.refresh_token || token.refresh_token };
    await store.mutate(userId, /* Do not overwrite a different account connected during refresh. */ data => {
      if (data.connection?.binding !== connection.binding) throw new AppError('Canvas account changed during this task.', 409);
      data.connection.credentials = seal(token, `v3-canvas:${userId}`);
    });
  }
  return canvasClient(connection.origin, token.access_token, fetchImpl);
}

/** Use official structured APIs when available; otherwise use the authorized cloud UI connector. */
export async function connectionClient(store, userId, browser) {
  const api = await officialCanvas(store, userId);
  if (api) return api;
  const connection = (await store.read(userId)).data.connection;
  if (!connection?.browser_state) throw new AppError('Connect Canvas first.', 422);
  if (!browser) throw new AppError('The cloud-browser worker is unavailable.', 503);
  return browser.canvas(userId);
}
