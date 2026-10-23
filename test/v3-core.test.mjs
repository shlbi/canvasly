import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { publicAddress, publicUrl, publicOrigin, publicDns } from '../lib/app/network.mjs';
import { safeReturn, saveSession, authenticate, googleSignIn, readCookie } from '../lib/app/auth.mjs';
import { rawBody, readInput, equalSecret, tokenHash } from '../lib/app/config.mjs';
import { verifyStripe, checkout, eventSubscription } from '../lib/app/billing.mjs';
import { oauthMetadata, resourceMetadata, redirectUri, scopes, registerClient, authorize, exchange, mcpIdentity } from '../lib/app/oauth.mjs';
import { publicState, AppStore } from '../lib/app/store.mjs';
import { seal, digest } from '../lib/security.mjs';
import { MemoryStore, user, response } from './v3-support.mjs';

process.env.APP_URL = 'https://www.trycanvasly.com';
process.env.APP_ENCRYPTION_KEY = 'a'.repeat(64);
process.env.SUPABASE_URL = 'https://example.supabase.co';
process.env.SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_fixture';
process.env.SUPABASE_SECRET_KEY = 'sb_secret_fixture';
process.env.STRIPE_PRICE_ID = 'price_fixture';

/** Create a signed Stripe fixture without contacting any live account. */
function signed(data, timestamp = Math.floor(Date.now() / 1000), secret = 'fixture-secret') { const raw = Buffer.from(JSON.stringify(data)); return { raw, header: `t=${timestamp},v1=${createHmac('sha256', secret).update(`${timestamp}.`).update(raw).digest('hex')}` }; }

test('v3 public destinations accept schools without a manually maintained college list', /* Validate public HTTPS syntax, not institutional authorization. */ () => {
  assert.equal(publicOrigin('https://canvas.any-university.edu'), 'https://canvas.any-university.edu');
  assert.equal(publicOrigin('https://different.instructure.com'), 'https://different.instructure.com');
  for (const url of ['http://school.edu','https://127.0.0.1','https://[::1]','https://169.254.169.254/latest','https://user:pass@school.edu','https://school.edu:8443','https://localhost','https://internal','https://school.edu./','https://2130706433']) assert.throws(/* Exercise the expected rejection without contacting a live provider. */ () => publicUrl(url));
  assert.throws(/* Exercise the expected rejection without contacting a live provider. */ () => publicOrigin('https://school.edu/courses/1'));
});

test('v3 reserved IPv4 and IPv6 destinations are rejected', /* Include mapped IPv6 and transition ranges that can conceal private IPv4 targets. */ () => {
  for (const address of ['0.0.0.0','10.1.1.1','127.1.1.1','172.16.1.1','192.168.0.1','100.64.0.1','198.18.0.1','224.1.1.1','::ffff:127.0.0.1','fc00::1','fe80::1','2002:7f00:1::','2001:db8::1']) assert.equal(publicAddress(address), false, address);
  assert.equal(publicAddress('8.8.8.8'), true); assert.equal(publicAddress('2606:4700:4700::1111'), true);
});

test('v3 DNS resolution rejects mixed public/private results and pins a single checked address', /* A later DNS change must not replace the checked destination. */ async () => {
  let count = 0;
  const result = await publicDns('school.edu', /* Run this local callback with the explicitly supplied inputs. */ async () => { count++; return [{ address: '8.8.8.8', family: 4 }]; });
  assert.equal(result.address, '8.8.8.8'); assert.equal(count, 1);
  await assert.rejects(publicDns('school.edu', /* Run this local callback with the explicitly supplied inputs. */ async () => [{ address: '8.8.8.8', family: 4 }, { address: '10.0.0.1', family: 4 }]));
});

test('v3 raw webhook bytes are preserved and bounded independently of JSON parsing', /* JSON reserialization must never replace signature-verified bytes. */ async () => {
  const raw = Buffer.from('{ "a" : 1 }');
  assert.deepEqual(await rawBody({ body: raw }), raw);
  const stream = Readable.from([raw]); stream.headers = { 'content-type': 'application/json' };
  assert.deepEqual(await readInput(stream), { a: 1 });
  await assert.rejects(rawBody({ body: { a: 1 } }));
  await assert.rejects(rawBody({ body: raw }, 2));
  assert.deepEqual(await readInput({ body: { a: 1 }, headers: {} }), { a: 1 });
});

test('v3 session cookies encrypt tokens and have host-only security attributes', /* Tokens never enter localStorage, HTML or a readable cookie value. */ () => {
  const res = response(); saveSession(res, { access_token: 'private-access', refresh_token: 'private-refresh', expires_in: 3600 });
  const cookie = res.headers['set-cookie'][0]; assert.match(cookie, /^__Host-canvasly_session=/); assert.match(cookie, /HttpOnly/); assert.match(cookie, /Secure/); assert.match(cookie, /SameSite=Lax/); assert.ok(!cookie.includes('private-access'));
  assert.ok(readCookie({ headers: { cookie } }, 'session'));
});

test('v3 authentication validates Supabase identity rather than trusting unsigned session claims', /* The fixture provider returns the account identity on a verified user endpoint. */ async () => {
  const res = response(); saveSession(res, { access_token: 'access', refresh_token: 'refresh', expires_in: 3600 });
  const calls = [];
  const provider = /* Run this local callback with the explicitly supplied inputs. */ async (url, options) => { calls.push({ url, options }); return Response.json(user); };
  const result = await authenticate({ headers: { cookie: res.headers['set-cookie'][0] } }, response(), provider);
  assert.equal(result.user.id, user.id); assert.match(calls[0].url, /\/auth\/v1\/user$/); assert.equal(calls[0].options.headers.Authorization, 'Bearer access');
  await assert.rejects(authenticate({ headers: { cookie: res.headers['set-cookie'][0] } }, response(), /* Run this local callback with the explicitly supplied inputs. */ async () => Response.json({ ...user, email_confirmed_at: null })));
});

test('v3 Google login uses PKCE and preserves only same-origin return paths', /* A consent callback cannot become an open redirect. */ () => {
  for (const next of ['https://evil.example','//evil.example','/\\evil.example']) assert.equal(safeReturn(next), '/#agent');
  assert.equal(safeReturn('/oauth/consent?authorization_id=test'), '/oauth/consent?authorization_id=test');
  const res = response(), url = new URL(googleSignIn(res, '/#agent').url);
  assert.equal(url.hostname, 'example.supabase.co'); assert.equal(url.searchParams.get('provider'), 'google'); assert.equal(url.searchParams.get('code_challenge_method'), 's256'); assert.equal(url.searchParams.get('code_challenge').length, 43); assert.ok(res.headers['set-cookie'][0].includes('HttpOnly'));
});

test('v3 Stripe signatures reject altered bytes, stale timestamps and wrong secrets', /* This tests actual HMAC verification, not a fake success-page flag. */ () => {
  const event = { id: 'evt_fixture', type: 'invoice.paid', data: { object: { id: 'in_fixture' } } }, fixture = signed(event);
  assert.equal(verifyStripe(fixture.raw, fixture.header, 'fixture-secret').id, event.id);
  assert.throws(/* Exercise the expected rejection without contacting a live provider. */ () => verifyStripe(Buffer.from(fixture.raw.toString() + ' '), fixture.header, 'fixture-secret'));
  assert.throws(/* Exercise the expected rejection without contacting a live provider. */ () => verifyStripe(fixture.raw, fixture.header, 'other-secret'));
  const old = signed(event, Math.floor(Date.now() / 1000) - 600); assert.throws(/* Exercise the expected rejection without contacting a live provider. */ () => verifyStripe(old.raw, old.header, 'fixture-secret'));
});

test('v3 checkout validates the $20 monthly price and keeps idempotent payloads stable', /* Repeated clicks must not change random fields under one idempotency key. */ async () => {
  const store = new MemoryStore(); store.active = false;
  store.db = /* Substitute a bounded provider response for this isolated test. */ async () => [{ stripe_customer_id: 'cus_fixture' }];
  const calls = [], stripe = { call: /* Implement the call operation for this scoped object. */ async (path, data, key) => { calls.push({ path, data, key }); return path.startsWith('prices/') ? { active: true, currency: 'usd', unit_amount: 2000, recurring: { interval: 'month', interval_count: 1 } } : { url: 'https://checkout.stripe.com/fixture' }; } };
  assert.equal((await checkout(store, user, stripe)).url, 'https://checkout.stripe.com/fixture'); await checkout(store, user, stripe);
  const sessions = calls.filter(/* Keep only entries matching this operation’s selection criteria. */ item => item.path === 'checkout/sessions'); assert.equal(sessions[0].key, sessions[1].key); assert.deepEqual(sessions[0].data, sessions[1].data); assert.equal(sessions[0].data.mode, 'subscription'); assert.ok(!('payment_method_types' in sessions[0].data));
  await assert.rejects(checkout(store, user, { call: /* Implement the call operation for this scoped object. */ async () => ({ active: true, currency: 'usd', unit_amount: 20000, recurring: { interval: 'month', interval_count: 1 } }) }), /\$20/);
});

test('v3 invoices resolve subscription ownership through current Stripe object relationships', /* Invoice metadata is not treated as an authoritative user ID. */ () => {
  assert.equal(eventSubscription({ type: 'invoice.paid', data: { object: { parent: { subscription_details: { subscription: 'sub_abc' } }, metadata: { user_id: 'attacker' } } } }), 'sub_abc');
  assert.equal(eventSubscription({ type: 'customer.subscription.deleted', data: { object: { id: 'sub_def' } } }), 'sub_def');
});

test('v3 MCP metadata separates resource tokens from Canvas and Supabase tokens', /* Audience binding is part of the authorization protocol. */ () => {
  assert.equal(resourceMetadata().resource, 'https://www.trycanvasly.com/mcp'); assert.deepEqual(oauthMetadata().code_challenge_methods_supported, ['S256']); assert.equal(oauthMetadata().token_endpoint_auth_methods_supported[0], 'none');
  assert.throws(/* Exercise the expected rejection without contacting a live provider. */ () => redirectUri('https://*.example.com/callback')); assert.throws(/* Exercise the expected rejection without contacting a live provider. */ () => redirectUri('http://public.example/callback')); assert.throws(/* Exercise the expected rejection without contacting a live provider. */ () => scopes('admin'));
  assert.equal(redirectUri('http://127.0.0.1:9999/callback'), 'http://127.0.0.1:9999/callback');
});

test('v3 OAuth dynamic registration stores only explicit callback URIs and no client secret', /* Public clients must use PKCE, not a made-up shared password. */ async () => {
  const store = new MemoryStore(); store.db = /* Substitute a bounded provider response for this isolated test. */ async (path, method, value) => { store.calls.push({ path, method, value }); return []; };
  const result = await registerClient(store, { client_name: 'Test client', redirect_uris: ['https://client.example/callback'] });
  assert.equal(result.token_endpoint_auth_method, 'none'); assert.ok(!result.client_secret); assert.deepEqual(store.calls[0].value.redirect_uris, ['https://client.example/callback']);
});

test('v3 OAuth authorization rejects mismatched resources and unregistered callbacks', /* A valid client cannot turn Canvasly into a credential redirector. */ async () => {
  const store = new MemoryStore(); store.db = /* Substitute a bounded provider response for this isolated test. */ async () => [{ client_id: 'fixture', redirect_uris: ['https://client.example/callback'] }];
  const query = new URLSearchParams({ client_id: 'fixture', redirect_uri: 'https://client.example/callback', resource: 'https://wrong.example/mcp', response_type: 'code', code_challenge_method: 'S256', code_challenge: 'a'.repeat(43) });
  await assert.rejects(authorize(store, query), /resource/); query.set('resource', resourceMetadata().resource); query.set('redirect_uri', 'https://evil.example/callback'); await assert.rejects(authorize(store, query), /Unregistered/);
});

test('v3 OAuth exchange binds code, verifier, resource and redirect while storing token hashes', /* Tests the real adapter boundary; SQL atomic consumption is separately documented for live validation. */ async () => {
  const store = new MemoryStore(); let captured;
  store.rpc = /* Substitute a bounded provider response for this isolated test. */ async (name, args) => { captured = { name, args }; return { scope: 'canvasly.read' }; };
  const verifier = 'v'.repeat(43), result = await exchange(store, { grant_type: 'authorization_code', client_id: 'fixture', code: 'code', code_verifier: verifier, redirect_uri: 'https://client.example/callback', resource: resourceMetadata().resource });
  assert.equal(captured.name, 'canvasly_oauth_exchange'); assert.equal(captured.args.p_challenge, createHash('sha256').update(verifier).digest('base64url')); assert.equal(captured.args.p_access, tokenHash(result.access_token)); assert.notEqual(captured.args.p_access, result.access_token); assert.equal(result.token_type, 'Bearer');
  await assert.rejects(exchange(store, { grant_type: 'refresh_token', resource: 'https://wrong.example', refresh_token: result.refresh_token }));
});

test('v3 expired or revoked MCP credentials fail closed', /* Tokens are validated on every tool request instead of trusting a previous initialize call. */ async () => {
  const store = new MemoryStore(); store.rpc = /* Substitute a bounded provider response for this isolated test. */ async () => null;
  await assert.rejects(mcpIdentity(store, { headers: { authorization: 'Bearer ' + 'x'.repeat(43) } }), /Reconnect/);
  await assert.rejects(mcpIdentity(store, { headers: { authorization: 'Bearer ordinary-supabase-token' } }));
});

test('v3 public workspace excludes provider inputs, browser storage and source bytes', /* Privacy filtering covers both website state and the phone progress view. */ () => {
  const store = new MemoryStore(); store.row.data.connection = { origin: 'https://school.example', name: 'Test', credentials: 'secret', browser_state: 'cookies', binding: 'owner' };
  store.row.data.jobs.push({ id: 'job', input: [{ secret: 'prompt' }], lease: { id: 'lease' }, resume_url: 'sso-secret', browser_history: ['hidden'], packet: { data: 'pdf' }, status: 'queued' });
  store.row.data.drafts.push({ id: 'draft', connection_key: 'binding', packet: { assignment: { name: 'A' }, sources: [{ kind: 'pdf', name: 'source.pdf', data: 'base64-secret' }] }, deliverable: { type: 'online_text_entry', body: 'answer' } });
  const serialized = JSON.stringify(publicState(store.row)); for (const value of ['base64-secret','sso-secret','cookies','"credentials"','"lease"']) assert.ok(!serialized.includes(value)); assert.ok(serialized.includes('source.pdf'));
});

test('v3 optimistic storage rejects stale writes and retries a pure mutation safely', /* Use the real AppStore compare-and-swap loop with a mocked PostgREST transport. */ async () => {
  const store = new AppStore(); let attempts = 0; store.read = /* Substitute a bounded provider response for this isolated test. */ async () => ({ user_id: user.id, version: attempts + 1, data: { count: attempts } });
  store.db = /* Substitute a bounded provider response for this isolated test. */ async (path, method, data) => { attempts++; return attempts === 1 ? [] : [{ version: data.version, data: data.data }]; };
  const row = await store.mutate(user.id, /* Apply a pure account-scoped state change that can be safely retried. */ data => { data.count++; }); assert.equal(attempts, 2); assert.equal(row.data.count, 2);
});

test('v3 global Canvas credentials cannot be sent to arbitrary public websites', /** Public signup does not grant arbitrary hosts access to our global developer secret. */ async () => {
  const { startCanvas } = await import('../lib/app/canvas.mjs');
  process.env.CANVAS_CLIENT_ID = 'global-id'; process.env.CANVAS_CLIENT_SECRET = 'global-secret';
  try {
    assert.throws(/* Exercise the expected rejection without contacting a live provider. */ () => startCanvas(user.id, response(), { origin: 'https://attacker.example.com' }), /No approved/);
    const result = startCanvas(user.id, response(), { origin: 'https://school.instructure.com' });
    assert.equal(new URL(result.url).searchParams.get('client_id'), 'global-id'); assert.ok(!result.url.includes('global-secret'));
  } finally { delete process.env.CANVAS_CLIENT_ID; delete process.env.CANVAS_CLIENT_SECRET; }
});

test('v3 Vercel Web Request adapter preserves unsigned webhook rejection and OAuth discovery', /** Exercise the actual exported fetch handler without enabling real provider connections. */ async () => {
  const entry = (await import('../api/index.js')).default;
  const metadata = await entry.fetch(new Request('https://www.trycanvasly.com/api/index?route=/.well-known/oauth-authorization-server'));
  assert.equal(metadata.status, 200); assert.equal((await metadata.json()).issuer, process.env.APP_URL);
  process.env.STRIPE_WEBHOOK_SECRET = 'signature-fixture-only';
  const bad = await entry.fetch(new Request('https://www.trycanvasly.com/api/index?route=/api/stripe', { method: 'POST', body: '{ "not": "signed" }' }));
  assert.equal(bad.status, 400); assert.match((await bad.json()).error, /signature/);
});
