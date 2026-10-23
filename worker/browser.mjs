import { randomUUID } from 'node:crypto';
import { AppError, seal, unseal, digest, fingerprint, id, plain, validateDeliverable } from '../lib/security.mjs';
import { publicUrl, publicOrigin, publicDns } from '../lib/app/network.mjs';

const LOGIN_FIELDS = 'input[type="password"],input[autocomplete="one-time-code"]';
const SENSITIVE_ACTION = /\b(submit|finish|turn in|send|pay|purchase|buy|delete|withdraw|enroll|drop course)\b/i;

/** Visible DOM extraction runs in the page and returns coursework fields, never cookies or credentials. */
export function canvasPageData() {
  const env = window.ENV || {};
  const a = env.ASSIGNMENT || env.assignment || {};
  const title = document.querySelector('h1.title,h1')?.textContent?.trim() || document.title;
  const description = document.querySelector('#assignment_show .description,.assignment-description,.user_content')?.innerText || '';
  const details = document.querySelector('.assignment.details,.assignment-details,.student-assignment-overview')?.innerText || document.querySelector('#assignment_show')?.innerText || '';
  const statusText = document.querySelector('.submission-details,.submission_status,.submission-status')?.innerText || '';
  const resubmit = [...document.querySelectorAll('a,button')].some(/* Restrict completion evidence to a named action. */ node => /re[ -]?submit assignment/i.test(node.textContent || ''));
  const types = Array.isArray(a.submission_types) ? a.submission_types : [];
  if (!types.length) {
    if (/text entry|text box/i.test(details)) types.push('online_text_entry');
    if (/file upload/i.test(details)) types.push('online_upload');
    if (/website url|website address/i.test(details)) types.push('online_url');
    if (document.querySelector('iframe#tool_content,form[action*="external_tools"]')) types.push('external_tool');
  }
  const submission = a.submission || env.SUBMISSION || {};
  const submitted = !!submission.submitted_at || ['submitted','graded','pending_review'].includes(submission.workflow_state) || resubmit || (/\bsubmitted\b/i.test(statusText) && !/not submitted|no submission|unsubmitted/i.test(statusText));
  return { id: a.id, name: a.name || title, description: a.description || description, instructions: description, submission_types: types,
    due_at: a.due_at || document.querySelector('time[datetime]')?.getAttribute('datetime') || null,
    due_text: details.slice(0, 2000), rubric: a.rubric || [], is_quiz_assignment: !!a.is_quiz_assignment || /\/quizzes\//.test(location.pathname), quiz_id: a.quiz_id || null,
    locked_for_user: !!a.locked_for_user || /this assignment is locked/i.test(details), submitted, submission: { id: submission.id || null, submitted_at: submission.submitted_at || null, workflow_state: submitted ? 'submitted' : 'unsubmitted' },
    evidence: statusText.slice(0, 2000), url: location.href };
}

/** Extract course links from the authenticated All Courses page rather than a dashboard favorites list. */
export function courseLinks() {
  const records = new Map();
  for (const link of document.querySelectorAll('a[href]')) {
    const url = new URL(link.href, location.href), match = /^\/courses\/(\d+)\/?$/.exec(url.pathname);
    const name = link.textContent.trim();
    if (url.origin === location.origin && match && name) records.set(Number(match[1]), { id: Number(match[1]), name, code: name, url: url.href });
  }
  return [...records.values()];
}

/** Read visible assignment links and machine-readable dates; never guess deadlines from ambiguous text. */
export function assignmentLinks() {
  const records = new Map();
  for (const link of document.querySelectorAll('a[href]')) {
    const url = new URL(link.href, location.href), match = /^\/courses\/(\d+)\/assignments\/(\d+)\/?$/.exec(url.pathname);
    if (url.origin !== location.origin || !match || !link.textContent.trim()) continue;
    const row = link.closest('.assignment,li,[data-assignment-id]') || link.parentElement;
    const text = row?.innerText || '';
    records.set(Number(match[2]), { id: Number(match[2]), course_id: Number(match[1]), name: link.textContent.trim(), url: url.href,
      due_at: row?.querySelector('time[datetime]')?.getAttribute('datetime') || null, due_text: text.slice(0, 700),
      submission_types: [], submitted: false, submission_state: 'unknown', source: 'browser', details_pending: true });
  }
  return [...records.values()];
}

/** Run isolated Chromium processes on demand; saved cookies are encrypted and bound to one owner. */
export class BrowserManager {
  /** Inject a Playwright chromium launcher and a protected egress proxy; never expose CDP publicly. */
  constructor(store, chromium, proxyUrl) { this.store = store; this.chromium = chromium; this.proxyUrl = proxyUrl; this.sessions = new Map(); this.opening = new Set(); this.maximum = Math.max(1, Math.min(20, Number(process.env.BROWSER_CONCURRENCY) || 2)); }

  /** Open or reuse a single-owner browser; interactive login cannot race an automated task. */
  async open(userId, origin, interactive = false) {
    origin = publicOrigin(origin); await publicDns(new URL(origin).hostname);
    const old = this.sessions.get(userId);
    if (old) {
      if (old.origin !== origin || old.interactive !== interactive) throw new AppError('Finish the active browser connection or task before starting another.', 409);
      old.touched = Date.now(); return old;
    }
    if (this.opening.has(userId)) throw new AppError('Your browser is starting. Try again shortly.', 409);
    if (this.sessions.size + this.opening.size >= this.maximum) throw new AppError('All browser slots are busy. Your queued work will wait; try connecting again shortly.', 429);
    this.opening.add(userId); let browser;
    try {
      const row = await this.store.read(userId), connection = row.data.connection;
      const storageState = connection?.origin === origin && connection.browser_state ? unseal(connection.browser_state, `v3-browser:${userId}`) : undefined;
      browser = await this.chromium.launch({ headless: true, chromiumSandbox: true, ...(process.env.BROWSER_EXECUTABLE_PATH ? { executablePath: process.env.BROWSER_EXECUTABLE_PATH } : {}),
        proxy: { server: this.proxyUrl }, args: ['--proxy-bypass-list=<-loopback>', '--force-webrtc-ip-handling-policy=disable_non_proxied_udp', '--disable-quic'] });
      const context = await browser.newContext({ storageState, viewport: { width: 1280, height: 800 }, acceptDownloads: false, serviceWorkers: 'block', timezoneId: row.data.profile.timezone });
      context.setDefaultTimeout(12000); context.setDefaultNavigationTimeout(25000);
      await context.route('**/*', /* Network defense in depth; the proxy also pins DNS for every tunnel. */ async route => {
        try { const url = route.request().url(); if (url.startsWith('data:') || url.startsWith('blob:')) return route.continue(); publicUrl(url); return route.continue(); } catch { return route.abort('blockedbyclient'); }
      });
      const session = { id: randomUUID(), userId, origin, browser, context, interactive, created: Date.now(), touched: Date.now(), binding: connection?.binding || null, elements: [], page: await context.newPage() };
      context.on('page', /* LTI launches can open a new tab; retain it in the same isolated context. */ page => { session.page = page; session.elements = []; });
      this.sessions.set(userId, session);
      await session.page.goto(`${origin}/courses`, { waitUntil: 'domcontentloaded' });
      return session;
    } catch (error) { this.sessions.delete(userId); await browser?.close().catch(/* Best-effort cleanup of a failed launch. */ () => {}); throw error; }
    finally { this.opening.delete(userId); }
  }

  /** Return an active session owned by this account; no caller-selected browser IDs are accepted. */
  get(userId, interactive) {
    const session = this.sessions.get(userId);
    if (!session || (interactive !== undefined && session.interactive !== interactive)) throw new AppError('Browser session expired. Connect again.', 410);
    if (session.interactive && session.created < Date.now() - 1800000) throw new AppError('This sign-in window expired. Close it and connect again.', 410);
    session.touched = Date.now(); return session;
  }

  /** Detect password/OTP prompts before any page content can be sent to an AI model. */
  async assertAuthenticated(session) {
    if (await session.page.locator(LOGIN_FIELDS).first().isVisible().catch(/* Missing fields are not an authentication prompt. */ () => false)) throw new AppError('Canvas needs your sign-in or verification. Reconnect on the website.', 401);
    if (/\/(login|signin|sign-in|oauth2\/auth)(\/|\?|$)/i.test(new URL(session.page.url()).pathname)) throw new AppError('Canvas session expired. Reconnect on the website.', 401);
  }

  /** Save only browser storage, never DOM/form contents or login recordings. */
  async persist(session) {
    const state = await session.context.storageState({ indexedDB: true });
    if (Buffer.byteLength(JSON.stringify(state)) > 3000000) throw new AppError('Browser session storage is too large.', 413);
    await this.store.mutate(session.userId, /* Refuse to overwrite a different account or a disconnected session. */ data => {
      if (data.connection?.binding !== session.binding) return false;
      data.connection.browser_state = seal(state, `v3-browser:${session.userId}`);
      data.connection.needs_login = false;
    });
  }

  /** Show a live frame only to the signed-in owner; screenshot bytes are not stored or logged. */
  async frame(userId) {
    const session = this.get(userId, true);
    const image = await session.page.screenshot({ type: 'jpeg', quality: 65 });
    return { image: `data:image/jpeg;base64,${image.toString('base64')}`, url: session.page.url(), width: 1280, height: 800, pages: session.context.pages().map(/* Expose tab labels without cookies or page content. */ page => page.url()) };
  }

  /** Deliver a human's login input directly to Chromium; the request is never sent to the model or saved. */
  async control(userId, input) {
    const session = this.get(userId, true), page = session.page;
    if (input.action === 'click') { const x = Number(input.x), y = Number(input.y); if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || x > 1280 || y < 0 || y > 800) throw new AppError('Invalid click.'); await page.mouse.click(x, y); }
    else if (input.action === 'type') { if (typeof input.text !== 'string' || input.text.length > 4000) throw new AppError('Invalid input.'); await page.keyboard.insertText(input.text); }
    else if (input.action === 'key') { if (!['Enter','Tab','Shift+Tab','Backspace','Escape','Control+A','Meta+A','ArrowDown','ArrowUp','Space'].includes(input.key)) throw new AppError('Unsupported key.'); await page.keyboard.press(input.key); }
    else if (input.action === 'scroll') await page.mouse.wheel(0, Math.max(-800, Math.min(800, Number(input.y) || 0)));
    else if (input.action === 'tab') { const index = Number(input.index); if (!Number.isInteger(index) || !session.context.pages()[index]) throw new AppError('Unknown tab.'); session.page = session.context.pages()[index]; }
    else if (input.action === 'back') await page.goBack({ waitUntil: 'domcontentloaded' });
    else throw new AppError('Unsupported browser control.');
    return { accepted: true };
  }

  /** Verify the logged-in Canvas identity before trusting saved browser storage for unattended work. */
  async completeLogin(userId) {
    const session = this.get(userId, true);
    await session.page.goto(`${session.origin}/courses`, { waitUntil: 'domcontentloaded' });
    await this.assertAuthenticated(session);
    const identity = await session.page.evaluate(/* Read only public identity fields provided by the Canvas page. */ () => ({ id: window.ENV?.current_user_id, name: window.ENV?.current_user?.display_name || window.ENV?.current_user?.name || 'Canvas account' }));
    if (!Number.isSafeInteger(Number(identity.id)) || Number(identity.id) < 1 || new URL(session.page.url()).origin !== session.origin) throw new AppError('Could not verify a signed-in Canvas account. Finish signing in before continuing.', 401);
    const binding = digest([session.origin, Number(identity.id)]), state = await session.context.storageState({ indexedDB: true });
    if (Buffer.byteLength(JSON.stringify(state)) > 3000000) throw new AppError('Browser session storage is too large.', 413);
    await this.store.mutate(userId, /* Merge API credentials only after confirming the same Canvas identity. */ data => {
      const old = data.connection;
      data.connection = { origin: session.origin, name: identity.name, canvas_id: Number(identity.id), binding, kind: old?.binding === binding && old.credentials ? 'api+browser' : 'browser', browser_state: seal(state, `v3-browser:${userId}`), ...(old?.binding === binding && old.credentials ? { credentials: old.credentials } : {}) };
      if (old?.binding !== binding) data.snapshot = { courses: [], assignments: [], warnings: [] };
    });
    session.binding = binding;
    await this.close(userId, false);
    return { connected: true };
  }

  /** Close and optionally persist a session, reclaiming memory instead of keeping every browser running. */
  async close(userId, persist = true) {
    const session = this.sessions.get(userId); if (!session) return;
    this.sessions.delete(userId);
    try { if (persist && !session.interactive && session.binding) await this.persist(session); }
    finally { await session.browser.close(); }
  }

  /** Reclaim abandoned interactive sessions; state from unfinished sign-in is not saved. */
  async sweep() { for (const [userId, session] of this.sessions) if (session.touched < Date.now() - 900000 || (session.interactive && session.created < Date.now() - 1800000)) await this.close(userId); }

  /** Build a connector with the same method names as the official Canvas client. */
  canvas(userId) { return new BrowserCanvas(this, userId); }

  /** Open a persisted connection for the worker, refusing to race live human control. */
  async automated(userId) {
    const connection = (await this.store.read(userId)).data.connection;
    if (!connection?.browser_state) throw new AppError('Connect a cloud browser first.', 422);
    const session = await this.open(userId, connection.origin, false);
    await this.assertAuthenticated(session);
    return session;
  }

  /** Capture visible text and stable element handles, including LTI iframes, for a bounded agent step. */
  async observe(userId) {
    const session = await this.automated(userId);
    session.elements = []; let text = '';
    for (const frame of session.page.frames().slice(0, 8)) {
      if (frame.url() !== 'about:blank') publicUrl(frame.url());
      if (await frame.locator(LOGIN_FIELDS).first().isVisible().catch(/* Detached frames contain no readable login fields. */ () => false)) throw new AppError('An external tool needs your sign-in. Open the cloud connection.', 401);
      text += '\n' + (await frame.locator('body').innerText().catch(/* Detached/empty frames may be skipped without pretending they were read. */ () => '')).slice(0, 16000);
      const handles = await frame.locator('a[href],button,input:not([type=hidden]),textarea,select,[role=button],[contenteditable=true]').elementHandles();
      for (const handle of handles.slice(0, 220)) {
        if (session.elements.length >= 160) break;
        if (!await handle.isVisible()) continue;
        const meta = await handle.evaluate(/* Return element labels, never the current value of input fields. */ element => ({ tag: element.tagName.toLowerCase(), type: element.getAttribute('type') || '', label: (element.getAttribute('aria-label') || element.getAttribute('placeholder') || element.textContent || element.getAttribute('name') || '').trim().slice(0, 240), href: element.tagName === 'A' ? element.href : null }));
        if (meta.type === 'password') continue;
        session.elements.push({ handle, meta });
      }
    }
    return { url: new URL(session.page.url()).origin + new URL(session.page.url()).pathname, text: text.slice(0, 28000), elements: session.elements.map(/* Omit signed query parameters from model-visible link metadata. */ (entry, index) => ({ id: index, ...entry.meta, href: entry.meta.href ? new URL(entry.meta.href).origin + new URL(entry.meta.href).pathname : null })) };
  }

  /** Execute a constrained model action; scripts, raw requests, password entry and arbitrary uploads are absent. */
  async act(userId, action, allowSubmit) {
    const session = this.get(userId, false); await this.assertAuthenticated(session);
    if (action.action === 'navigate') {
      const target = publicUrl(action.url).href;
      if (!session.elements.some(/* Only links observed on the current page can be followed. */ entry => entry.meta.href && new URL(entry.meta.href).href === target)) throw new AppError('The agent requested a link not present on this page.', 403);
      await session.page.goto(target, { waitUntil: 'domcontentloaded' });
    } else if (action.action === 'scroll') await session.page.mouse.wheel(0, 650);
    else if (action.action === 'inspect') return { inspected: true };
    else {
      const entry = session.elements[Number(action.element_id)];
      if (!entry || !Number.isInteger(action.element_id) || !await entry.handle.evaluate(/* Reject stale handles after navigation or DOM replacement. */ element => element.isConnected)) throw new AppError('The page changed. Inspect it again.', 409);
      const type = await entry.handle.getAttribute('type');
      const autocomplete = await entry.handle.getAttribute('autocomplete');
      if (type === 'password' || autocomplete === 'one-time-code') throw new AppError('The agent cannot enter sign-in credentials.', 403);
      if (!allowSubmit && ['fill','select'].includes(action.action)) throw new AppError('This external website may save or submit answers immediately. Authorize this assignment before the agent enters answers.', 409);
      const destructive = SENSITIVE_ACTION.test(entry.meta.label) || type === 'submit';
      if ((action.action === 'click' || action.action === 'press') && destructive && !allowSubmit) throw new AppError('This action needs task-specific submission authorization.', 409);
      if (/\b(pay|purchase|buy|delete|withdraw|drop course|enroll)\b/i.test(entry.meta.label)) throw new AppError('This account or payment action is outside the assignment task.', 403);
      if (action.action === 'click') await entry.handle.click();
      else if (action.action === 'fill') { if (typeof action.text !== 'string' || action.text.length > 30000) throw new AppError('Input too long.'); await entry.handle.fill(action.text); }
      else if (action.action === 'select') await entry.handle.selectOption(String(action.text || ''));
      else if (action.action === 'press') { if (!allowSubmit || action.text !== 'Enter') throw new AppError('Only authorized Enter actions are supported.', 403); await entry.handle.press('Enter'); }
      else throw new AppError('Unsupported agent action.');
    }
    session.elements = [];
    await this.persist(session);
    return { action: action.action, url: session.page.url() };
  }
}

/** Browser fallback for supported Canvas pages; this is UI access, not an OAuth API grant. */
class BrowserCanvas {
  /** Bind every operation to the authenticated workspace and its manager. */
  constructor(manager, userId) { this.manager = manager; this.userId = userId; }

  /** Read a page in the connected school's origin after checking the saved session. */
  async page(path) {
    const session = await this.manager.automated(this.userId);
    await session.page.goto(new URL(path, session.origin).href, { waitUntil: 'domcontentloaded' });
    await this.manager.assertAuthenticated(session);
    return session.page;
  }

  /** Gather actual All Courses links and assignment listings; missing deadlines are explicitly reported. */
  async snapshot() {
    const page = await this.page('/courses'), courses = await page.evaluate(courseLinks), assignments = [], warnings = [];
    const deadline = Date.now() + 160000;
    for (const course of courses.slice(0, 100)) {
      if (Date.now() > deadline) { warnings.push('Browser sync time budget reached. This listing is partial; use the API connection for large course histories.'); break; }
      try { const list = await (await this.page(`/courses/${id(course.id)}/assignments`)).evaluate(assignmentLinks); assignments.push(...list); }
      catch { warnings.push(`${course.name}: assignment listing could not be read.`); }
    }
    if (courses.length > 100) warnings.push('More than 100 course links were found; this browser sync is partial.');
    if (assignments.some(/* Do not invent a timezone or deadline when the UI omits a timestamp. */ assignment => !assignment.due_at)) warnings.push('Some browser listings did not expose exact due timestamps. API connection or opening individual assignments may provide more detail; unknown deadlines are not guessed.');
    await this.manager.persist(this.manager.get(this.userId, false));
    return { courses, assignments, warnings, synced_at: new Date().toISOString(), source: 'browser' };
  }

  /** Read current assignment instructions and visible submission options from its actual page. */
  async assignment(courseId, assignmentId) {
    const page = await this.page(`/courses/${id(courseId)}/assignments/${id(assignmentId)}`);
    const assignment = await page.evaluate(canvasPageData);
    return { ...assignment, id: id(assignmentId), course_id: id(courseId), name: assignment.name || `Assignment ${assignmentId}` };
  }

  /** Package UI-readable instructions; advertise missing linked documents instead of fabricating them. */
  async packet(courseId, assignmentId) {
    const a = await this.assignment(courseId, assignmentId);
    const instructions = plain(a.description);
    const warnings = ['Browser source collection includes visible instructions and rubric only. Linked PDFs, hidden pages and external tools require separate inspection.'];
    return { assignment: { ...a, instructions, fingerprint: fingerprint(a) }, sources: [{ name: a.name, kind: 'text', text: instructions }], warnings };
  }

  /** Submit only a validated saved deliverable through known Canvas controls, then verify visible receipt evidence. */
  async submit(courseId, assignmentId, deliverable, live) {
    const d = validateDeliverable(deliverable, live.submission_types), session = await this.manager.automated(this.userId);
    if (live.submitted) throw new AppError('Canvas already shows a submission.', 409);
    const page = session.page;
    const start = page.getByRole('link', { name: /^(start assignment|submit assignment)$/i }).or(page.getByRole('button', { name: /^start assignment$/i })).first();
    if (await start.isVisible()) await start.click();
    if (d.type === 'online_text_entry') {
      const tab = page.getByText('Text Entry', { exact: true }).first(); if (await tab.isVisible()) await tab.click();
      const editor = page.locator('textarea[name="submission[body]"],textarea#submission_body').first();
      if (await editor.isVisible()) await editor.fill(d.body);
      else { let found = false; for (const frame of page.frames()) { const body = frame.locator('body[contenteditable=true]'); if (await body.isVisible().catch(/* Some frames are cross-navigation and detached. */ () => false)) { await body.fill(d.body); found = true; break; } } if (!found) throw new AppError('Canvas text editor was not recognized. Open the cloud browser.'); }
    } else if (d.type === 'online_upload') {
      await page.locator('input[type=file]').first().setInputFiles(d.files.map(/* Only this deliverable's bounded UTF-8 content is uploaded. */ file => ({ name: file.name, mimeType: 'text/plain', buffer: Buffer.from(file.content) })));
    } else {
      const tab = page.getByText('Website URL', { exact: true }).first(); if (await tab.isVisible()) await tab.click();
      await page.locator('input[name="submission[url]"],input[type=url]').first().fill(d.url);
    }
    await page.getByRole('button', { name: /^submit assignment$/i }).click();
    // A write has happened: never blindly retry if the next read cannot confirm it.
    await page.waitForLoadState('domcontentloaded');
    const receipt = await this.assignment(courseId, assignmentId);
    if (!receipt.submitted) throw new AppError('Canvas did not expose a confirmed submission receipt. Check manually.', 409);
    await this.manager.persist(session);
    return { id: assignmentId, submitted_at: receipt.submission?.submitted_at || null, verified_at: new Date().toISOString(), evidence: receipt.evidence, source: 'canvas_ui' };
  }
}
