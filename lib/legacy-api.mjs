import { randomUUID } from 'node:crypto';
import { AppError, requireValue, bounded, seal, unseal, digest, id, uuid, permittedEmail, validateDeliverable } from './security.mjs';
import { Store, authCall, setSession, clearSession, authenticate } from './platform.mjs';
import { Canvas, assertOpen } from './canvas.mjs';
import { Model, runStep, submitDraft, publicDraft } from './agent.mjs';
const required = ['SUPABASE_URL', 'SUPABASE_PUBLISHABLE_KEY', 'SUPABASE_SECRET_KEY', 'APP_ENCRYPTION_KEY', 'APP_URL', 'CANVAS_ALLOWED_HOSTS'];
async function bodyOf(req) {
  if (!String(req.headers['content-type'] || '').startsWith('application/json')) throw new AppError('Use application/json.', 415);
  const max = 2800000;
  if (Number(req.headers['content-length'] || 0) > max) throw new AppError('Request is too large.', 413);
  if (req.body !== undefined) {
    const text = typeof req.body === 'string' ? req.body : JSON.stringify(req.body);
    if (Buffer.byteLength(text) > max) throw new AppError('Request is too large.', 413);
    try { return JSON.parse(text); } catch { throw new AppError('Invalid JSON.'); }
  }
  const chunks = []; let size = 0;
  for await (const chunk of req) { size += chunk.length; if (size > max) throw new AppError('Request is too large.', 413); chunks.push(chunk); }
  try { return JSON.parse(Buffer.concat(chunks).toString() || '{}'); } catch { throw new AppError('Invalid JSON.'); }
}
export function requireOrigin(req) {
  const expected = new URL(requireValue('APP_URL')).origin;
  if (req.headers.origin !== expected) throw new AppError('Origin mismatch. Open the app at APP_URL, or update APP_URL for this environment.', 403);
}
function sourcesFromInput(sources = []) {
  if (!Array.isArray(sources) || sources.length > 3) throw new AppError('Add at most three extra sources.');
  return sources.map(s => {
    const name = bounded(s.name, 150);
    if (s.kind === 'pdf') {
      const data = bounded(s.data, 1350000);
      if (!data.startsWith('data:application/pdf;base64,') || !Buffer.from(data.split(',')[1], 'base64').subarray(0, 5).equals(Buffer.from('%PDF-'))) throw new AppError('Upload a valid PDF under 1 MB.');
      return { name, kind: 'pdf', data };
    }
    return { name, kind: 'text', text: bounded(s.text, 35000) };
  });
}
export default async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store, private');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  const send = (data, status = 200) => { res.statusCode = status; res.end(JSON.stringify(data)); };
  try {
    const url = new URL(req.url, 'http://localhost'), op = url.searchParams.get('op') || 'config';
    if (req.method === 'GET' && op === 'config') return send({ ready: required.every(k => process.env[k]), ai_ready: !!process.env.OPENAI_API_KEY, missing: required.filter(k => !process.env[k]), model: process.env.OPENAI_MODEL || 'gpt-4.1-mini' });
    if (!['GET', 'POST'].includes(req.method)) throw new AppError('Method not allowed.', 405);
    let body = {};
    if (req.method === 'POST') { requireOrigin(req); body = await bodyOf(req); }
    const store = new Store();
    if (op.startsWith('auth/') && req.method === 'POST' && !['auth/password', 'auth/logout'].includes(op)) {
      const ip = req.headers['x-vercel-forwarded-for'] || req.socket?.remoteAddress || 'unknown';
      await store.quota(`auth:${digest([String(ip), requireValue('APP_ENCRYPTION_KEY')]).slice(0, 24)}:${Math.floor(Date.now() / 3600000)}`, 30);
      if (['auth/login', 'auth/signup', 'auth/reset'].includes(op)) {
        const email = bounded(body.email, 254).trim().toLowerCase();
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new AppError('Enter a valid email address.');
        permittedEmail(email);
        if (op === 'auth/reset') { await authCall(`recover?redirect_to=${encodeURIComponent(requireValue('APP_URL'))}`, { email }); return send({ message: 'Check your email for a password reset link.' }); }
        const password = bounded(body.password, 128);
        if (password.length < 10) throw new AppError('Use a password with at least 10 characters.');
        const session = await authCall(op === 'auth/login' ? 'token?grant_type=password' : `signup?redirect_to=${encodeURIComponent(requireValue('APP_URL'))}`, { email, password, ...(op === 'auth/signup' ? { data: { name: bounded(body.name || email.split('@')[0], 80) } } : {}) });
        if (session.access_token) { setSession(res, session); return send({ signed_in: true }); }
        return send({ message: 'Check your email to confirm your account, then sign in.' });
      }
      if (op === 'auth/exchange') {
        const access = bounded(body.access_token, 6000), refresh = bounded(body.refresh_token, 2000);
        const user = await authCall('user', null, access, 'GET'); permittedEmail(user.email);
        const claims = JSON.parse(Buffer.from(access.split('.')[1], 'base64url').toString());
        setSession(res, { access_token: access, refresh_token: refresh, expires_at: claims.exp });
        return send({ signed_in: true });
      }
    }
    if (op === 'auth/logout' && req.method === 'POST') {
      try { const current = await authenticate(req, res); await authCall('logout', null, current.session.access_token); } catch {}
      clearSession(res); return send({ ok: true });
    }
    const { user, session } = await authenticate(req, res);
    const uid = user.id;
    if (op === 'auth/password' && req.method === 'POST') {
      const password = bounded(body.password, 128); if (password.length < 10) throw new AppError('Use at least 10 characters.');
      await authCall('user', { password }, session.access_token, 'PUT'); return send({ ok: true });
    }
    if (op === 'workspace' && req.method === 'GET') {
      const [connection, workspace, drafts] = await Promise.all([
        store.one('canvasly_connections', uid), store.one('canvasly_workspaces', uid),
        store.call(`canvasly_drafts?user_id=eq.${uid}&order=updated_at.desc&limit=100&select=id,course_id,assignment_id,title,stage,updated_at,error,revisions`)
      ]);
      return send({ user: { name: user.user_metadata?.name || user.email.split('@')[0], email: user.email }, connection: connection ? { origin: connection.origin, name: connection.name } : null, data: workspace?.data || { courses: [], assignments: [], warnings: [] }, drafts });
    }
    if (op === 'connect' && req.method === 'POST') {
      await store.quota(`connect:${uid}:${Math.floor(Date.now() / 3600000)}`, 12);
      const client = new Canvas(bounded(body.origin, 300), bounded(body.token, 2000));
      const me = await client.self();
      const connectionKey = digest([client.origin, me.id]);
      const old = await store.one('canvasly_connections', uid);
      if (old && old.connection_key !== connectionKey) await store.remove('canvasly_workspaces', uid);
      await store.upsert('canvasly_connections', { user_id: uid, origin: client.origin, token_encrypted: seal({ token: body.token }, `canvas:${uid}`), canvas_user_id: id(me.id), name: String(me.name || 'Student'), connection_key: connectionKey });
      return send({ connected: true, name: me.name });
    }
    if (op === 'disconnect' && req.method === 'POST') {
      await store.remove('canvasly_connections', uid); await store.remove('canvasly_workspaces', uid); return send({ ok: true });
    }
    if (op === 'erase' && req.method === 'POST') {
      if (body.confirmation !== 'DELETE') throw new AppError('Type DELETE to delete workspace data.');
      for (const table of ['canvasly_drafts', 'canvasly_workspaces', 'canvasly_connections']) await store.remove(table, uid);
      return send({ ok: true });
    }
    if (op === 'draft' && req.method === 'GET') return send(publicDraft(await store.draft(uid, uuid(url.searchParams.get('id')))));
    if (op === 'draft/save' && req.method === 'POST') {
      const draft = await store.draft(uid, uuid(body.id));
      if (!['written', 'ready'].includes(draft.stage)) throw new AppError('Only an inactive, unsubmitted draft can be edited.', 409);
      if (body.version !== draft.version) throw new AppError('A newer version exists. Refresh before editing.', 409);
      const deliverable = validateDeliverable(body.deliverable, draft.packet.assignment.submission_types);
      const locked = await store.lock(draft, 'written');
      return send(publicDraft(await store.finish(locked, { deliverable, review: null })));
    }
    const connection = await store.one('canvasly_connections', uid);
    if (!connection) throw new AppError('Connect Canvas in Settings first.', 409);
    const canvas = new Canvas(connection.origin, unseal(connection.token_encrypted, `canvas:${uid}`).token);
    if (op === 'sync' && req.method === 'POST') {
      await store.quota(`sync:${uid}:${Math.floor(Date.now() / 60000)}`, 3);
      const data = await canvas.snapshot(); await store.upsert('canvasly_workspaces', { user_id: uid, data, synced_at: data.synced_at }); return send(data);
    }
    if (op === 'assignment' && req.method === 'GET') return send(await canvas.packet(id(url.searchParams.get('course')), id(url.searchParams.get('assignment'))));
    if (op === 'draft/create' && req.method === 'POST') {
      if (body.consent !== true) throw new AppError('Confirm that the selected course materials may be sent to OpenAI.');
      await store.quota(`drafts:${uid}:${new Date().toISOString().slice(0, 10)}`, 30);
      const packet = await canvas.packet(id(body.course_id), id(body.assignment_id)); assertOpen(packet.assignment);
      if (body.format && !packet.assignment.submission_types.includes(body.format)) throw new AppError('Unsupported assignment format.');
      const format = body.format || (packet.assignment.submission_types.includes('online_text_entry') ? 'online_text_entry' : packet.assignment.submission_types.includes('online_upload') ? 'online_upload' : 'online_url');
      packet.sources.push(...sourcesFromInput(body.sources));
      if (JSON.stringify(packet.sources).length > 2600000) throw new AppError('Combined sources exceed 2.6 MB. Remove extra PDFs or use text excerpts.');
      const d = { id: randomUUID(), user_id: uid, connection_key: connection.connection_key, course_id: id(body.course_id), assignment_id: id(body.assignment_id), title: packet.assignment.name, format, notes: bounded(body.notes || '', 10000), packet, stage: 'created', version: 0, revisions: 0 };
      if (format === 'online_url') Object.assign(d, { stage: 'written', deliverable: validateDeliverable({ type: format, url: body.url }, [format]) });
      return send(publicDraft(await store.insert('canvasly_drafts', d)), 201);
    }
    if (op === 'draft/step' && req.method === 'POST') {
      const draft = await store.draft(uid, uuid(body.id));
      if (draft.connection_key !== connection.connection_key) throw new AppError('Reconnect this draft’s original Canvas account to continue.', 409);
      return send(publicDraft(await runStep(store, new Model(), draft, body.action === 'revise' ? 'revise' : 'next', bounded(body.note || '', 8000))));
    }
    if (op === 'draft/submit' && req.method === 'POST') {
      const draft = await store.draft(uid, uuid(body.id));
      return send(publicDraft(await submitDraft(store, canvas, draft, body.confirmation, body.content_hash, connection.connection_key)));
    }
    throw new AppError('API route not found.', 404);
  } catch (e) {
    // Never log credentials, model prompts, coursework, cookies, or raw provider payloads.
    const requestId = randomUUID().slice(0, 8);
    if (!e.status) console.error(JSON.stringify({ event: 'canvasly_error', requestId, kind: e.name || 'Error' }));
    send({ error: e.status ? e.message : e.name === 'TimeoutError' || e.name === 'AbortError' ? 'The request timed out. Refresh and resume from the saved checkpoint.' : `Request failed. Try again; reference ${requestId}.` }, e.status || 500);
  }
}
