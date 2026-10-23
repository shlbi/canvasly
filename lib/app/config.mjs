import { createHash, timingSafeEqual } from 'node:crypto';
import { AppError, requireValue } from '../security.mjs';

/** Return the canonical app origin; never trust request Host headers for redirects. */
export function appOrigin() {
  const url = new URL(process.env.APP_URL || 'http://127.0.0.1:3000');
  if (url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new AppError('APP_URL must be an origin.', 503);
  if (process.env.VERCEL && url.protocol !== 'https:') throw new AppError('Hosted APP_URL must use HTTPS.', 503);
  return url.origin;
}

/** Compare secrets without leaking their length or a matching prefix through timing. */
export function equalSecret(a, b) {
  const left = createHash('sha256').update(String(a || '')).digest();
  const right = createHash('sha256').update(String(b || '')).digest();
  return timingSafeEqual(left, right);
}

/** Hash opaque credentials before putting them in the database. */
export function tokenHash(value) { return createHash('sha256').update(value).digest('hex'); }

/** Read a bounded request body without losing Stripe's signature-critical original bytes. */
export async function rawBody(req, maximum = 1800000) {
  if (Buffer.isBuffer(req.body)) { if (req.body.length > maximum) throw new AppError('Request too large.', 413); return req.body; }
  if (typeof req.body === 'string') { if (Buffer.byteLength(req.body) > maximum) throw new AppError('Request too large.', 413); return Buffer.from(req.body); }
  if (req.body && typeof req.body === 'object') throw new AppError('Raw request bytes are required for this endpoint.', 400);
  const parts = []; let length = 0;
  for await (const chunk of req) { length += Buffer.byteLength(chunk); if (length > maximum) throw new AppError('Request too large.', 413); parts.push(Buffer.from(chunk)); }
  return Buffer.concat(parts);
}

/** Decode JSON or OAuth form data, enforcing a single object rather than arrays/primitives. */
export async function readInput(req, maximum) {
  if (req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body)) {
    if (Array.isArray(req.body) || Buffer.byteLength(JSON.stringify(req.body)) > (maximum || 1800000)) throw new AppError('Invalid or oversized request body.', 413);
    return req.body;
  }
  const raw = await rawBody(req, maximum);
  let value;
  try { value = String(req.headers['content-type'] || '').startsWith('application/x-www-form-urlencoded') ? Object.fromEntries(new URLSearchParams(raw.toString())) : JSON.parse(raw.toString() || '{}'); }
  catch { throw new AppError('Invalid request body.'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new AppError('Expected an object.');
  return value;
}

/** Return JSON with private no-cache defaults so credentials and student data are never cached. */
export function json(res, value, status = 200) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'private, no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.end(JSON.stringify(value));
}

/** Reject cross-site browser writes, including clients relying only on a session cookie. */
export function requireOrigin(req) { if (req.headers.origin !== appOrigin()) throw new AppError('Open Canvasly on its configured website before making changes.', 403); }

/** Validate a configured HTTPS service origin; developer loopback is allowed outside Vercel. */
export function serviceOrigin(name) {
  const url = new URL(requireValue(name));
  const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  if (url.username || url.password || url.pathname !== '/' || url.hash || url.search || (url.protocol !== 'https:' && !(loopback && !process.env.VERCEL && url.protocol === 'http:'))) throw new AppError(`${name} must be an HTTPS origin.`, 503);
  return url.origin;
}
