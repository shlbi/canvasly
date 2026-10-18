import test from 'node:test';
import assert from 'node:assert/strict';
import { CanvasClient, cleanHtml, validatedBaseUrl, radarFromAssignments, assignmentPacket } from '../src/canvas.mjs';

const origin = 'https://university.instructure.com';
function client(routes) {
  return new CanvasClient({ baseUrl: origin, token: 'private-test-token', fetchImpl: async (url, opts) => {
    assert.equal(opts.headers.Authorization, 'Bearer private-test-token');
    const path = new URL(url).pathname;
    const entry = routes[path];
    if (!entry) return new Response('{}', { status: 404 });
    return new Response(JSON.stringify(entry.body), { status: entry.status || 200, headers: entry.headers || {} });
  }});
}

test('rejects insecure and malformed origins', () => {
  assert.throws(() => validatedBaseUrl('http://attacker.example'));
  assert.throws(() => validatedBaseUrl('https://school.instructure.com/path'));
  assert.throws(() => validatedBaseUrl('https://admin:password@school.instructure.com'));
  assert.equal(validatedBaseUrl(origin), origin);
});

test('cleans HTML instructions without running scripts', () => {
  assert.equal(cleanHtml('<h2>Homework</h2><script>alert(1)</script><p>Due &amp; done</p>'), 'Homework\nDue & done');
});

test('Canvas API error never includes server tokens', async () => {
  const api = client({ '/api/v1/users/self/profile': { body: {}, status: 401 } });
  await assert.rejects(api.getSelf(), /Unauthorized/);
});

test('fetches multiple pages via Canvas link header', async () => {
  let calls = 0;
  const api = new CanvasClient({ baseUrl: origin, token: 'x', fetchImpl: async () => {
    calls++;
    return new Response(JSON.stringify([{ id: calls }]), { headers: calls === 1 ? { link: `<${origin}/api/v1/courses?page=2>; rel="next"` } : {} });
  } });
  const response = await api.listCourses();
  assert.deepEqual(response.map(c => c.id), [1, 2]);
});

test('refuses cross-origin paginated Canvas URLs', async () => {
  const api = new CanvasClient({ baseUrl: origin, token: 'x', fetchImpl: async () => new Response('[]', { headers: { link: '<https://evil.example/receive>; rel="next"' } }) });
  await assert.rejects(api.listCourses(), /cross-origin/);
});

test('semester radar detects upcoming and overdue assignments', () => {
  const now = new Date('2026-10-18T12:00:00Z');
  const result = radarFromAssignments([{ course: { id: 1, name: 'AI' }, assignments: [
    { id: 2, name: 'Late', due_at: '2026-10-15T20:00:00Z', submission: { missing: true } },
    { id: 3, name: 'Upcoming', due_at: '2026-10-19T20:00:00Z', submission: {} },
    { id: 4, name: 'Submitted', due_at: '2026-10-20T20:00:00Z', submission: { submitted_at: '2026-10-18T10:00:00Z' } },
    { id: 5, name: 'Far away', due_at: '2027-01-01T20:00:00Z' }
  ] }], now, 14);
  assert.deepEqual(result.map(x => x.status), ['overdue_or_missing', 'upcoming', 'submitted']);
});

test('assignment packet includes instructions and adjacent module page', async () => {
  const api = client({
    '/api/v1/courses/1/assignments/2': { body: { id: 2, course_id: 1, name: 'Lab', description: '<p>Finish lab</p>', rubric: [{ points: 10 }] } },
    '/api/v1/courses/1/modules': { body: [{ id: 5, name: 'Week 5' }] },
    '/api/v1/courses/1/modules/5/items': { body: [{ type: 'Assignment', content_id: 2, title: 'Lab' }, { type: 'Page', page_url: 'lecture-1', title: 'Lecture 1' }] },
    '/api/v1/courses/1/pages/lecture-1': { body: { title: 'Lecture 1', body: '<h2>Topic</h2><p>Details</p>' } }
  });
  const packet = await assignmentPacket(api, 1, 2);
  assert.equal(packet.assignment.instructions, 'Finish lab');
  assert.equal(packet.module, 'Week 5');
  assert.match(packet.related_materials[0].text, /Details/);
});
