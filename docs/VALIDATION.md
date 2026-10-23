# Validation — Canvasly 0.5.0

## Performed locally

- `npm ci`: successful; root package has no external runtime dependencies.
- `npm run build`: JavaScript syntax and Vercel JSON configuration passed.
- `npm run check`: **107 tests passed**, zero failures/skips. Includes 75 historical regression tests and 32 new tests.
- New tests exercise public destination/DNS boundaries, encrypted cookies, Supabase identity verification, Stripe raw signatures/price validation, MCP PKCE/resource/redirect rules, revoked credentials, scope/subscription checks, shared website/MCP task IDs, optimistic data updates, queued laptop-independent work, draft/review/submission authorization, changed instructions, uncertain writes, duplicate tasks, external browser checkpoint/session-loss handling, and the actual Web Request adapter.
- AST-based function-comment inspection covered **601 functions across 28 new/changed JavaScript modules** (including test callbacks), with zero missing leading comments on the second pass. Historical code moved unchanged for regression coverage is not a newly documented API.
- Chromium **source-rendering harness** exercised the actual new frontend source at 1440px and 390px widths: landing, agent, work, week, profile, connections, billing, MCP, course-settings dialog, and preservation of unsent chat text. **No JavaScript errors or horizontal overflow** observed.

## Important qualifications

Provider calls in automated integration tests are fixtures, not successful live Supabase/Stripe/OpenAI/Canvas requests. The database SQL was reviewed but **not executed against a live PostgreSQL/Supabase instance** here. SQL locking, triggers, grants and RLS must be verified after the migration.

Chromium navigation to the local web server was blocked by this execution environment's policy. The visual checks used locally loaded source and fixture responses, not a live browser-to-provider session. The screenshot harness used the environment's test Chromium; it is not proof of the production sandbox.

The Playwright worker package/image was **not installed or built** here. The pinned upstream seccomp profile reference and Git blob checksum were retrieved from Microsoft's repository; the deployment preparation script verifies them when downloaded on the worker host. No production host, TLS certificate, firewall or queue consumer was provisioned.

No real school SSO/MFA, external homework platform, live Canvas submission, Stripe payment, hosted OpenAI generation, production email/Google callback, real ChatGPT MCP OAuth, Vercel deployment or independent security/load audit was completed. Never infer those results from passing mocked tests.

Follow [LAUNCH-CHECKLIST.md](LAUNCH-CHECKLIST.md) with configured services before charging public customers.
