import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createHandler } from '../lib/app/api.mjs';
import { processOne } from '../lib/app/run.mjs';
import { delegate, chat, controlJob, saveDraft, reviewDraft, submitDraft } from '../lib/app/jobs.mjs';
import { executeTool } from '../lib/app/tools.mjs';
import { mcpHandler } from '../lib/app/mcp.mjs';
import { saveSession } from '../lib/app/auth.mjs';
import { digest, fingerprint, AppError, unseal } from '../lib/security.mjs';
import { MemoryStore, response, user, connect } from './v3-support.mjs';

process.env.APP_URL = 'https://www.trycanvasly.com';
process.env.APP_ENCRYPTION_KEY = '31'.repeat(32);
process.env.SUPABASE_URL = 'https://fixture.supabase.co';
process.env.SUPABASE_PUBLISHABLE_KEY = 'test-publishable-key';

/** Create a Canvas fixture whose real network and submission paths cannot be invoked. */
function fixture() {
  const store = new MemoryStore(); connect(store);
  const assignment = { id: 71, course_id: 12, name: 'Scheduling lab', description: '<p>Explain FIFO.</p>', instructions: 'Explain FIFO.', submission_types: ['online_text_entry'], rubric: [], allowed_extensions: [], submitted: false, submission: { workflow_state: 'unsubmitted' } };
  assignment.fingerprint = fingerprint(assignment);
  const packet = { assignment: structuredClone(assignment), sources: [], warnings: [] };
  const client = {
    packet: /** Return isolated packet data to detect stale mutation. */ async () => structuredClone(packet),
    assignment: /** Reflect only an explicitly simulated confirmed submission. */ async () => structuredClone(assignment),
    submit: /** Simulate Canvas accepting one write and exposing its receipt. */ async () => { client.submissions++; assignment.submitted = true; assignment.submission = { id: 99, submitted_at: '2026-10-23T01:00:00Z', workflow_state: 'submitted' }; return structuredClone(assignment.submission); },
    snapshot: /** Return a synthetic course list without reading a school account. */ async () => ({ courses: [{ id: 12, name: 'Operating Systems' }], assignments: [structuredClone(assignment)], warnings: [], synced_at: new Date().toISOString() }),
    submissions: 0
  };
  const dependencies = {
    connector: /** Inject the deterministic fixture instead of real Canvas. */ async () => client,
    draft: /** Substitute validated-looking structured model outputs for every phase. */ async (_store, _id, _job, phase) => ({ plan: { steps: ['Explain FIFO'], requirements: ['Complete explanation'], missing_context: [] }, write: { body: 'FIFO serves the oldest queued request first.', files: [], notes: [] }, review: { summary: 'Meets the supplied requirement.', criteria: [{ criterion: 'Explain FIFO', status: 'met', feedback: 'Present.' }], concerns: [] } })[phase]
  };
  return { store, assignment, packet, client, dependencies };
}

/** Drive a bounded set of persisted checkpoints with no web request or browser tab attached. */
async function drain(store, dependencies, count = 8, browser = null) {
  for (let i = 0; i < count; i++) if (!(await processOne(store, user.id, browser, dependencies)).worked) break;
}

/** Build a real encrypted session cookie for HTTP router integration fixtures. */
function cookie() { const res = response(); saveSession(res, { access_token: 'fixture-access', refresh_token: 'fixture-refresh', expires_in: 3600 }); return res.headers['set-cookie'][0].split(';')[0]; }

/** Dispatch the actual router with verified Supabase identity substituted at its HTTP boundary. */
async function http(store, op, input, options = {}) {
  const handler = createHandler({ store, fetchImpl: /** Only the user verification endpoint is valid in this fixture. */ async url => { assert.equal(String(url), `${process.env.SUPABASE_URL}/auth/v1/user`); return Response.json(user); }, worker: /** Never launch a real cloud browser during HTTP tests. */ async () => ({ closed: true }) });
  const res = response();
  await handler({ url: `/api/index?op=${op}`, method: input === undefined ? 'GET' : 'POST', headers: { cookie: cookie(), origin: options.origin || process.env.APP_URL }, ...(input === undefined ? {} : { body: Buffer.from(JSON.stringify(input)) }) }, res);
  return { status: res.statusCode, data: JSON.parse(res.text) };
}

test('v3 website enqueues and worker completes a reviewed deliverable with the laptop disconnected', /* Verify: v3 website enqueues and worker completes a reviewed deliverable with the laptop disconnected. */ async () => {
  const { store, dependencies, client } = fixture();
  const queued = await http(store, 'delegate', { course_id: 12, assignment_id: 71 });
  assert.equal(queued.status, 202); assert.equal(queued.data.status, 'queued');
  await drain(store, dependencies);
  const phone = await http(store, 'state');
  assert.equal(phone.status, 200); assert.equal(phone.data.worker_online, true);
  assert.equal(phone.data.jobs[0].status, 'done'); assert.equal(phone.data.drafts[0].stage, 'ready');
  assert.match(phone.data.drafts[0].deliverable.body, /FIFO/); assert.equal(client.submissions, 0);
  assert.equal(phone.data.connection.browser_state, undefined);
  const draft = phone.data.drafts[0];
  const submitted = await http(store, 'draft/submit', { id: draft.id, confirmation: 'SUBMIT', content_hash: draft.content_hash });
  assert.equal(submitted.status, 202); await drain(store, dependencies);
  assert.equal(client.submissions, 1); assert.equal(store.row.data.drafts[0].stage, 'submitted');
  assert.equal(store.row.data.drafts[0].receipt.id, 99);
  await drain(store, dependencies); assert.equal(client.submissions, 1);
});

test('v3 task-specific advance authorization submits after successful review, not merely enqueue', /* Verify: v3 task-specific advance authorization submits after successful review, not merely enqueue. */ async () => {
  const { store, dependencies, client } = fixture();
  await assert.rejects(delegate(store, user.id, { course_id: 12, assignment_id: 71, submit_when_ready: true, confirmation: 'SUBMIT' }), /authorize/);
  await delegate(store, user.id, { course_id: 12, assignment_id: 71, submit_when_ready: true, confirmation: 'SUBMIT' }, true);
  assert.equal(client.submissions, 0); await drain(store, dependencies);
  assert.equal(client.submissions, 1); assert.equal(store.row.data.jobs[0].result, 'Submitted and verified in Canvas.');
});

test('v3 review concerns withhold automatic submission and edits invalidate prior authorization', /* Verify: v3 review concerns withhold automatic submission and edits invalidate prior authorization. */ async () => {
  const { store, dependencies, client } = fixture();
  const original = dependencies.draft;
  dependencies.draft = /** Inject a reviewer uncertainty that must prevent unattended submission. */ async (...args) => { const output = await original(...args); if (args[3] === 'review') output.concerns = ['A required file is missing.']; return output; };
  await delegate(store, user.id, { course_id: 12, assignment_id: 71, submit_when_ready: true, confirmation: 'SUBMIT' }, true); await drain(store, dependencies);
  const draft = store.row.data.drafts[0]; assert.equal(draft.stage, 'ready'); assert.equal(client.submissions, 0);
  await saveDraft(store, user.id, { id: draft.id, version: draft.version, deliverable: { type: 'online_text_entry', body: 'Edited FIFO explanation.' } });
  assert.equal(store.row.data.drafts[0].review, null); assert.equal(store.row.data.jobs[0].auto_submit, false);
  await assert.rejects(submitDraft(store, user.id, { id: draft.id, confirmation: 'SUBMIT', content_hash: digest(draft.deliverable) }), /Review/);
  await reviewDraft(store, user.id, draft.id); await drain(store, dependencies); assert.equal(store.row.data.drafts[0].stage, 'ready');
});

test('v3 changed assignment instructions block submission before an external write', /* Verify: v3 changed assignment instructions block submission before an external write. */ async () => {
  const { store, dependencies, client, assignment } = fixture();
  await delegate(store, user.id, { course_id: 12, assignment_id: 71 }); await drain(store, dependencies);
  const draft = store.row.data.drafts[0]; assignment.description = 'Changed requirements';
  await submitDraft(store, user.id, { id: draft.id, confirmation: 'SUBMIT', content_hash: digest(draft.deliverable) }); await drain(store, dependencies);
  assert.equal(client.submissions, 0); assert.equal(store.row.data.jobs.at(-1).status, 'paused'); assert.match(store.row.data.jobs.at(-1).error, /changed/i);
});

test('v3 uncertain submission is retained for manual verification and cannot be replayed', /* Verify: v3 uncertain submission is retained for manual verification and cannot be replayed. */ async () => {
  const { store, dependencies, client } = fixture();
  client.submit = /** Simulate a network failure after Canvas may have received the write. */ async () => { client.submissions++; throw new Error('Socket closed after write'); };
  await delegate(store, user.id, { course_id: 12, assignment_id: 71, submit_when_ready: true, confirmation: 'SUBMIT' }, true); await drain(store, dependencies);
  const job = store.row.data.jobs[0]; assert.equal(job.status, 'paused'); assert.equal(job.uncertain, true); assert.equal(store.row.data.drafts[0].stage, 'needs_manual_check');
  await assert.rejects(controlJob(store, user.id, { id: job.id, action: 'resume' }), /uncertain/i);
  await drain(store, dependencies); assert.equal(client.submissions, 1);
});

test('v3 concurrent delegation, job ownership and cancellation checks fail closed', /* Verify: v3 concurrent delegation, job ownership and cancellation checks fail closed. */ async () => {
  const { store, dependencies } = fixture();
  const both = await Promise.allSettled([delegate(store, user.id, { course_id: 12, assignment_id: 71 }), delegate(store, user.id, { course_id: 12, assignment_id: 71 })]);
  assert.equal(both.filter(/* Keep only entries matching this operation’s selection criteria. */ result => result.status === 'fulfilled').length, 1);
  const job = store.row.data.jobs[0]; await controlJob(store, user.id, { id: job.id, action: 'pause' });
  assert.equal((await processOne(store, user.id, null, dependencies)).worked, false);
  await controlJob(store, user.id, { id: job.id, action: 'resume' });
  store.row.data.connection.binding = 'different-account'; await processOne(store, user.id, null, dependencies);
  assert.equal(store.row.data.jobs[0].status, 'paused'); assert.match(store.row.data.jobs[0].error, /different Canvas/);
});

test('v3 model failures and expired leases pause jobs rather than looping or inventing output', /* Verify: v3 model failures and expired leases pause jobs rather than looping or inventing output. */ async () => {
  const { store, dependencies } = fixture();
  await delegate(store, user.id, { course_id: 12, assignment_id: 71 }); await processOne(store, user.id, null, dependencies);
  dependencies.draft = /** Return an explicit provider failure, not a partial successful draft. */ async () => { throw new AppError('Provider quota reached.', 502); };
  await processOne(store, user.id, null, dependencies); assert.equal(store.row.data.jobs[0].status, 'paused'); assert.equal(store.row.data.drafts[0].deliverable, null);
  Object.assign(store.row.data.jobs[0], { status: 'running', lease: { id: 'expired-worker', until: Date.now() - 1 }, side_effect_pending: true });
  await processOne(store, user.id, null, dependencies); assert.equal(store.row.data.jobs[0].uncertain, true);
});

test('v3 web writes enforce origin and subscription before queuing paid work', /* Verify: v3 web writes enforce origin and subscription before queuing paid work. */ async () => {
  const { store } = fixture();
  assert.equal((await http(store, 'delegate', { course_id: 12, assignment_id: 71 }, { origin: 'https://attacker.example' })).status, 403);
  store.active = false; assert.equal((await http(store, 'delegate', { course_id: 12, assignment_id: 71 })).status, 402);
  assert.equal(store.row.data.jobs.length, 0);
});

test('v3 conversational delegation survives a closed client but cannot infer submission approval', /* Verify: v3 conversational delegation survives a closed client but cannot infer submission approval. */ async () => {
  const { store, dependencies } = fixture();
  await chat(store, user.id, { message: 'Prepare my lab.', allow_delegation: true });
  let calls = 0;
  dependencies.call = /** Return a tool request followed by an honest queued acknowledgement. */ async () => (++calls === 1 ? { output: [{ type: 'function_call', call_id: 'c1', name: 'delegate_assignment', arguments: JSON.stringify({ course_id: 12, assignment_id: 71, submit_when_ready: true, confirmation: 'SUBMIT' }) }] } : { output: [{ type: 'message', content: [{ type: 'output_text', text: 'Submission requires your explicit confirmation in My work.' }] }] });
  await drain(store, dependencies);
  assert.equal(store.row.data.jobs.length, 1); assert.equal(store.row.data.jobs[0].status, 'done'); assert.match(store.row.data.messages.at(-1).text, /confirmation/);
});

test('v3 authenticated MCP and website share persisted task IDs, scopes and subscription access', /* Verify: v3 authenticated MCP and website share persisted task IDs, scopes and subscription access. */ async () => {
  const { store, dependencies } = fixture(); const token = 'a'.repeat(43);
  store.rpc = /** Resolve the fixture OAuth access token without accepting website tokens. */ async (name, args) => { assert.equal(name, 'canvasly_mcp_identity'); return { user_id: user.id, scopes: ['canvasly.read','canvasly.write'] }; };
  /** Send one authenticated MCP message to the real stateless transport. */
  async function request(method, params) { const res = response(); await mcpHandler(store, { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: { jsonrpc: '2.0', id: 1, method, params } }, res); return { status: res.statusCode, body: JSON.parse(res.text) }; }
  const initialized = await request('initialize', { protocolVersion: '2025-11-25' }); assert.equal(initialized.body.result.serverInfo.name, 'canvasly');
  const list = await request('tools/list'); assert.ok(list.body.result.tools.some(/* Check whether any entry satisfies this guard. */ tool => tool.name === 'get_deliverable'));
  const delegated = await request('tools/call', { name: 'delegate_assignment', arguments: { course_id: 12, assignment_id: 71 } });
  assert.equal(delegated.body.result.structuredContent.job_id, store.row.data.jobs[0].id);
  await drain(store, dependencies);
  const status = await request('tools/call', { name: 'list_tasks', arguments: {} }); assert.equal(status.body.result.structuredContent.tasks[0].status, 'done');
  const work = await request('tools/call', { name: 'get_deliverable', arguments: { draft_id: store.row.data.drafts[0].id } }); assert.match(work.body.result.structuredContent.deliverable.body, /FIFO/);
  store.active = false; assert.equal((await request('tools/call', { name: 'get_context', arguments: {} })).body.result.isError, true);
});

test('v3 unlinked MCP receives OAuth discovery rather than access to any saved account', /* Verify: v3 unlinked MCP receives OAuth discovery rather than access to any saved account. */ async () => {
  const { store } = fixture(); const res = response();
  await mcpHandler(store, { method: 'POST', headers: {}, body: { jsonrpc: '2.0', id: 1, method: 'tools/list' } }, res);
  assert.equal(res.statusCode, 401); assert.match(res.headers['www-authenticate'], /oauth-protected-resource\/mcp/);
});

test('v3 external browser checkpoint encrypts launch state and requires independent completion evidence', /* Verify: v3 external browser checkpoint encrypts launch state and requires independent completion evidence. */ async () => {
  const { store, dependencies, assignment } = fixture();
  const external = { ...assignment, submission_types: ['external_tool'] };
  dependencies.connector = /** Keep external verification separate from browser action narration. */ async () => ({ packet: /* Implement the packet operation for this scoped object. */ async () => ({ assignment: external, sources: [], warnings: [] }), assignment: /* Implement the assignment operation for this scoped object. */ async () => external });
  let current = 'https://tool.example.com/task?sso=secret';
  const session = { id: randomUUID(), origin: 'https://school.example.com', page: { goto: /* Implement the goto operation for this scoped object. */ async () => {}, screenshot: /* Implement the screenshot operation for this scoped object. */ async () => Buffer.from('fixture'), url: /* Implement the url operation for this scoped object. */ () => current } };
  const browser = { automated: /* Implement the automated operation for this scoped object. */ async () => session, observe: /* Implement the observe operation for this scoped object. */ async () => ({ text: 'Practice activity', elements: [] }), act: /* Implement the act operation for this scoped object. */ async () => {} };
  dependencies.call = /** Return one allowed inspect action, never a claimed real external result. */ async () => ({ output: [{ content: [{ type: 'output_text', text: JSON.stringify({ action: 'inspect', element_id: 0, text: '', summary: 'Read the activity.' }) }] }] });
  await delegate(store, user.id, { course_id: 12, assignment_id: 71 }); await drain(store, dependencies, 2, browser);
  const job = store.row.data.jobs[0]; assert.equal(job.step, 'browser'); assert.ok(!job.resume_url.includes('secret'));
  assert.equal(unseal(job.resume_url, `v3-browser-job:${job.id}`).url, current);
  dependencies.call = /** A model saying finish still needs confirmation from Canvas. */ async () => ({ output: [{ content: [{ type: 'output_text', text: JSON.stringify({ action: 'finish', element_id: 0, text: '', summary: 'Ready.' }) }] }] });
  await drain(store, dependencies, 1, browser); assert.equal(store.row.data.jobs[0].status, 'paused'); assert.match(store.row.data.jobs[0].result, /not confirmed/);
});

test('v3 external form state remains in the same live browser between steps; a lost browser pauses', /** Navigating/reopening after every fill would discard unsaved answers. */ async () => {
  const { store, dependencies, assignment } = fixture();
  dependencies.connector = /** Return only synthetic external assignment metadata. */ async () => ({ packet: /* Implement the packet operation for this scoped object. */ async () => ({ assignment: { ...assignment, submission_types: ['external_tool'] }, sources: [], warnings: [] }) });
  let visits = 0;
  const session = { id: randomUUID(), origin: 'https://school.example.com', page: { goto: /* Implement the goto operation for this scoped object. */ async () => { visits++; }, screenshot: /* Implement the screenshot operation for this scoped object. */ async () => Buffer.from('fixture'), url: /* Implement the url operation for this scoped object. */ () => 'https://tool.example.com/task' } };
  const browser = { automated: /* Implement the automated operation for this scoped object. */ async () => session, observe: /* Implement the observe operation for this scoped object. */ async () => ({ text: 'Exercise', elements: [] }), act: /* Implement the act operation for this scoped object. */ async () => {} };
  dependencies.call = /** Limit this fixture to read-only actions; no real external answers are submitted. */ async () => ({ output: [{ content: [{ type: 'output_text', text: JSON.stringify({ action: 'inspect', element_id: 0, text: '', summary: 'Read next field.' }) }] }] });
  await delegate(store, user.id, { course_id: 12, assignment_id: 71 }); await drain(store, dependencies, 3, browser);
  assert.equal(visits, 1); session.id = randomUUID(); await drain(store, dependencies, 1, browser);
  assert.equal(store.row.data.jobs[0].status, 'paused'); assert.match(store.row.data.jobs[0].error, /live browser session/);
});
