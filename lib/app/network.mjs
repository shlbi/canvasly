import { lookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';
import { request } from 'node:https';
import { AppError } from '../security.mjs';

const denied4 = new BlockList();
for (const [address, prefix] of [['0.0.0.0',8],['10.0.0.0',8],['100.64.0.0',10],['127.0.0.0',8],['169.254.0.0',16],['172.16.0.0',12],['192.0.0.0',24],['192.0.2.0',24],['192.88.99.0',24],['192.168.0.0',16],['198.18.0.0',15],['198.51.100.0',24],['203.0.113.0',24],['224.0.0.0',4],['240.0.0.0',4]]) denied4.addSubnet(address,prefix,'ipv4');
const allowed6 = new BlockList(); allowed6.addSubnet('2000::',3,'ipv6');
const denied6 = new BlockList();
for (const [address,prefix] of [['2001::',32],['2001:2::',48],['2001:10::',28],['2001:20::',28],['2001:db8::',32],['2002::',16]]) denied6.addSubnet(address,prefix,'ipv6');

/** Admit globally routable addresses only, including blocking IPv4-mapped/private IPv6 forms. */
export function publicAddress(value) {
  const version = isIP(value);
  if (version === 4) return !denied4.check(value, 'ipv4');
  return version === 6 && allowed6.check(value, 'ipv6') && !denied6.check(value, 'ipv6');
}

/** Validate a user-supplied destination without a list of colleges. Only public HTTPS web URLs qualify. */
export function publicUrl(value) {
  let url; try { url = new URL(value); } catch { throw new AppError('Enter a full HTTPS website address.'); }
  if (url.protocol !== 'https:' || url.port || url.username || url.password || url.hostname.endsWith('.') || /(?:^|\.)(localhost|local|internal|test|invalid)$/.test(url.hostname)) throw new AppError('Use a public HTTPS website with no special port or credentials.');
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  if (isIP(hostname) && !publicAddress(hostname)) throw new AppError('Private and reserved network addresses are not allowed.', 403);
  url.hash = '';
  return url;
}

/** Canvas connection configuration stores an origin, not an arbitrary API path. */
export function publicOrigin(value) {
  const url = publicUrl(value);
  if (url.pathname !== '/' || url.search) throw new AppError('Enter the Canvas website origin, without a course path.');
  return url.origin;
}

/** Resolve and validate every DNS answer; callers pin the selected address to prevent DNS rebinding. */
export async function publicDns(hostname, resolve = lookup) {
  const host = hostname.replace(/^\[|\]$/g, '');
  const answers = isIP(host) ? [{ address: host, family: isIP(host) }] : await resolve(host, { all: true, verbatim: true });
  if (!answers.length || answers.some(/* Mixed public/private DNS answers are unsafe. */ answer => !publicAddress(answer.address))) throw new AppError('This website resolves to a non-public network address.', 403);
  return answers[0];
}

/** Fetch Canvas over TLS to a pinned, public address while retaining the real hostname for certificate verification. */
export async function publicFetch(value, options = {}) {
  const url = publicUrl(value), address = await publicDns(url.hostname);
  const serialized = new Request(url, options);
  const bytes = ['GET', 'HEAD'].includes(serialized.method) ? undefined : Buffer.from(await serialized.arrayBuffer());
  if (bytes?.length > 2000000) throw new AppError('Upload exceeds the request limit.', 413);
  return new Promise(/* Bridge Node's pinned-address TLS request to the Fetch response interface. */ (resolve, reject) => {
    const req = request(url, { method: serialized.method, headers: Object.fromEntries(serialized.headers), signal: options.signal || AbortSignal.timeout(20000),
      lookup: /* Return only the previously checked address; do not resolve a second time. */ (_host, opts, done) => opts.all ? done(null, [address]) : done(null, address.address, address.family)
    }, /* Bound response memory before returning any body to the caller. */ response => {
      const chunks = []; let size = 0;
      response.on('data', /* Stop large upstream replies without buffering them indefinitely. */ chunk => { size += chunk.length; if (size > 5000000) { req.destroy(new Error('Response too large')); return; } chunks.push(chunk); });
      response.on('error', reject);
      response.on('end', /* Preserve manual redirect responses but never follow one with credentials. */ () => {
        const status = response.statusCode || 502;
        if (status >= 300 && status < 400 && options.redirect !== 'manual') return reject(new AppError('Unexpected redirect from Canvas. Reconnect your account.', 502));
        const headers = new Headers();
        for (const [name, val] of Object.entries(response.headers)) if (val !== undefined) headers.set(name, Array.isArray(val) ? val.join(', ') : val);
        resolve(new Response([204,205,304].includes(status) ? null : Buffer.concat(chunks), { status, headers }));
      });
    });
    req.on('error', reject);
    req.end(bytes);
  });
}
