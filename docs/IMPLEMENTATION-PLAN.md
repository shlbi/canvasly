# Canvasly paid cloud release — implementation plan

## Goal and scope
One public student account, one $20/month subscription, and the same saved tasks through the website and authenticated remote MCP. The browser tab and student's laptop are not workers. Use existing Chromium through Playwright; do not fork a browser or depend on Browserbase.

## Architecture
- **Vercel:** static responsive frontend, authenticated API, Stripe webhook, and stateless HTTP MCP.
- **Supabase:** email/Google identity, private application records, subscription entitlements, usage ledger, scoped MCP grants, and a transactionally leased work queue.
- **Self-hosted worker:** one Docker service on an always-on Linux host. Runs Chromium on demand and processes persistent job steps. No Browserbase account, no public Chrome debug port, no second queue vendor.
- **OpenAI:** server-funded Responses calls. A task never inherits a ChatGPT subscription or depends on ChatGPT remaining open.
- **Stripe:** one recurring price, Checkout, Customer Portal, signature-verified lifecycle webhooks. No client-side entitlement decisions.

## Work packages
1. Replace ChatGPT identity with Supabase email/password and Google PKCE; public signup, recovery, secure cookies, no email allowlist.
2. Implement Stripe Checkout/Portal, idempotent webhook handling, server-side entitlements and usage records. Keep future plan allowances in the database rather than arbitrary daily environment flags.
3. Expose remote MCP with scoped OAuth authorization code + S256 PKCE, explicit consent, short-lived access tokens and rotating refresh grants, backed by the same Supabase user. Never forward provider credentials to MCP.
4. Keep official Canvas OAuth where an application registration is available. Remove the college allowlist; validate public HTTPS destinations, DNS answers and redirects instead. A browser login is not an OAuth API grant.
5. Add self-hosted Playwright sessions: authenticated live login/control, encrypted saved session state, per-user isolation, expiration, disconnect, screenshots only for the logged-in owner, no recording of credentials.
6. Use a Postgres leased queue for chat, sync and assignment jobs. Persist each step; fence concurrency; pause ambiguous side effects instead of submitting twice. Save progress for phone/MCP access.
7. Support regular API-backed Canvas text/file/URL submissions, browser-assisted Canvas data, and an explicit experimental external-tool browser task. Never claim a universal assignment completion percentage.
8. Update landing/onboarding, billing, MCP consent and connection screens. Preserve schedule/learning-pace functionality. Comment every new function and changed function.
9. Run unit/integration/security tests with mocks, local browser checks, and syntax checks. Record live-service checks not possible without credentials. Push one coherent commit to main after checking the remote head.

## Non-negotiable verification
No fake successful login/payment/submission; no shared student context; no arbitrary network proxy; no school passwords in prompts, database, traces or logs; no committed secrets; no live charge/deployment/infrastructure provisioning from this build session. The requested push may trigger the user's existing Vercel integration.

## Deployment boundary
A Vercel Git push deploys the **website/API only**. Self-hosting persistent browsers requires a separate always-on worker host and the supplied Docker setup. Creating the database schema and configuring Google, Stripe and Canvas OAuth are administrator setup steps, not features that environment placeholders magically enable.

## Honest launch gate
Real Supabase login, Stripe sandbox checkout/renewal/cancel, school login/MFA, laptop-off job completion, submission receipt, phone resume, MCP OAuth, DNS/tenant isolation and worker restart must be verified with configured services before accepting public payments. Local tests are not a production security audit.

## Implementation status

Work packages 1–8 are present in this release. Work package 9 has local syntax, 107 native tests, function-comment inspection and desktop/mobile source-rendering checks; see `VALIDATION.md` for boundaries. Provider commissioning and the real live acceptance checklist remain deployment tasks. External-tool operation is a constrained generic implementation, not a certified adapter for every vendor. The worker starts with one instance and retains live browser state; multi-host browser affinity is deliberately not claimed.
