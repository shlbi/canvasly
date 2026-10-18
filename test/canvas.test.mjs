import test from 'node:test';
import assert from 'node:assert/strict';
import { Canvas, assertOpen, limitedBody } from '../lib/canvas.mjs';
process.env.CANVAS_ALLOWED_HOSTS = 'school.instructure.com';
const origin = 'https://school.instructure.com';
test('pagination never forwards credentials to another origin', async () => {
  let calls = 0;
  const c = new Canvas(origin, 'canvas-private-token', async () => { calls++; return Response.json([], { headers: { Link: '<https://evil.test/api/v1/courses>; rel="next"' } }); });
  await assert.rejects(c.courses(), /unsafe pagination/); assert.equal(calls, 1);
});
test('pagination truncation is reported explicitly', async () => {
  let page = 0; const c = new Canvas(origin, 'test', async () => Response.json([{ id: ++page }], { headers: { Link: `<${origin}/api/v1/courses?page=${page + 1}>; rel="next"` } }));
  assert.equal((await c.courses()).length, 8); assert.equal(c.warnings.length, 1);
});
test('file uploads do not forward the Canvas token to S3', async () => {
  const c = new Canvas(origin, 'canvas-private-token', async (url, init) => {
    if (String(url).includes('/submissions/self/files')) return Response.json({ upload_url: 'https://bucket.s3.amazonaws.com/upload', upload_params: { policy: 'signed-policy' } });
    assert.ok(String(url).startsWith('https://bucket.s3.amazonaws.com')); assert.equal(init.headers, undefined); assert.ok(init.body instanceof FormData);
    return Response.json({ id: 55 });
  });
  assert.equal(await c.upload(1, 2, { name: 'answer.py', content: 'print(1)' }), 55);
});
test('unsafe upload destinations are blocked before any file bytes leave', async () => {
  let calls = 0; const c = new Canvas(origin, 'test', async () => { calls++; return Response.json({ upload_url: 'http://127.0.0.1/private', upload_params: {} }); });
  await assert.rejects(c.upload(1, 2, { name: 'a.txt', content: 'test' })); assert.equal(calls, 1);
});
test('Canvas submission text is escaped rather than executed as HTML', async () => {
  const c = new Canvas(origin, 'test', async (_url, init) => { assert.equal(new URLSearchParams(init.body).get('submission[body]'), '<pre>&lt;script&gt;alert(1)&lt;/script&gt;</pre>'); return Response.json({ id: 1 }); });
  await c.submit(1, 2, { type: 'online_text_entry', body: '<script>alert(1)</script>' }, { submission_types: ['online_text_entry'] });
});
test('locked assignments, quizzes, and external-tool assessments are not automated', () => {
  for (const a of [{ locked_for_user: true }, { is_quiz_assignment: true }, { submission_types: ['external_tool'] }, { unlock_at: '2999-01-01', submission_types: ['online_text_entry'] }]) assert.throws(() => assertOpen(a));
});
test('source download byte limits are enforced while reading, not just from headers', async () => {
  await assert.rejects(limitedBody(new Response('x'.repeat(1000)), 100), /too large/);
  assert.equal((await limitedBody(new Response('hello'), 100)).toString(), 'hello');
});

test('source code attachment text preserves comparison operators and markup strings', async () => {
  const source = 'if (a < b && b > c) console.log("<div>literal</div>");';
  const c = new Canvas(origin, 'test', async url => String(url).includes('/api/v1/files/') ? Response.json({ display_name: 'answer.js', size: 100, url: `${origin}/files/7/download` }) : new Response(source));
  assert.equal((await c.readFile(7, 'answer.js')).text, source);
});
