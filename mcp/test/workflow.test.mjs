import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CanvasClient } from '../src/canvas.mjs';
import { DraftQueue, CourseworkModel, textFile, validateDeliverable, safeFileName, autoDraft } from '../src/workflow.mjs';

const orig = 'https://school.instructure.com';
const assignment = { id: 23, course_id: 11, name: 'Research report', submission_types: ['online_text_entry', 'online_upload', 'online_url'] };
const fake = (a = assignment) => ({ getAssignment: async () => a, submitAssignment: async (cid, aid, type, payload) => ({ workflow_state: 'submitted', submitted_at: '2026-10-18T15:00:00Z', type, payload }), uploadSubmissionFile: async () => ({ id: 77 }) });
async function queue() { return new DraftQueue(await mkdtemp(path.join(os.tmpdir(), 'canvas-queue-'))); }

test('validates deliverables against assignment types and rejects unsafe file names', () => {
  assert.throws(() => validateDeliverable({ type: 'online_url', url: 'javascript:alert(1)' }, ['online_url']));
  assert.throws(() => validateDeliverable({ type: 'online_text_entry', body: 'hello' }, ['online_upload']));
  assert.throws(() => safeFileName('../exploit.js'));
  assert.throws(() => safeFileName('go.sh'));
  const result = validateDeliverable({ type: 'online_upload', files: [textFile('answer.py', 'print(1)')] }, ['online_upload']);
  assert.equal(Buffer.from(result.files[0].content_base64, 'base64').toString(), 'print(1)');
});

test('cannot submit a staged draft until explicitly approved', async () => {
  const q = await queue(), api = fake();
  const staged = await q.stage(api, { course_id: 11, assignment_id: 23, deliverable: { type: 'online_text_entry', body: '<p>My answer</p>' } });
  await assert.rejects(q.submit(api, staged.id), /approved/);
  await assert.rejects(q.approve(staged.id, 'yes'), /Exact explicit/);
  await q.approve(staged.id, `APPROVE 23 ${staged.id.slice(0, 8)}`);
  const saved = await q.get(staged.id);
  assert.equal(saved.status, 'approved');
  saved.deliverable.body = 'tampered';
  await q.save(saved);
  await assert.rejects(q.submit(api, staged.id), /unchanged locally approved/);
});

test('approved text-entry submission uses typed Canvas API and marks submitted', async () => {
  const q = await queue();
  let called = null;
  const api = fake();
  api.submitAssignment = async (...args) => { called = args; return { workflow_state: 'submitted', submitted_at: '2026-10-18T15:00:00Z' }; };
  const staged = await q.stage(api, { course_id: 11, assignment_id: 23, deliverable: { type: 'online_text_entry', body: '<h2>My report</h2>' } });
  await q.approve(staged.id, `APPROVE 23 ${staged.id.slice(0, 8)}`);
  const submitted = await q.submit(api, staged.id);
  assert.equal(submitted.status, 'submitted');
  assert.deepEqual(called, [11,23,'online_text_entry',{'submission[body]':'<h2>My report</h2>'}]);
  assert.equal((await q.list()).length, 1);
});

test('file upload uses all file IDs and sends Canvas bearer only to Canvas origin', async () => {
  const calls = [];
  const canvas = new CanvasClient({ baseUrl: orig, token: 'token-NEVER-send-to-storage', fetchImpl: async (url, opts) => {
    calls.push({ url, opts });
    const pathname = new URL(url).pathname;
    if (pathname.endsWith('/submissions/self/files')) {
      assert.match(opts.headers.Authorization, /token-NEVER/);
      return Response.json({ upload_url: 'https://uploads.example.com/upload', upload_params: { key: 'abc' } });
    }
    if (url.startsWith('https://uploads.example.com/upload')) {
      assert.equal(opts.headers, undefined, 'Bearer token must not leak to storage');
      assert.equal(opts.body.get('key'), 'abc');
      return Response.json({ id: 991, display_name: 'script.py' });
    }
    if (pathname.endsWith('/submissions')) {
      assert.equal(opts.headers.Authorization, 'Bearer token-NEVER-send-to-storage');
      assert.match(opts.body, /submission%5Bfile_ids%5D%5B%5D=991/);
      return Response.json({ workflow_state: 'submitted' });
    }
    throw new Error(`Unknown API path ${pathname}`);
  }});
  const q = await queue();
  const api = {
    getAssignment: async () => assignment,
    uploadSubmissionFile: canvas.uploadSubmissionFile.bind(canvas),
    submitAssignment: canvas.submitAssignment.bind(canvas)
  };
  const staged = await q.stage(api, { course_id: 11, assignment_id: 23, deliverable: { type: 'online_upload', files: [textFile('script.py', 'print(1)')] } });
  await q.approve(staged.id, `APPROVE 23 ${staged.id.slice(0, 8)}`);
  assert.equal((await q.submit(api, staged.id)).status, 'submitted');
  assert.equal(calls.length, 3);
});

test('failed submission cannot be blindly retried because Canvas may have already received it', async () => {
  const q = await queue();
  const api = fake();
  api.submitAssignment = async () => { throw new Error('Connection dropped after sending'); };
  const staged = await q.stage(api, { course_id: 11, assignment_id: 23, deliverable: { type: 'online_url', url: 'https://example.com/report' } });
  await q.approve(staged.id, `APPROVE 23 ${staged.id.slice(0, 8)}`);
  await assert.rejects(q.submit(api, staged.id), /Connection dropped/);
  assert.equal((await q.get(staged.id)).status, 'needs_manual_check');
  await assert.rejects(q.submit(api, staged.id), /unchanged locally approved/);
});

test('auto draft uses assignment packet + model reviewer and stages only, never submits', async () => {
  const q = await queue();
  let generated = false;
  const api = {
    getAssignment: async () => ({ ...assignment, description: '<p>Write a summary</p>' }),
    listModules: async () => [],
    submitAssignment: async () => { throw new Error('should never submit during generation'); }
  };
  const model = { model: 'mock', draft: async packet => {
    generated = true;
    assert.match(packet.assignment.instructions, /Write a summary/);
    return { blocked: false, deliverable: { type: 'online_text_entry', body: '<p>Draft result</p>' }, review: { ready: true, issues: [] } };
  } };
  const r = await autoDraft(api, q, model, 11, 23);
  assert.equal(generated, true);
  assert.equal(r.status, 'staged');
  assert.equal(r.approval_required, true);
});

test('model runner makes JSON-only generation and review requests with no Canvas token', async () => {
  const captures = [];
  const model = new CourseworkModel({ apiKey: 'test-model-key', model: 'mock', fetchImpl: async (url, opts) => {
    captures.push({ url, opts });
    const response = captures.length === 1
      ? { blocked: false, requirements: ['Write a report'], deliverables: ['HTML text'], plan: ['Draft'], quality_checks: ['Rubric'] }
      : captures.length === 2 || captures.length === 4
        ? { blocked: false, type: 'online_text_entry', body: '<p>My draft</p>' }
        : { ready: captures.length === 5, issues: ['Needs source'], checks: ['Rubric compared'], limitations: [] };
    return Response.json({ choices: [{ message: { content: JSON.stringify(response) } }] });
  }});
  const result = await model.draft({ assignment: { id: 1, submission_types: ['online_text_entry'], instructions: 'Write a report' }, related_materials: [] });
  assert.equal(result.review.ready, true);
  assert.equal(result.iterations, 2);
  assert.equal(captures.length, 5);
  assert.equal(captures[0].opts.headers.Authorization, 'Bearer test-model-key');
  assert.ok(!JSON.stringify(captures).includes('CANVAS_API_TOKEN'));
});
