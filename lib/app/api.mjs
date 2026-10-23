import { AppError, bounded, digest } from '../security.mjs';
import { AppStore, publicState } from './store.mjs';
import { appOrigin, json, readInput, rawBody, requireOrigin } from './config.mjs';
import { authenticate, emailSignIn, googleSignIn, finishSignIn, recoverPassword, authRequest, signOut } from './auth.mjs';
import { checkout, portal, applyWebhook } from './billing.mjs';
import { startCanvas, finishCanvas } from './canvas.mjs';
import { oauthRoute, consentDetails, consent } from './oauth.mjs';
import { mcpHandler } from './mcp.mjs';
import { workerCall, RemoteBrowser } from './worker-client.mjs';
import { delegate, chat, enqueue, controlJob, saveDraft, reviewDraft, submitDraft } from './jobs.mjs';
import { executeTool, approveMemory } from './tools.mjs';
import { validateProfile } from '../../public/domain.mjs';

/** Report setup readiness without disclosing any key, client secret, hostname allowlist or internal token. */
function configuration() {
  return { auth_ready: !!(process.env.SUPABASE_URL && process.env.SUPABASE_PUBLISHABLE_KEY && process.env.SUPABASE_SECRET_KEY && process.env.APP_ENCRYPTION_KEY),
    worker_configured: !!(process.env.WORKER_URL && process.env.WORKER_SECRET), billing_ready: !!(process.env.STRIPE_SECRET_KEY && process.env.STRIPE_PRICE_ID && process.env.STRIPE_WEBHOOK_SECRET),
    ai_ready: !!process.env.OPENAI_API_KEY, mcp_url: `${appOrigin()}/mcp`, price: { amount: 20, currency: 'USD', interval: 'month' } };
}

/** Redirect only to a provider-generated or internally validated destination, without caching account callbacks. */
function redirect(res, location) { res.writeHead(303, { Location: location, 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' }); res.end(); }

/** Detect the trusted platform client address for abuse controls; it is never a school or email allowlist. */
function clientAddress(req) { return process.env.VERCEL ? String(req.headers['x-vercel-forwarded-for'] || req.headers['x-forwarded-for'] || '').split(',')[0].trim() : req.socket?.remoteAddress || 'local'; }

/** Create the HTTP router with injectable transports so integration tests cannot charge or submit real work. */
export function createHandler({ store = new AppStore(), fetchImpl = fetch, worker = workerCall, browser = new RemoteBrowser(fetchImpl) } = {}) {
  /** Dispatch one bounded request; web identity is never taken from JSON user_id fields. */
  return async function handler(req, res) {
    const url = new URL(req.url, appOrigin());
    if (url.searchParams.has('route')) url.pathname = url.searchParams.get('route');
    const op = url.searchParams.get('op') || 'state';
    try {
      if (url.pathname === '/api/stripe') {
        if (req.method !== 'POST') throw new AppError('Method not allowed.', 405);
        return json(res, await applyWebhook(store, await rawBody(req, 1200000), req.headers['stripe-signature']));
      }
      if (url.pathname.startsWith('/.well-known/') || (url.pathname.startsWith('/oauth/') && url.pathname !== '/oauth/consent')) {
        if (!url.pathname.startsWith('/.well-known/')) await store.rate(`oauth:${clientAddress(req)}:${url.pathname}`, url.pathname === '/oauth/register' ? 10 : 120);
        return await oauthRoute(store, req, res, url);
      }
      if (url.pathname === '/mcp') return await mcpHandler(store, req, res, browser);
      if (url.pathname === '/auth/callback') {
        if (req.method !== 'GET') throw new AppError('Method not allowed.', 405);
        return redirect(res, appOrigin() + await finishSignIn(req, res, url.searchParams.get('code'), fetchImpl));
      }
      if (url.pathname === '/canvas/callback') {
        if (req.method !== 'GET') throw new AppError('Method not allowed.', 405);
        const { user } = await authenticate(req, res, fetchImpl); await store.register(user);
        await finishCanvas(store, user.id, req, res, url.searchParams);
        return redirect(res, `${appOrigin()}/#connections`);
      }
      if (op === 'config' && req.method === 'GET') return json(res, configuration());
      const reads = ['state','oauth/consent','mcp/grants'];
      if (!['GET','POST'].includes(req.method) || (req.method === 'GET' && !reads.includes(op))) throw new AppError('Method not allowed.', 405);
      if (req.method === 'POST') requireOrigin(req);
      const input = req.method === 'POST' ? await readInput(req) : {};
      if (['auth/email','auth/google','auth/recover'].includes(op)) {
        if (req.method !== 'POST') throw new AppError('Method not allowed.', 405);
        await store.rate(`auth:${clientAddress(req)}`, 20, 300);
        const result = op === 'auth/email' ? await emailSignIn(res, input, fetchImpl) : op === 'auth/google' ? googleSignIn(res, input.next) : await recoverPassword(res, input, fetchImpl);
        return json(res, result);
      }
      const { user, session } = await authenticate(req, res, fetchImpl);
      const row = await store.register(user);
      await store.rate(`web:${user.id}`, op.startsWith('browser/') ? 300 : 120);
      if (op === 'state') {
        const [billing, workers] = await Promise.all([store.billing(user.id), store.db('canvasly_workers?select=heartbeat_at&order=heartbeat_at.desc&limit=1')]);
        return json(res, { ...publicState(row), billing, config: configuration(), worker_online: !!workers[0] && Date.parse(workers[0].heartbeat_at) > Date.now() - 60000 });
      }
      if (op === 'auth/logout') return json(res, await signOut(res, session, fetchImpl));
      if (op === 'auth/password') { const password = bounded(input.password || '', 512); if (password.length < 8) throw new AppError('Use a password of at least eight characters.'); await authRequest('user', { password }, session.access_token, 'PUT', fetchImpl); return json(res, { saved: true }); }
      if (op === 'billing/checkout') return json(res, await checkout(store, user));
      if (op === 'billing/portal') return json(res, await portal(store, user));
      if (op === 'oauth/consent') return json(res, await consentDetails(store, url.searchParams.get('authorization_id')));
      if (op === 'oauth/decision') return json(res, await consent(store, user.id, input.id, input.approve === true));
      if (op === 'mcp/grants') return json(res, await store.db(`canvasly_oauth_grants?user_id=eq.${user.id}&select=id,client_id,scopes,revoked_at,created_at`));
      if (op === 'mcp/revoke') { if (!/^[a-f0-9-]{36}$/.test(input.id || '')) throw new AppError('Invalid connection.'); await store.db(`canvasly_oauth_grants?user_id=eq.${user.id}&id=eq.${input.id}`, 'PATCH', { revoked_at: new Date().toISOString() }); return json(res, { revoked: true }); }
      if (op === 'profile/save') {
        let profile; try { profile = validateProfile(input.profile); } catch (error) { throw new AppError(error.message); }
        await store.mutate(user.id, /* Refuse stale profile edits instead of losing approved memories. */ data => { if (data.profile_revision !== input.revision) throw new AppError('Your profile changed. Refresh before editing.', 409); data.profile = profile; data.profile_revision++; data.plan = null; });
        return json(res, { saved: true });
      }
      if (op === 'memory/decide') return json(res, await approveMemory(store, user.id, input.id, input.accept === true));
      if (op === 'plan') return json(res, await executeTool(store, user.id, 'plan_week'));
      if (op === 'canvas/start') return json(res, startCanvas(user.id, res, input));
      if (op === 'canvas/sync') return json(res, await enqueue(store, user.id, { kind: 'sync', title: 'Syncing Canvas', step: 'sync' }), 202);
      if (op === 'canvas/disconnect') {
        let closed = false;
        try { await worker(user.id, 'browser/close', { discard: true }, fetchImpl); closed = true; } catch { /* Clear stored credentials even when the worker cannot be reached. */ }
        await store.mutate(user.id, /* Revocation makes further worker checkpoints fail their account binding checks. */ data => { data.connection = null; data.snapshot = { courses: [], assignments: [], warnings: [] }; data.plan = null; for (const job of data.jobs) if (['queued','running'].includes(job.status)) { job.cancel_requested = true; if (job.status === 'queued') job.status = 'paused'; } });
        return json(res, { disconnected: true, browser_closed: closed, message: closed ? 'Saved connection deleted. Revoke any Canvas OAuth grant in your Canvas account settings too.' : 'Saved connection deleted. Worker closure was not confirmed; revoke the school session from Canvas/security settings.' });
      }
      if (op.startsWith('browser/')) {
        if (!['browser/start','browser/frame','browser/input','browser/finish','browser/close','browser/resume'].includes(op)) throw new AppError('Unknown browser action.');
        // Input is relayed directly to the isolated browser, never added to logs, model context or storage.
        return json(res, await worker(user.id, op, input, fetchImpl));
      }
      if (op === 'chat') return json(res, await chat(store, user.id, input), 202);
      if (op === 'delegate') return json(res, await delegate(store, user.id, input, true), 202);
      if (op === 'job/control') return json(res, await controlJob(store, user.id, input));
      if (op === 'draft/save') return json(res, await saveDraft(store, user.id, input));
      if (op === 'draft/review') return json(res, await reviewDraft(store, user.id, input.id), 202);
      if (op === 'draft/submit') return json(res, await submitDraft(store, user.id, input), 202);
      if (op === 'data/clear') {
        if (input.confirmation !== 'DELETE') throw new AppError('Type DELETE to clear your application data.');
        await worker(user.id, 'browser/close', { discard: true }, fetchImpl);
        await store.mutate(user.id, /* Preserve account identity and billing; erase coursework and local connection secrets. */ data => { if (data.jobs.some(/* Let in-flight side effects settle before deleting their receipts. */ job => job.status === 'running')) throw new AppError('Pause tasks and wait for the current step before clearing data.', 409); data.connection = null; data.snapshot = { courses: [], assignments: [], warnings: [] }; data.messages = []; data.jobs = []; data.drafts = []; data.proposals = []; data.plan = null; data.profile.memories = []; data.profile.observations = []; data.profile_revision++; });
        return json(res, { cleared: true });
      }
      throw new AppError('Not found.', 404);
    } catch (error) {
      if (url.pathname.endsWith('/callback')) return redirect(res, `${appOrigin()}/?connection_error=${encodeURIComponent(error instanceof AppError ? error.message : 'Connection failed. Try again.')}#connections`);
      return json(res, { error: error instanceof AppError ? error.message : 'Request failed. Check your connection and server setup.' }, error instanceof AppError ? error.status : 500);
    }
  };
}

export const handler = createHandler();
