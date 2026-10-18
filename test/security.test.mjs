import test from 'node:test';
import assert from 'node:assert/strict';
import { seal, unseal, canvasOrigin, storageUrl, validateDeliverable, escapeHtml, id, permittedEmail } from '../lib/security.mjs';
process.env.APP_ENCRYPTION_KEY = 'ab'.repeat(32);
process.env.CANVAS_ALLOWED_HOSTS = 'school.instructure.com';
test('AES-GCM credentials decrypt only for the intended user and purpose', () => {
  const token = seal({ token: 'not-a-real-secret' }, 'canvas:user-one');
  assert.deepEqual(unseal(token, 'canvas:user-one'), { token: 'not-a-real-secret' });
  assert.throws(() => unseal(token, 'canvas:user-two'));
  assert.throws(() => unseal(token, 'session'));
  const parts = token.split('.'); parts[2] = Buffer.from('tampered ciphertext').toString('base64url');
  assert.throws(() => unseal(parts.join('.'), 'canvas:user-one'));
});
test('Canvas origins require exact administrator-approved HTTPS hosts', () => {
  assert.equal(canvasOrigin('https://school.instructure.com/'), 'https://school.instructure.com');
  for (const value of ['http://school.instructure.com', 'https://school.instructure.com.evil.test', 'https://evil.test', 'https://127.0.0.1', 'https://school.instructure.com/courses', 'https://x@y@school.instructure.com', 'https://school.instructure.com?token=x', 'https://school.instructure.com:8443']) assert.throws(() => canvasOrigin(value));
});
test('file-storage hosts are independently constrained', () => {
  assert.equal(storageUrl('https://bucket.s3.amazonaws.com/file', 'https://school.instructure.com').hostname, 'bucket.s3.amazonaws.com');
  for (const value of ['http://bucket.s3.amazonaws.com', 'https://169.254.169.254/latest/meta-data', 'https://localhost', 'https://evil.test', 'https://bucket.s3.amazonaws.com.evil.test', 'https://u:p@bucket.s3.amazonaws.com/file']) assert.throws(() => storageUrl(value, 'https://school.instructure.com'));
});
test('deliverables reject empty text, duplicate filenames, traversal, binaries, and wrong formats', () => {
  const accepted = ['online_text_entry', 'online_upload', 'online_url'];
  assert.throws(() => validateDeliverable({ type: 'online_text_entry', body: ' ' }, accepted));
  assert.throws(() => validateDeliverable({ type: 'online_text_entry', body: 'hello' }, ['online_upload']));
  for (const name of ['../answer.py', 'answer.pdf', '.env', 'a/answer.py', 'script.exe']) assert.throws(() => validateDeliverable({ type: 'online_upload', files: [{ name, content: 'test' }] }, accepted));
  assert.throws(() => validateDeliverable({ type: 'online_upload', files: [{ name: 'a.py', content: 'a' }, { name: 'A.py', content: 'b' }] }, accepted));
  assert.equal(validateDeliverable({ type: 'online_upload', files: [{ name: 'answer.py', content: 'print(1)' }] }, accepted).files.length, 1);
  assert.throws(() => validateDeliverable({ type: 'online_url', url: 'javascript:alert(1)' }, accepted));
});
test('HTML is escaped and positive IDs are checked', () => {
  assert.equal(escapeHtml('<script>"hi"</script>'), '&lt;script&gt;&quot;hi&quot;&lt;/script&gt;');
  assert.equal(id('42'), 42);
  for (const value of [-1, 0, 'abc', 1.2, Number.MAX_SAFE_INTEGER + 1]) assert.throws(() => id(value));
});
test('private beta email allowlist blocks other identities', () => {
  process.env.ALLOWED_EMAILS = 'student@example.test';
  assert.doesNotThrow(() => permittedEmail('STUDENT@example.test'));
  assert.throws(() => permittedEmail('other@example.test'));
  delete process.env.ALLOWED_EMAILS;
});
