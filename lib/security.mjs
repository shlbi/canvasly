import { createCipheriv, createDecipheriv, randomBytes, createHash } from 'node:crypto';
export class AppError extends Error { constructor(message, status = 400) { super(message); this.status = status; } }
export function requireValue(name) {
  if (!process.env[name]) throw new AppError(`Server setup incomplete: ${name} is missing.`, 503);
  return process.env[name];
}
function key() {
  const value = requireValue('APP_ENCRYPTION_KEY');
  if (!/^[a-f\d]{64}$/i.test(value)) throw new AppError('APP_ENCRYPTION_KEY must be 64 hexadecimal characters.', 503);
  return Buffer.from(value, 'hex');
}
export function seal(data, purpose) {
  const iv = randomBytes(12), c = createCipheriv('aes-256-gcm', key(), iv);
  c.setAAD(Buffer.from(purpose));
  const encrypted = Buffer.concat([c.update(JSON.stringify(data), 'utf8'), c.final()]);
  return [iv, c.getAuthTag(), encrypted].map(b => b.toString('base64url')).join('.');
}
export function unseal(value, purpose) {
  try {
    const [iv, tag, text, extra] = String(value).split('.');
    if (extra || !iv || !tag || !text) throw new Error();
    const d = createDecipheriv('aes-256-gcm', key(), Buffer.from(iv, 'base64url'));
    d.setAAD(Buffer.from(purpose)); d.setAuthTag(Buffer.from(tag, 'base64url'));
    return JSON.parse(Buffer.concat([d.update(Buffer.from(text, 'base64url')), d.final()]).toString());
  } catch { throw new AppError('Session or encrypted credential is invalid. Sign in or reconnect Canvas.', 401); }
}
export const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export function id(value) {
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < 1) throw new AppError('Invalid Canvas ID.');
  return n;
}
export function uuid(value) {
  if (!/^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/i.test(String(value))) throw new AppError('Invalid draft ID.');
  return value;
}
export function bounded(value, max = 100000) {
  if (typeof value !== 'string' || value.length > max) throw new AppError(`Expected text of at most ${max} characters.`);
  return value;
}
export function hostList(name) { return (process.env[name] || '').split(',').map(v => v.trim().toLowerCase()).filter(Boolean); }
export function canvasOrigin(value) {
  let url; try { url = new URL(value); } catch { throw new AppError('Enter a full Canvas URL, starting with https://.'); }
  if (url.protocol !== 'https:' || url.port || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new AppError('Use your Canvas HTTPS origin only, with no path, port, or query.');
  if (!hostList('CANVAS_ALLOWED_HOSTS').includes(url.hostname)) throw new AppError('This school is not enabled. Add its exact hostname to CANVAS_ALLOWED_HOSTS.', 403);
  return url.origin;
}
export function storageUrl(value, origin) {
  const u = new URL(value);
  const allowed = u.origin === origin || u.hostname.endsWith('.instructure.com') || u.hostname.endsWith('.amazonaws.com') || hostList('CANVAS_FILE_HOSTS').includes(u.hostname);
  if (u.protocol !== 'https:' || u.port || u.username || u.password || !allowed || /^(localhost|127\.|10\.|192\.168\.)/.test(u.hostname)) throw new AppError('Canvas returned an unapproved file-storage host. Use Canvas directly or configure CANVAS_FILE_HOSTS.', 502);
  return u;
}
export function permittedEmail(email) {
  const list = hostList('ALLOWED_EMAILS');
  if (list.length && !list.includes(String(email).toLowerCase())) throw new AppError('This private beta is limited to invited email addresses.', 403);
}
export function escapeHtml(value = '') { return String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
export function plain(value = '', limit = 45000) {
  return String(value).slice(0, 150000).replace(/<(script|style|iframe|svg)\b[^>]*>[\s\S]*?<\/\1>/gi, '').replace(/<br\s*\/?>|<\/(p|div|li|h\d|tr)>/gi, '\n').replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/[ \t]+/g, ' ').trim().slice(0, limit);
}
export function validateDeliverable(raw, accepted) {
  if (!raw || !['online_text_entry', 'online_upload', 'online_url'].includes(raw.type) || !accepted.includes(raw.type)) throw new AppError('This assignment does not accept the selected submission format.');
  if (raw.type === 'online_text_entry') {
    const body = bounded(raw.body);
    if (!body.trim()) throw new AppError('The draft is empty.');
    return { type: raw.type, body, files: [], url: '' };
  }
  if (raw.type === 'online_url') {
    const u = new URL(bounded(raw.url, 2000));
    if (!['https:', 'http:'].includes(u.protocol) || u.username || u.password) throw new AppError('Enter a real HTTP(S) submission URL.');
    return { type: raw.type, body: '', files: [], url: u.href };
  }
  if (!Array.isArray(raw.files) || !raw.files.length || raw.files.length > 6) throw new AppError('A file submission needs 1–6 UTF-8 source files.');
  const names = new Set();
  const files = raw.files.map(f => {
    if (!/^[a-zA-Z\d][a-zA-Z\d_. -]{0,99}$/.test(f.name) || f.name.includes('..') || !/\.(txt|md|py|js|ts|tsx|jsx|html|css|json|csv|java|c|cpp|h|sql|r|ipynb)$/i.test(f.name) || names.has(f.name.toLowerCase())) throw new AppError('Use unique, simple text/code filenames. Binary PDF/Office output is not supported.');
    names.add(f.name.toLowerCase());
    return { name: f.name, content: bounded(f.content) };
  });
  if (files.reduce((n, f) => n + Buffer.byteLength(f.content), 0) > 350000) throw new AppError('Generated files exceed the 350 KB total limit.');
  return { type: raw.type, body: '', files, url: '' };
}
export function fingerprint(a) { return digest([a.name, a.description || a.instructions, a.submission_types, a.rubric, a.allowed_extensions]); }
