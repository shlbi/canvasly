import { AppError, requireValue, seal, unseal, permittedEmail } from './security.mjs';
const COOKIE = 'canvasly_session';
function base() { return requireValue('SUPABASE_URL').replace(/\/$/, ''); }
export async function authCall(path, body, token, method = 'POST') {
  const res = await fetch(`${base()}/auth/v1/${path}`, {
    method, headers: { apikey: requireValue('SUPABASE_PUBLISHABLE_KEY'), 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(12000), redirect: 'error'
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new AppError(res.status === 429 ? 'Too many authentication attempts. Try again later.' : (data.msg || data.error_description || data.message || 'Authentication failed.').slice(0, 220), res.status === 429 ? 429 : 401);
  return data;
}
export function setSession(res, session) {
  const data = { access_token: session.access_token, refresh_token: session.refresh_token, expires_at: session.expires_at || Math.floor(Date.now() / 1000) + session.expires_in };
  const value = seal(data, 'session');
  if (value.length > 3800) throw new AppError('Authentication session exceeds cookie size.', 500);
  res.setHeader('Set-Cookie', `${COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000${process.env.NODE_ENV === 'production' || process.env.VERCEL ? '; Secure' : ''}`);
}
export function clearSession(res) { res.setHeader('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${process.env.VERCEL ? '; Secure' : ''}`); }
export async function authenticate(req, res) {
  const value = (req.headers.cookie || '').split(';').map(s => s.trim()).find(s => s.startsWith(`${COOKIE}=`))?.slice(COOKIE.length + 1);
  if (!value) throw new AppError('Sign in to continue.', 401);
  let session = unseal(value, 'session');
  if (session.expires_at < Date.now() / 1000 + 60) {
    try { session = await authCall('token?grant_type=refresh_token', { refresh_token: session.refresh_token }); setSession(res, session); }
    catch (e) { clearSession(res); throw e; }
  }
  const user = await authCall('user', null, session.access_token, 'GET');
  if (!user.id) throw new AppError('Sign in again.', 401);
  permittedEmail(user.email);
  return { user, session };
}
export class Store {
  async call(path, { method = 'GET', data, prefer = 'return=representation' } = {}) {
    const key = requireValue('SUPABASE_SECRET_KEY');
    const res = await fetch(`${base()}/rest/v1/${path}`, {
      method, headers: { apikey: key, ...(key.startsWith('sb_secret_') ? {} : { Authorization: `Bearer ${key}` }), 'Content-Type': 'application/json', Prefer: prefer },
      ...(data !== undefined ? { body: JSON.stringify(data) } : {}), signal: AbortSignal.timeout(12000), redirect: 'error'
    });
    if (!res.ok) {
      const code = (await res.json().catch(() => ({}))).code;
      throw new AppError(code === '42P01' || code === 'PGRST205' || code === 'PGRST202' ? 'Database setup is missing. Run supabase/schema.sql in the Supabase SQL editor.' : 'Database request failed. Check server configuration and retry.', 503);
    }
    return res.status === 204 ? null : res.json();
  }
  async one(table, user, extra = '') { return (await this.call(`${table}?user_id=eq.${encodeURIComponent(user)}${extra}&limit=1`))[0] || null; }
  async insert(table, data) { return (await this.call(table, { method: 'POST', data }))[0]; }
  async upsert(table, data) { return (await this.call(`${table}?on_conflict=user_id`, { method: 'POST', data, prefer: 'resolution=merge-duplicates,return=representation' }))[0]; }
  async patch(table, user, filter, data) { return this.call(`${table}?user_id=eq.${encodeURIComponent(user)}${filter}`, { method: 'PATCH', data }); }
  async remove(table, user) { return this.call(`${table}?user_id=eq.${encodeURIComponent(user)}`, { method: 'DELETE' }); }
  async quota(bucket, limit) {
    const allowed = await this.call('rpc/canvasly_take_quota', { method: 'POST', data: { p_bucket: bucket, p_limit: limit } });
    if (!allowed) throw new AppError('Usage limit reached. Please try again after this rate-limit window resets.', 429);
  }
  async draft(user, draftId) {
    const d = await this.one('canvasly_drafts', user, `&id=eq.${draftId}`);
    if (!d) throw new AppError('Draft not found.', 404);
    return d;
  }
  async lock(draft, stage) {
    const result = await this.patch('canvasly_drafts', draft.user_id, `&id=eq.${draft.id}&stage=eq.${draft.stage}&version=eq.${draft.version}`, { stage, version: draft.version + 1, updated_at: new Date().toISOString(), error: null });
    if (!result.length) throw new AppError('This draft changed or another run is active. Refresh before continuing.', 409);
    return result[0];
  }
  async finish(draft, fields) {
    const rows = await this.patch('canvasly_drafts', draft.user_id, `&id=eq.${draft.id}&version=eq.${draft.version}`, { ...fields, updated_at: new Date().toISOString() });
    if (!rows.length) throw new AppError('Draft changed in another session. Refresh it.', 409);
    return rows[0];
  }
}
