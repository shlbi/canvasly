import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { runStep, submitDraft, publicDraft, Model } from '../lib/agent.mjs';
import { AppError, digest, fingerprint } from '../lib/security.mjs';
const live = { id: 2, course_id: 1, name: 'Example', description: '<p>Explain a sorting algorithm.</p>', submission_types: ['online_text_entry'], rubric: [], submission: { workflow_state: 'unsubmitted' } };
function fixture() {
  const row = { id: randomUUID(), user_id: randomUUID(), connection_key: 'account-a', course_id: 1, assignment_id: 2, title: 'Example', stage: 'created', version: 0, revisions: 0, format: 'online_text_entry', packet: { assignment: { ...live, fingerprint: fingerprint(live) }, sources: [{ name: 'notes.pdf', kind: 'pdf', data: 'SECRET_BASE64' }], warnings: [] }, updated_at: new Date().toISOString() };
  const db = { row, calls: 0, async quota() {}, async lock(d, stage) { if (d.version !== this.row.version || d.stage !== this.row.stage) throw new AppError('Changed', 409); this.row = { ...this.row, stage, version: d.version + 1, updated_at: new Date().toISOString() }; return structuredClone(this.row); }, async finish(d, fields) { if (d.version !== this.row.version) throw new AppError('Changed', 409); this.row = { ...this.row, ...fields }; return structuredClone(this.row); } };
  return db;
}
const model = { async run(phase) { return { result: phase === 'plan' ? { steps: ['Read', 'Write'], requirements: ['Explain'], missing_context: [] } : phase === 'write' ? { body: 'A sorting algorithm arranges elements by an ordering relation.', files: [], notes: [] } : { summary: 'Model opinion only.', criteria: [{ criterion: 'Explanation', status: 'met', feedback: 'Present.' }], concerns: [] } }; } };
async function ready(db) { for (let i = 0; i < 3; i++) await runStep(db, model, structuredClone(db.row)); return structuredClone(db.row); }
test('plan, write, and review are separate saved checkpoints', async () => {
  const db = fixture();
  await runStep(db, model, structuredClone(db.row)); assert.equal(db.row.stage, 'planned'); assert.ok(db.row.plan);
  await runStep(db, model, structuredClone(db.row)); assert.equal(db.row.stage, 'written'); assert.ok(db.row.deliverable);
  await runStep(db, model, structuredClone(db.row)); assert.equal(db.row.stage, 'ready'); assert.ok(db.row.review); assert.equal(db.row.version, 3);
});
test('a failed model call restores the previous state without losing saved work', async () => {
  const db = fixture(); await runStep(db, model, structuredClone(db.row));
  await assert.rejects(runStep(db, { async run() { throw new Error('Provider unavailable'); } }, structuredClone(db.row)));
  assert.equal(db.row.stage, 'planned'); assert.ok(db.row.plan); assert.equal(db.row.error, 'Provider unavailable');
});
test('rate limits prevent a model call', async () => {
  const db = fixture(); db.quota = async () => { throw new AppError('Limit', 429); };
  await assert.rejects(runStep(db, { run() { assert.fail('Must not call model'); } }, structuredClone(db.row)));
  assert.equal(db.row.stage, 'created');
});
test('stale step recovery advances the version to invalidate late writes', async () => {
  const db = fixture(); db.row.stage = 'writing'; db.row.updated_at = new Date(Date.now() - 150000).toISOString();
  const stale = structuredClone(db.row);
  await runStep(db, model, stale); assert.equal(db.row.stage, 'planned'); assert.equal(db.row.version, 1);
  await assert.rejects(db.finish(stale, { stage: 'written' }));
});
test('active steps do not run twice', async () => {
  const db = fixture(); db.row.stage = 'planning';
  await assert.rejects(runStep(db, model, structuredClone(db.row)), /still running/);
});
test('submission requires exact confirmation and saved-content digest', async () => {
  const db = fixture(), d = await ready(db); let calls = 0;
  const canvas = { async assignment() { calls++; return live; } };
  await assert.rejects(submitDraft(db, canvas, d, 'yes', digest(d.deliverable), 'account-a'));
  await assert.rejects(submitDraft(db, canvas, d, 'SUBMIT', 'old-digest', 'account-a'));
  assert.equal(calls, 0);
});
test('changed instructions and different Canvas accounts block submission', async () => {
  const db = fixture(), d = await ready(db), hash = digest(d.deliverable);
  await assert.rejects(submitDraft(db, { async assignment() { return { ...live, description: 'New task' }; } }, d, 'SUBMIT', hash, 'account-a'), /assignment changed/i);
  await assert.rejects(submitDraft(db, {}, d, 'SUBMIT', hash, 'another-account'), /another Canvas/);
});
test('existing Canvas submissions are not silently overwritten', async () => {
  const db = fixture(), d = await ready(db);
  await assert.rejects(submitDraft(db, { async assignment() { return { ...live, submission: { workflow_state: 'submitted' } }; } }, d, 'SUBMIT', digest(d.deliverable), 'account-a'), /already has a submission/);
});
test('successful submission records a receipt and rejects repeat submission', async () => {
  const db = fixture(), d = await ready(db); let calls = 0;
  const canvas = { async assignment() { return live; }, async submit() { calls++; return { id: 999, submitted_at: new Date().toISOString() }; } };
  await submitDraft(db, canvas, d, 'SUBMIT', digest(d.deliverable), 'account-a');
  assert.equal(db.row.stage, 'submitted'); assert.equal(db.row.submission_id, 999); assert.equal(calls, 1);
  await assert.rejects(submitDraft(db, canvas, structuredClone(db.row), 'SUBMIT', digest(d.deliverable), 'account-a')); assert.equal(calls, 1);
});
test('uncertain submission outcomes are frozen for manual checking', async () => {
  const db = fixture(), d = await ready(db);
  await assert.rejects(submitDraft(db, { async assignment() { return live; }, async submit() { throw new Error('Network disconnected after POST'); } }, d, 'SUBMIT', digest(d.deliverable), 'account-a'));
  assert.equal(db.row.stage, 'needs_manual_check');
});
test('public draft responses strip PDF bytes and internal user binding', async () => {
  const db = fixture(), d = await ready(db), pub = publicDraft(d);
  assert.equal(pub.user_id, undefined); assert.equal(pub.connection_key, undefined); assert.equal(pub.packet.sources[0].data, undefined); assert.ok(pub.content_hash);
});
test('OpenAI requests use structured outputs, disable storage, and reject incomplete output', async () => {
  process.env.OPENAI_API_KEY = 'test-api-key'; const db = fixture(); db.row.packet.sources = [];
  const m = new Model(async (url, init) => {
    assert.equal(url, 'https://api.openai.com/v1/responses'); const body = JSON.parse(init.body);
    assert.equal(body.store, false); assert.equal(body.text.format.strict, true); assert.equal(body.input[0].role, 'user');
    assert.ok(!init.body.includes('token_encrypted')); return Response.json({ status: 'incomplete', output: [] });
  });
  await assert.rejects(m.run('plan', db.row), /incomplete/);
});
