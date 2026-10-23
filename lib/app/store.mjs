import { randomUUID } from 'node:crypto';
import { AppError, requireValue, digest } from '../security.mjs';
import { defaultProfile } from '../../public/domain.mjs';
import { serviceOrigin } from './config.mjs';

/** Construct an empty real workspace without copying any demo/student records. */
export function newWorkspace(user) {
  return { identity: { id: user.id, email: user.email, name: user.user_metadata?.full_name || '' }, profile: defaultProfile(), profile_revision: 0, snapshot: { courses: [], assignments: [], warnings: [] }, connection: null, messages: [], jobs: [], drafts: [], proposals: [], plan: null, created_at: new Date().toISOString() };
}

/** Service-side data access. Every user query is keyed by a verified Supabase user ID. */
export class AppStore {
  /** Inject fetch so tests do not contact real providers. */
  constructor(fetchImpl = fetch) { this.fetch = fetchImpl; }

  /** Call PostgREST with a server credential, bounded timeout and no redirects. */
  async db(path, method = 'GET', data, prefer = 'return=representation') {
    const key = requireValue('SUPABASE_SECRET_KEY');
    const response = await this.fetch(`${serviceOrigin('SUPABASE_URL')}/rest/v1/${path}`, {
      method, headers: { apikey: key, ...(key.startsWith('sb_secret_') ? {} : { Authorization: `Bearer ${key}` }), 'Content-Type': 'application/json', Prefer: prefer },
      ...(data === undefined ? {} : { body: JSON.stringify(data) }), signal: AbortSignal.timeout(15000), redirect: 'error'
    });
    if (!response.ok) throw new AppError('Database unavailable. Check server credentials and run supabase/v3.sql.', 503);
    return response.status === 204 ? null : response.json();
  }

  /** Call a service-only SQL transaction, including work leases and metering. */
  async rpc(name, data = {}) { return this.db(`rpc/${name}`, 'POST', data); }

  /** Read the exact account; callers never supply an arbitrary SQL filter. */
  async read(userId) { return (await this.db(`canvasly_workspaces?user_id=eq.${encodeURIComponent(userId)}&limit=1`))[0] || null; }

  /** Create an account once, without overwriting concurrent saved work. */
  async register(user) {
    await this.db('canvasly_workspaces?on_conflict=user_id', 'POST', { user_id: user.id, data: newWorkspace(user), version: 1 }, 'resolution=ignore-duplicates,return=minimal');
    return this.read(user.id);
  }

  /** Optimistically update a workspace; mutations must be side-effect-free for safe retries. */
  async mutate(userId, change) {
    for (let attempt = 0; attempt < 8; attempt++) {
      const row = await this.read(userId);
      if (!row) throw new AppError('Workspace not found.', 404);
      const data = structuredClone(row.data);
      if ((await change(data)) === false) return row;
      // Bound storage/response sizes without introducing a customer-facing daily AI limit.
      if (Buffer.byteLength(JSON.stringify(data)) > 16000000) throw new AppError('Workspace storage is full. Export and remove old work.', 413);
      const updated = await this.db(`canvasly_workspaces?user_id=eq.${encodeURIComponent(userId)}&version=eq.${row.version}`, 'PATCH', { data, version: row.version + 1, updated_at: new Date().toISOString() });
      if (updated.length) return updated[0];
    }
    throw new AppError('Another operation changed this workspace. Please retry.', 409);
  }

  /** Fetch only subscription and plan details safe for the account owner to inspect. */
  async billing(userId) { return this.rpc('canvasly_entitlement', { p_user: userId }); }

  /** Require an active, paid entitlement before consuming compute, not merely a checkout redirect. */
  async requirePaid(userId) {
    const result = await this.billing(userId);
    if (!result?.active) throw new AppError('An active Canvasly subscription is required. Open Billing to subscribe.', 402);
    return result;
  }

  /** Reserve one model call atomically, applying only a configured plan allowance. */
  async reserveModel(userId, jobId) {
    const callId = randomUUID();
    const allowed = await this.rpc('canvasly_reserve_model', { p_user: userId, p_call: callId, p_job: jobId });
    if (!allowed) throw new AppError('Subscription inactive or the configured plan allowance is used. Open Billing.', 402);
    return callId;
  }

  /** Record actual token counts; an ambiguous request remains counted as a reserved call. */
  async finishModel(callId, usage = {}) {
    await this.db(`canvasly_usage?call_id=eq.${encodeURIComponent(callId)}`, 'PATCH', { input_tokens: usage.input_tokens || 0, output_tokens: usage.output_tokens || 0, completed: true }, 'return=minimal');
  }

  /** Enforce short-window abuse controls using database time and atomic counters. */
  async rate(bucket, limit, seconds = 60) {
    const allowed = await this.rpc('canvasly_rate', { p_bucket: digest(bucket), p_limit: limit, p_seconds: seconds });
    if (!allowed) throw new AppError('Too many requests. Try again shortly.', 429);
  }
}

/** Remove credentials, model transcripts, leases and binary source packets before returning a workspace. */
export function publicState(row) {
  const d = row.data;
  return { version: row.version, identity: d.identity, profile: d.profile, profile_revision: d.profile_revision || 0, snapshot: d.snapshot, proposals: d.proposals, plan: d.plan,
    messages: d.messages.slice(-100), jobs: d.jobs.map(/* Only status and work identifiers are public. */ ({ input, lease, browser_state, resume_url, packet, browser_history, browser_session_id, ...job }) => job),
    drafts: d.drafts.map(/* Binary sources and connection bindings stay on the server. */ ({ packet, connection_key, ...draft }) => ({ ...draft, content_hash: draft.deliverable ? digest(draft.deliverable) : null, assignment_brief: packet?.assignment, source_names: packet?.sources?.map(/* Display source names only. */ source => source.name) || [], context_warnings: packet?.warnings || [] })),
    connection: d.connection ? { origin: d.connection.origin, name: d.connection.name, kind: d.connection.kind, browser_ready: !!d.connection.browser_state, api_ready: !!d.connection.credentials, needs_login: d.connection.needs_login === true } : null
  };
}
