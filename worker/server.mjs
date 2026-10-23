import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { AppError, id, unseal, requireValue } from '../lib/security.mjs';
import { AppStore } from '../lib/app/store.mjs';
import { readInput, json, equalSecret } from '../lib/app/config.mjs';
import { processOne } from '../lib/app/run.mjs';
import { BrowserManager } from './browser.mjs';
import { startEgressProxy } from './proxy.mjs';

/** Sleep without holding a database connection; the durable queue lives in Postgres. */
function delay(milliseconds) { return new Promise(/* Resolve the polling delay without creating background work in Vercel. */ resolve => setTimeout(resolve, milliseconds)); }

/** Run only documented browser commands for an existing account selected by the trusted website backend. */
export async function command(store, browser, body) {
  const userId = String(body.user_id || ''), input = body.input || {};
  if (!/^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i.test(userId)) throw new AppError('Invalid account.');
  const row = await store.read(userId);
  if (!row) throw new AppError('Account not found.', 404);
  if (body.op === 'browser/start' || body.op === 'browser/resume') {
    await store.rate(`browser-start:${userId}`, 10, 3600);
    if (row.data.jobs.some(/* A human takeover must not race an in-flight model step. */ job => job.status === 'running')) throw new AppError('Pause the active task and wait for its current step before opening the browser.', 409);
    if (body.op === 'browser/resume') {
      const job = row.data.jobs.find(/* Only the owner can restore the selected task's encrypted destination. */ item => item.id === input.job_id);
      if (!job || !['paused','done'].includes(job.status) || !row.data.connection) throw new AppError('Pause this task before taking over its browser.');
      await browser.close(userId);
      const session = await browser.open(userId, row.data.connection.origin, true);
      if (job.resume_url) {
        const target = unseal(job.resume_url, `v3-browser-job:${job.id}`);
        // Chromium network requests remain subject to the public-only egress proxy.
        await session.page.goto(typeof target === 'string' ? target : target.url, { waitUntil: 'domcontentloaded' });
      }
    } else await browser.open(userId, input.origin, true);
    return { opened: true };
  }
  if (body.op === 'browser/frame') return browser.frame(userId);
  if (body.op === 'browser/input') return browser.control(userId, input);
  if (body.op === 'browser/finish') return browser.completeLogin(userId);
  if (body.op === 'browser/close') { await browser.close(userId, input.discard !== true); return { closed: true }; }
  if (body.op === 'canvas/packet' || body.op === 'canvas/assignment') {
    await store.requirePaid(userId);
    if (browser.sessions.get(userId)?.job_id) throw new AppError('Pause the external task before navigating its browser to another assignment.', 409);
    if (row.data.jobs.some(/* A remote read cannot steal the page being used by an assignment step. */ job => job.status === 'running')) throw new AppError('Wait for the active task step before reading this assignment.', 409);
    try { return await browser.canvas(userId)[body.op.endsWith('packet') ? 'packet' : 'assignment'](id(input.course_id), id(input.assignment_id)); }
    finally { if (browser.sessions.get(userId)?.interactive === false) await browser.close(userId); }
  }
  throw new AppError('Unknown worker command.', 404);
}

/** Start the isolated Chromium host and durable queue consumer; no browser service subscription is required. */
export async function startWorker({ store = new AppStore(), chromium, port = Number(process.env.PORT || 8080) } = {}) {
  if (requireValue('WORKER_SECRET').length < 32) throw new AppError('WORKER_SECRET must contain at least 32 random characters.', 503);
  requireValue('APP_ENCRYPTION_KEY'); requireValue('OPENAI_API_KEY');
  if (!chromium) ({ chromium } = await import('playwright'));
  const proxy = await startEgressProxy(), browser = new BrowserManager(store, chromium, proxy.url);
  const workerId = randomUUID(), busy = new Set(); let stopped = false, lastCleanup = 0;
  // Probe the actual browser sandbox before advertising an online worker.
  const probe = await chromium.launch({ headless: true, chromiumSandbox: true, ...(process.env.BROWSER_EXECUTABLE_PATH ? { executablePath: process.env.BROWSER_EXECUTABLE_PATH } : {}) });
  await probe.close();
  const server = createServer(/* No cookie or browser user can call the worker directly without the server secret. */ async (req, res) => {
    try {
      if (req.url === '/health' && req.method === 'GET') return json(res, { healthy: !stopped });
      if (req.url !== '/command' || req.method !== 'POST') throw new AppError('Not found.', 404);
      if (!equalSecret(req.headers.authorization, `Bearer ${process.env.WORKER_SECRET}`)) throw new AppError('Unauthorized.', 401);
      const body = await readInput(req, 12000);
      if (busy.has(body.user_id)) throw new AppError('A browser operation is in progress. Try again shortly.', 409);
      busy.add(body.user_id);
      try { return json(res, await command(store, browser, body)); }
      finally { busy.delete(body.user_id); }
    } catch (error) { return json(res, { error: error instanceof AppError ? error.message : 'Browser operation failed. Reconnect or check the worker.' }, error instanceof AppError ? error.status : 500); }
  });
  server.requestTimeout = 55000; server.headersTimeout = 10000;
  await new Promise(/* Bind after Chromium has successfully started with its sandbox enabled. */ (resolve, reject) => { server.once('error', reject); server.listen(port, '0.0.0.0', resolve); });
  /** Refresh liveness and periodically purge expired security metadata without logging student content. */
  async function heartbeat() {
    await store.db('canvasly_workers?on_conflict=worker_id', 'POST', { worker_id: workerId, heartbeat_at: new Date().toISOString() }, 'resolution=merge-duplicates,return=minimal');
    await browser.sweep();
    if (Date.now() - lastCleanup > 3600000) { await store.rpc('canvasly_cleanup'); lastCleanup = Date.now(); }
  }
  /** Claim one account at a time; SQL leases prevent two hosts from executing the same account concurrently. */
  async function loop() {
    while (!stopped) {
      let claim;
      try {
        claim = await store.rpc('canvasly_claim_work');
        if (claim?.user_id) {
          if (!busy.has(claim.user_id) && !browser.sessions.get(claim.user_id)?.interactive) {
            busy.add(claim.user_id);
            try { await processOne(store, claim.user_id, browser); }
            finally {
              try {
                const session = browser.sessions.get(claim.user_id);
                if (session?.interactive === false) {
                  const latest = await store.read(claim.user_id);
                  const current = latest?.data.jobs.find(/* Keep external form state only while its exact task remains active. */ job => job.id === session.job_id);
                  if (!current || current.status !== 'queued' || current.step !== 'browser') await browser.close(claim.user_id).catch(/* Preserve task status if browser cleanup fails. */ () => {});
                }
              } finally { busy.delete(claim.user_id); }
            }
          }
        } else await delay(2000);
      } catch { console.error('Worker step unavailable; queued data is retained. Check database and provider setup.'); await delay(5000); }
      finally { if (claim?.user_id) await store.rpc('canvasly_release_work', { p_user: claim.user_id, p_lease: claim.lease_id }).catch(/* A lost database lease expires without replaying uncertain side effects. */ () => {}); }
    }
  }
  await heartbeat();
  const interval = setInterval(/* A heartbeat is independent of a long model request. */ () => { heartbeat().catch(/* Never print provider tokens, request bodies or browser contents. */ () => console.error('Worker heartbeat unavailable.')); }, 15000);
  const running = loop();
  /** Stop intake, let the current bounded step finish, then close all authenticated browser contexts. */
  async function stop() {
    if (stopped) return;
    stopped = true; clearInterval(interval); server.close();
    await running;
    for (const userId of browser.sessions.keys()) await browser.close(userId).catch(/* Finish cleanup even if one browser has already exited. */ () => {});
    proxy.server.close();
    await store.db(`canvasly_workers?worker_id=eq.${workerId}`, 'DELETE').catch(/* An expired heartbeat is safe when the database is down. */ () => {});
  }
  return { server, browser, stop };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startWorker().then(/* Register shutdown only after startup completed successfully. */ worker => {
    console.log('Canvasly worker ready. Browser debugging ports are not exposed.');
    process.once('SIGTERM', /* Container shutdown leaves saved jobs available for another worker. */ () => worker.stop().then(/* Exit after browser storage is persisted. */ () => process.exit(0)));
    process.once('SIGINT', /* Local shutdown follows the same graceful path. */ () => worker.stop().then(/* Exit only when the active step is settled. */ () => process.exit(0)));
  }).catch(/* Startup errors must not advertise a working queue. */ () => { console.error('Worker startup failed. Check required environment values, database migration and Chromium sandbox support.'); process.exitCode = 1; });
}
