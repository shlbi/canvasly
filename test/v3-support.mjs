import { randomUUID } from 'node:crypto';
import { AppError } from '../lib/security.mjs';
import { newWorkspace } from '../lib/app/store.mjs';

export const user = { id: 'a781a312-3e91-44ef-931d-a65e815d7245', email: 'student@example.com', email_confirmed_at: new Date().toISOString(), user_metadata: { full_name: 'Test Student' } };

/** In-memory owner-scoped fixture with serialized mutations; it never calls Supabase or a model. */
export class MemoryStore {
  /** Create an empty workspace and injectable entitlement state. */
  constructor() { this.row = { user_id: user.id, version: 1, data: newWorkspace(user) }; this.active = true; this.calls = []; this.tail = Promise.resolve(); this.records = new Map(); }
  /** Return isolated copies to make mutation races visible in tests. */
  async read(id) { return id === this.row.user_id ? structuredClone(this.row) : null; }
  /** Verify the fixture account without replacing its saved state. */
  async register(identity) { if (identity.id !== user.id) throw new AppError('Unknown fixture user.', 404); return this.read(identity.id); }
  /** Serialize a pure mutation and increment the version just like a successful compare-and-swap. */
  async mutate(id, change) {
    const previous = this.tail; let release;
    this.tail = new Promise(/* Hold the next mutation until this fixture transaction finishes. */ resolve => { release = resolve; });
    await previous;
    try { const row = await this.read(id); if (!row) throw new AppError('Not found.', 404); if (await change(row.data) !== false) { row.version++; this.row = row; } return this.read(id); }
    finally { release(); }
  }
  /** Return the fixture subscription; checkout redirects never affect it. */
  async billing() { return { active: this.active, status: this.active ? 'active' : 'none', price_cents: 2000, model_calls: 0 }; }
  /** Reject compute when the subscription is not active. */
  async requirePaid() { if (!this.active) throw new AppError('Subscription required.', 402); return this.billing(); }
  /** Capture reservations without making paid model requests. */
  async reserveModel(id, job) { await this.requirePaid(); const call = randomUUID(); this.calls.push({ id, job, call }); return call; }
  /** Save mock usage for assertions. */
  async finishModel(id, usage) { this.calls.push({ id, usage }); }
  /** Record abuse-control calls; customer usage caps are tested separately. */
  async rate(...args) { this.calls.push({ rate: args }); }
  /** Provide narrow fixture responses for the API, not a replacement SQL implementation. */
  async db(path, method = 'GET', data) { this.calls.push({ path, method, data }); if (path.startsWith('canvasly_workers?')) return [{ heartbeat_at: new Date().toISOString() }]; if (path.startsWith('canvasly_oauth_grants?')) return []; throw new Error(`Unexpected fixture database call: ${path}`); }
  /** Require each test to define the SQL boundary it is actually exercising. */
  async rpc(name, args) { this.calls.push({ rpc: name, args }); throw new Error(`Unexpected fixture RPC: ${name}`); }
}

/** Build a minimal Node response fixture that preserves individual cookie headers. */
export function response() {
  return { statusCode: 200, headers: {}, text: '',
    setHeader: /* HTTP header names are case-insensitive. */ function (name, value) { this.headers[name.toLowerCase()] = value; },
    getHeader: /* Read stored response headers for cookie appending. */ function (name) { return this.headers[name.toLowerCase()]; },
    writeHead: /* Capture redirects and status codes. */ function (status, headers) { this.statusCode = status; for (const [name, value] of Object.entries(headers || {})) this.setHeader(name, value); },
    end: /* Store the exact response text; tests parse it explicitly. */ function (text = '') { this.text = text; }
  };
}

/** Connect the synthetic account to a synthetic Canvas identity without a usable credential. */
export function connect(store) { store.row.data.connection = { binding: 'test-binding', origin: 'https://school.example.com', name: 'Test Canvas account', browser_state: 'encrypted-fixture' }; }
