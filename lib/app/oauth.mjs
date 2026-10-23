import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { AppError, bounded } from '../security.mjs';
import { appOrigin, tokenHash, json, readInput } from './config.mjs';

export const MCP_SCOPES = ['canvasly.read', 'canvasly.write'];

/** Identify this MCP resource independently of Supabase's website session tokens. */
export function mcpResource() { return `${appOrigin()}/mcp`; }

/** Publish discovery for the narrow MCP authorization adapter; Supabase remains the user identity provider. */
export function oauthMetadata() {
  const base = appOrigin();
  return { issuer: base, authorization_endpoint: `${base}/oauth/authorize`, token_endpoint: `${base}/oauth/token`, registration_endpoint: `${base}/oauth/register`, revocation_endpoint: `${base}/oauth/revoke`, response_types_supported: ['code'], grant_types_supported: ['authorization_code','refresh_token'], code_challenge_methods_supported: ['S256'], token_endpoint_auth_methods_supported: ['none'], scopes_supported: MCP_SCOPES };
}

/** Tell MCP hosts where to obtain tokens, with the exact audience checked by the server. */
export function resourceMetadata() {
  return { resource: mcpResource(), authorization_servers: [appOrigin()], scopes_supported: MCP_SCOPES, bearer_methods_supported: ['header'], resource_name: 'Canvasly', resource_documentation: `${appOrigin()}/#mcp` };
}

/** Validate redirect destinations without fetching them or allowing credential-bearing URLs. */
export function redirectUri(value) {
  const url = new URL(bounded(value, 1800));
  const local = ['127.0.0.1','[::1]'].includes(url.hostname);
  if ((url.protocol !== 'https:' && !(local && url.protocol === 'http:')) || url.username || url.password || url.hash || url.href.includes('*')) throw new AppError('OAuth redirect URIs must use HTTPS (or literal loopback HTTP).');
  return url.href;
}

/** Parse only known scopes; a client cannot silently receive a broader capability set. */
export function scopes(value) {
  const requested = [...new Set(bounded(value || 'canvasly.read canvasly.write', 100).split(' ').filter(Boolean))];
  if (!requested.length || requested.some(/* Reject unknown scope names rather than ignoring them. */ scope => !MCP_SCOPES.includes(scope))) throw new AppError('Unsupported OAuth scope.');
  return requested;
}

/** Register public PKCE clients dynamically so ChatGPT can connect without a hand-issued client secret. */
export async function registerClient(store, input) {
  if (!Array.isArray(input.redirect_uris) || input.redirect_uris.length < 1 || input.redirect_uris.length > 5 || (input.token_endpoint_auth_method && input.token_endpoint_auth_method !== 'none')) throw new AppError('Only public PKCE clients with 1–5 redirect URIs are supported.');
  const uris = input.redirect_uris.map(/* Normalize each exact callback; wildcards are never accepted. */ uri => redirectUri(uri));
  const clientId = `canvasly_${randomBytes(24).toString('hex')}`;
  const name = bounded(input.client_name || 'MCP client', 100);
  await store.db('canvasly_oauth_clients', 'POST', { client_id: clientId, name, redirect_uris: uris }, 'return=minimal');
  return { client_id: clientId, client_id_issued_at: Math.floor(Date.now() / 1000), client_name: name, redirect_uris: uris, token_endpoint_auth_method: 'none', grant_types: ['authorization_code','refresh_token'], response_types: ['code'] };
}

/** Store a short-lived authorization request after verifying its resource, callback and PKCE challenge. */
export async function authorize(store, query) {
  const clientId = bounded(query.get('client_id') || '', 100);
  const client = (await store.db(`canvasly_oauth_clients?client_id=eq.${encodeURIComponent(clientId)}&limit=1`))[0];
  const callback = redirectUri(query.get('redirect_uri') || '');
  if (!client || !client.redirect_uris.includes(callback)) throw new AppError('Unregistered OAuth callback.');
  if (query.get('resource') !== mcpResource() || query.get('response_type') !== 'code' || query.get('code_challenge_method') !== 'S256' || !/^[A-Za-z0-9_-]{43}$/.test(query.get('code_challenge') || '')) throw new AppError('OAuth requires the Canvasly resource and an S256 PKCE challenge.');
  const requestId = randomUUID();
  await store.db('canvasly_oauth_requests', 'POST', { id: requestId, client_id: clientId, redirect_uri: callback, resource: mcpResource(), challenge: query.get('code_challenge'), scopes: scopes(query.get('scope')), state: bounded(query.get('state') || '', 1500) }, 'return=minimal');
  return `${appOrigin()}/oauth/consent?authorization_id=${requestId}`;
}

/** Load consent text from the server's stored request, not user-controlled redirect parameters. */
export async function consentDetails(store, requestId) {
  if (!/^[a-f0-9-]{36}$/.test(requestId || '')) throw new AppError('Invalid authorization request.');
  const request = (await store.db(`canvasly_oauth_requests?id=eq.${requestId}&limit=1`))[0];
  if (!request || request.status !== 'pending' || Date.parse(request.expires_at) <= Date.now()) throw new AppError('This authorization request expired. Connect again.', 410);
  const client = (await store.db(`canvasly_oauth_clients?client_id=eq.${encodeURIComponent(request.client_id)}&limit=1`))[0];
  return { request_id: request.id, name: client?.name || 'MCP client', redirect_uri: request.redirect_uri, scopes: request.scopes };
}

/** Approve one request with the signed-in user's identity; issue a single-use code, never an API key. */
export async function consent(store, userId, requestId, approve) {
  await consentDetails(store, requestId);
  let result, code;
  if (approve) {
    code = randomBytes(32).toString('base64url');
    result = await store.rpc('canvasly_oauth_approve', { p_request: requestId, p_user: userId, p_code_hash: tokenHash(code) });
  } else {
    const rows = await store.db(`canvasly_oauth_requests?id=eq.${requestId}&status=eq.pending`, 'PATCH', { status: 'denied' });
    result = rows[0];
  }
  if (!result) throw new AppError('Authorization request was already handled.', 409);
  const target = new URL(result.redirect_uri);
  target.searchParams.set(approve ? 'code' : 'error', approve ? code : 'access_denied');
  if (result.state) target.searchParams.set('state', result.state);
  return { url: target.href };
}

/** Exchange a single-use PKCE code or rotate a refresh token within a database transaction. */
export async function exchange(store, input) {
  const client = bounded(input.client_id || '', 100), resource = bounded(input.resource || '', 2000);
  if (resource !== mcpResource() || input.client_secret) throw new AppError('Invalid OAuth client or resource.');
  const access = randomBytes(32).toString('base64url'), refresh = randomBytes(48).toString('base64url');
  let result;
  if (input.grant_type === 'authorization_code') {
    const verifier = bounded(input.code_verifier || '', 128);
    if (!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier)) throw new AppError('Invalid PKCE verifier.');
    result = await store.rpc('canvasly_oauth_exchange', { p_code: tokenHash(bounded(input.code || '', 200)), p_client: client, p_resource: resource, p_redirect: redirectUri(input.redirect_uri || ''), p_challenge: createHash('sha256').update(verifier).digest('base64url'), p_access: tokenHash(access), p_refresh: tokenHash(refresh) });
  } else if (input.grant_type === 'refresh_token') {
    result = await store.rpc('canvasly_oauth_refresh', { p_token: tokenHash(bounded(input.refresh_token || '', 200)), p_client: client, p_resource: resource, p_access: tokenHash(access), p_refresh: tokenHash(refresh) });
  } else throw new AppError('Unsupported OAuth grant type.');
  if (!result) throw new AppError('Invalid, expired, replayed or revoked OAuth grant.', 400);
  return { access_token: access, token_type: 'Bearer', expires_in: 3600, refresh_token: refresh, scope: result.scope };
}

/** Resolve a scoped MCP token from its hash and fail closed for expired/revoked/wrong-resource tokens. */
export async function mcpIdentity(store, req) {
  const match = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(String(req.headers.authorization || ''));
  if (!match) throw new AppError('Connect your Canvasly account.', 401);
  const identity = await store.rpc('canvasly_mcp_identity', { p_token: tokenHash(match[1]), p_resource: mcpResource() });
  if (!identity) throw new AppError('Reconnect your Canvasly account.', 401);
  return identity;
}

/** Serve public OAuth protocol endpoints; consent decisions require the authenticated app API instead. */
export async function oauthRoute(store, req, res, url) {
  const route = url.pathname;
  if (route === '/.well-known/oauth-authorization-server' && req.method === 'GET') return json(res, oauthMetadata());
  if (route.startsWith('/.well-known/oauth-protected-resource') && req.method === 'GET') return json(res, resourceMetadata());
  try {
    if (route === '/oauth/authorize' && req.method === 'GET') { const location = await authorize(store, url.searchParams); res.writeHead(303, { Location: location, 'Cache-Control': 'no-store' }); return res.end(); }
    if (req.method !== 'POST') throw new AppError('Method not allowed.', 405);
    const input = await readInput(req, 12000);
    if (route === '/oauth/register') return json(res, await registerClient(store, input), 201);
    if (route === '/oauth/token') return json(res, await exchange(store, input));
    if (route === '/oauth/revoke') { await store.rpc('canvasly_oauth_revoke', { p_token: tokenHash(bounded(input.token || '', 200)), p_client: bounded(input.client_id || '', 100) }); return json(res, {}); }
    throw new AppError('Not found.', 404);
  } catch (error) { return json(res, { error: route === '/oauth/token' ? 'invalid_grant' : 'invalid_request', error_description: error instanceof AppError ? error.message : 'OAuth request failed.' }, error.status || 400); }
}
