import test from 'node:test';
import assert from 'node:assert/strict';
import handler from '../lib/legacy-api.mjs';
import { unseal } from '../lib/security.mjs';
const env = { APP_ENCRYPTION_KEY: 'ef'.repeat(32), APP_URL: 'http://localhost:3000', SUPABASE_URL: 'https://db.example.test', SUPABASE_PUBLISHABLE_KEY: 'test-anon', SUPABASE_SECRET_KEY: 'test-service', CANVAS_ALLOWED_HOSTS: 'school.instructure.com', OPENAI_API_KEY: 'test-openai-key' };
Object.assign(process.env, env);
const uid = '11111111-1111-4111-8111-111111111111';
function request(op, body, cookie = '', extra = {}) {
  return new Promise(resolve => {
    const headers = {}, res = { statusCode: 200, setHeader(k, v) { headers[k.toLowerCase()] = v; }, end(text) { resolve({ status: this.statusCode, headers, data: JSON.parse(text) }); } };
    handler({ method: body === undefined ? 'GET' : 'POST', url: `/api/index?op=${op}`, headers: { origin: env.APP_URL, 'content-type': 'application/json', cookie, ...extra }, ...(body === undefined ? {} : { body }), socket: { remoteAddress: '127.0.0.1' } }, res);
  });
}
test('full HTTP-handler workflow with mocked Supabase, Canvas and OpenAI', async () => {
  const original = globalThis.fetch;
  const tables = { canvasly_connections: [], canvasly_workspaces: [], canvasly_drafts: [] }; let modelCalls = 0, submissions = 0;
  const assignment = { id: 20, course_id: 10, name: 'Explain linear regression', description: '<p>Explain linear regression and its assumptions.</p>', submission_types: ['online_text_entry'], points_possible: 100, rubric: [], allowed_extensions: [], submission: { workflow_state: 'unsubmitted' } };
  globalThis.fetch = async (target, options = {}) => {
    const url = new URL(target), payload = options.body && String(options.headers?.['Content-Type']).includes('json') ? JSON.parse(options.body) : null;
    if (url.hostname === 'db.example.test') {
      if (url.pathname.startsWith('/auth/v1/token')) return Response.json({ access_token: 'validated-by-mock-auth-user', refresh_token: 'mock-refresh', expires_in: 3600 });
      if (url.pathname === '/auth/v1/user') return Response.json({ id: uid, email: 'student@example.test', user_metadata: { name: 'Student' } });
      if (url.pathname.includes('/rpc/')) return Response.json(true);
      assert.equal(options.headers.apikey, 'test-service');
      const name = url.pathname.split('/').pop(), rows = tables[name]; assert.ok(rows, name);
      const matches = row => [...url.searchParams].filter(([, v]) => v.startsWith('eq.')).every(([k, v]) => String(row[k]) === v.slice(3));
      if (options.method === 'POST') {
        const existing = url.searchParams.has('on_conflict') ? rows.find(r => r.user_id === payload.user_id) : null;
        if (existing) Object.assign(existing, payload); else rows.push({ created_at: new Date().toISOString(), updated_at: new Date().toISOString(), ...payload });
        return Response.json([existing || rows.at(-1)]);
      }
      if (options.method === 'PATCH') { const selected = rows.filter(matches); selected.forEach(row => Object.assign(row, payload)); return Response.json(selected); }
      if (options.method === 'DELETE') { tables[name] = rows.filter(r => !matches(r)); return Response.json([]); }
      return Response.json(rows.filter(matches));
    }
    if (url.hostname === 'school.instructure.com') {
      assert.equal(options.headers.Authorization, 'Bearer test-canvas-token');
      if (url.pathname.endsWith('/users/self/profile')) return Response.json({ id: 7, name: 'Canvas Student' });
      if (url.pathname.endsWith('/courses')) return Response.json([{ id: 10, name: 'Machine Learning', course_code: 'CS101' }]);
      if (url.pathname.endsWith('/modules')) return Response.json([]);
      if (url.pathname.endsWith('/assignments')) return Response.json([assignment]);
      if (url.pathname.endsWith('/assignments/20')) return Response.json(assignment);
      if (url.pathname.endsWith('/submissions') && options.method === 'POST') { submissions++; assert.ok(new URLSearchParams(options.body).get('submission[body]').startsWith('<pre>')); return Response.json({ id: 800, submitted_at: new Date().toISOString() }); }
      assert.fail(`Unhandled Canvas request: ${url}`);
    }
    if (url.hostname === 'api.openai.com') {
      modelCalls++; assert.ok(!options.body.includes('test-canvas-token')); assert.equal(payload.store, false);
      const phase = payload.text.format.name.split('_').pop();
      const result = phase === 'plan' ? { steps: ['Explain', 'List assumptions'], requirements: ['Explanation'], missing_context: [] } : phase === 'write' ? { body: 'Linear regression models a conditional mean with a linear function.', files: [], notes: [] } : { summary: 'A model-based review, not a grade.', criteria: [{ criterion: 'Explanation', status: 'met', feedback: 'Included.' }], concerns: [] };
      return Response.json({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(result) }] }] });
    }
    assert.fail(`Unexpected outbound request: ${url}`);
  };
  try {
    const login = await request('auth/login', { email: 'student@example.test', password: 'long-example-password' }); assert.equal(login.status, 200);
    const cookie = login.headers['set-cookie'].split(';')[0]; assert.ok(login.headers['set-cookie'].includes('HttpOnly')); assert.ok(!cookie.includes('mock-refresh'));
    let r = await request('connect', { origin: 'https://school.instructure.com', token: 'test-canvas-token' }, cookie); assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.equal(unseal(tables.canvasly_connections[0].token_encrypted, `canvas:${uid}`).token, 'test-canvas-token');
    assert.ok(!JSON.stringify(r.data).includes('test-canvas-token'));
    r = await request('sync', {}, cookie); assert.equal(r.status, 200); assert.equal(r.data.assignments.length, 1);
    r = await request('draft/create', { course_id: 10, assignment_id: 20, consent: true }, cookie); assert.equal(r.status, 201, JSON.stringify(r.data));
    const draftId = r.data.id;
    for (const stage of ['planned', 'written', 'ready']) { r = await request('draft/step', { id: draftId }, cookie); assert.equal(r.status, 200, JSON.stringify(r.data)); assert.equal(r.data.stage, stage); }
    assert.equal(submissions, 0); assert.equal(modelCalls, 3);
    r = await request('draft/save', { id: draftId, version: r.data.version, deliverable: { type: 'online_text_entry', body: 'Edited, reviewed explanation.' } }, cookie); assert.equal(r.status, 200); assert.equal(r.data.stage, 'written');
    r = await request('draft/step', { id: draftId }, cookie); assert.equal(r.status, 200); assert.equal(r.data.stage, 'ready');
    const rejected = await request('draft/submit', { id: draftId, confirmation: 'yes', content_hash: r.data.content_hash }, cookie); assert.equal(rejected.status, 400); assert.equal(submissions, 0);
    r = await request('draft/submit', { id: draftId, confirmation: 'SUBMIT', content_hash: r.data.content_hash }, cookie); assert.equal(r.status, 200, JSON.stringify(r.data)); assert.equal(r.data.stage, 'submitted'); assert.equal(submissions, 1);
    const workspace = await request('workspace', undefined, cookie); assert.equal(workspace.status, 200); assert.equal(workspace.data.drafts.length, 1); assert.ok(!JSON.stringify(workspace.data).includes('test-canvas-token'));
    // The fake store honors user_id filtering. A different user receives no existing draft.
    const leaked = await request(`draft&id=${draftId}`, undefined, ''); assert.equal(leaked.status, 401);
    r = await request('erase', { confirmation: 'DELETE' }, cookie); assert.equal(r.status, 200); assert.equal(tables.canvasly_drafts.length, 0);
  } finally { globalThis.fetch = original; }
});
test('public config exposes key names, never secret values; private data needs authentication', async () => {
  const config = await request('config'); assert.equal(config.status, 200); assert.ok(!JSON.stringify(config.data).includes('test-openai-key'));
  const privateData = await request('workspace'); assert.equal(privateData.status, 401);
});
test('cross-origin state changes and oversized requests are rejected before authentication', async () => {
  const origin = await request('connect', {}, '', { origin: 'https://evil.example' }); assert.equal(origin.status, 403);
  const large = await request('connect', {}, '', { 'content-length': '9000000' }); assert.equal(large.status, 413);
});
