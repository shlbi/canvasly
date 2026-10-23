# Canvasly

**An agent for your student life.** Public email/Google accounts, a $20/month subscription, a shared website and remote MCP workspace, course-aware planning, and saved jobs that execute on a self-hosted worker while the student's device is off.

Version **0.5.0** replaces the old ChatGPT-login and invitation-only paths. This is an implementation with automated and fixture validation, **not a claim that live school integrations, billing, or production infrastructure have already been commissioned**. Read the launch checklist before accepting payments.

## Architecture — keep the moving parts small

| Component | Responsibility |
| --- | --- |
| Vercel | Static responsive website and one Node.js API function |
| Supabase | Email/Google Auth, private Postgres workspaces, subscription state, usage, OAuth grants and a transactional work queue |
| OpenAI | Our server-funded Responses API; no ChatGPT subscription credentials |
| Stripe | One recurring USD $20/month Price, hosted Checkout, customer portal and signed subscription webhooks |
| One self-hosted worker | Sandboxed Chromium/Playwright, secure interactive school login, and saved agent/job steps |

There is no Browserbase dependency or fee. `browserbase/mcp-server-browserbase` is an archived MCP adapter that still calls Browserbase, not its browser hosting backend. This project uses ordinary open-source Chromium and Playwright directly; it does not build a browser engine. **The separate worker still needs a paid/owned Linux host and operational maintenance. Vercel deployments do not create or run that host.**

The official Canvas OAuth API and the browser share one account binding and assignment IDs. API access is preferable for structured course data, materials and verified submissions when an authorized developer key exists. Browser access uses the student's actual school session and follows visible permitted pages and supported external-tool launches. It does not fabricate or generate an API token, bypass denied integration permissions, or guarantee universal school compatibility.

## What changed

- Public **Sign up / Log in / Get MCP** onboarding. Email/password, email confirmation, recovery and Google via Supabase.
- Website and OAuth-authenticated **`/mcp`** use the same user, subscription, courses, memory, drafts and queue.
- A student can connect before paying. Paid computation is checked server-side, including MCP tools and every worker step.
- One $20/month plan, metered model usage, and an optional database-configured future allowance. No customer email or college allowlist and no hardcoded daily AI-call cap.
- Agent conversation can read requirements, propose remembered preferences, plan around real obligations and queue complete supported deliverables.
- Planning supports overnight work/class/activity blocks, timezone, breaks, confirmed availability and course-specific self-reported study pace. Unknown facts are not invented.
- Independent persisted plan → write → review → optionally submit steps. Browser closure does not cancel jobs. A worker outage keeps queued data; uncertain in-flight effects pause for review rather than replay.
- Browser connection uses owner-only screenshot/input controls over HTTPS to an existing Chromium browser. Credentials are not put in model prompts, transcripts, logging, recordings or a shared browser. The operator still controls the remote host; do not misrepresent this trust boundary.
- External tasks have bounded DOM actions, optional screenshots after login checks, iframe/tab handling, session persistence and explicit task-specific submission authorization. Live DOM state is retained between steps; loss of that session pauses rather than blindly replaying an answer.
- Saved editable text and UTF-8 files, exact-content review/approval hashes, fresh assignment checks and confirmed Canvas receipts. A model review is not an executed test or a verified grade.

## 1. Supabase

Create or select the project you will actually use. Run **`supabase/v3.sql`** in its SQL editor as the project owner. This additive migration leaves historical v1/v2 tables untouched. It creates service-only tables/RPCs: browser/anon roles must not be granted direct workspace, job, billing, token or credential access.

Enable **email/password** with email confirmation. Configure production SMTP; provider default email delivery can restrict external recipients and is not a production mail setup. Set the Auth Site URL to `https://www.trycanvasly.com` and allow this exact redirect:

```text
https://www.trycanvasly.com/auth/callback
```

For Google login, create a Google web OAuth client. Put its client ID/secret into **Supabase → Authentication → Sign In / Providers → Google**, and register the callback Supabase displays in Google Cloud (normally `https://PROJECT.supabase.co/auth/v1/callback`). The Google secret is **not** a Vercel/frontend variable. Enable the appropriate production Google consent configuration. Test email confirmation, Google, password reset and logout on the actual canonical domain.

Local testing may additionally allow `http://127.0.0.1:3000/auth/callback`; use separate test projects/keys where possible. The new app authenticates Supabase users, not the prior ChatGPT identities. There is no automatic account merge by email. Historical accounts/data need an explicit verified linking/migration process.

## 2. Vercel environment variables

Use the exact names in `.env.example`. All are server-read; do not add `NEXT_PUBLIC_` or publish secrets in the website. The public Supabase key is used only for Auth operations in this server-side implementation.

| Variable | Value |
| --- | --- |
| `APP_URL` | `https://www.trycanvasly.com` — exact canonical origin, no trailing slash |
| `SUPABASE_URL` | Your project URL |
| `SUPABASE_PUBLISHABLE_KEY` | Supabase publishable/legacy anon key for Auth |
| `SUPABASE_SECRET_KEY` | Server-only secret/legacy service-role key for database operations |
| `APP_ENCRYPTION_KEY` | Stable 64-character hexadecimal random key |
| `OPENAI_API_KEY` | Our billed OpenAI project API key |
| `STRIPE_SECRET_KEY` | A suitably permissioned Stripe restricted key (`rk_`) or server secret key |
| `STRIPE_WEBHOOK_SECRET` | Signing secret for this deployment's Stripe endpoint |
| `STRIPE_PRICE_ID` | Active recurring **USD 2000 cents / month** Price |
| `WORKER_URL` | Separate worker HTTPS origin, e.g. `https://worker.trycanvasly.com` |
| `WORKER_SECRET` | Separate random secret shared only with the worker, at least 32 characters |

Generate `APP_ENCRYPTION_KEY` and `WORKER_SECRET` separately on your computer:

```cmd
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Optional: `OPENAI_MODEL` (default `gpt-4.1-mini`), approved Canvas OAuth credentials below, and `CANVAS_FILE_HOSTS` for additional verified attachment storage hosts. The latter is a **file-egress boundary, not a college admission list**.

Remove obsolete `CANVASLY_MODE`, `CHATGPT_CLIENT_*`, `CHATGPT_TOKEN_AUTH_METHOD`, `CHATGPT_PLAN_USAGE_ENABLED`, `ALLOWED_EMAILS`, `CANVAS_ALLOWED_HOSTS`, `DAILY_AI_LIMIT` and `CRON_SECRET` from this deployment. Public registration is open; private/reserved network destinations are still blocked. Wildcard access to internal infrastructure is not part of supporting colleges.

Never change the encryption key casually: existing encrypted sessions/Canvas credentials become unreadable. Keep production, preview and local secrets separate. `APP_URL` must match the site being visited; unexpected preview-origin write requests are rejected intentionally.

### Vercel project settings

Root `.`, framework **Other**, Node **22.x**, install **`npm ci`**, build **`npm run build`**, output **`public`**. `vercel.json` routes the API, callbacks, Stripe webhooks, MCP and OAuth discovery to one native Web Request function. This adapter preserves raw Stripe signature bytes and separate Set-Cookie headers.

Only the new router is exposed. The old `api/workspace.js` and `api/worker.js` routes have been removed; historical engines remain for regression tests. A Git push triggers a deployment only when your Vercel Git integration is connected and enabled. Schema migrations, email/Google, Stripe setup and the worker are not performed by a Git deployment.

## 3. Stripe

Use a separate Stripe sandbox first. Create one Product named **Canvasly** with a recurring monthly **USD $20 Price**. Put that Price ID in `STRIPE_PRICE_ID`; the server verifies the amount/currency/interval rather than accepting a browser-selected price.

Configure hosted Customer Portal so customers can cancel/manage payment methods. Add a webhook endpoint:

```text
https://www.trycanvasly.com/api/stripe
```

Subscribe to `customer.subscription.created`, `customer.subscription.updated`, `customer.subscription.deleted`, `invoice.paid`, `invoice.payment_failed`, `checkout.session.completed`, and `checkout.session.async_payment_succeeded`. Copy its signing secret to `STRIPE_WEBHOOK_SECRET`. The handler verifies the **raw body signature**, resolves Stripe Customer/Subscription ownership, queries current subscription state and deduplicates events transactionally. A Checkout success redirect never activates paid access by itself.

The API is pinned to `2026-08-26.dahlia`. Restricted keys need the relevant Customers, Prices, Checkout Sessions, Subscriptions and Billing Portal read/write operations. Keep sandbox keys/Price IDs/webhook secrets separate from live values. No live Product, Price, webhook or payment is created by this source package.

Consider tax obligations before live sales. Stripe Tax requires appropriate configuration/registrations; this integration does not enable automatic tax without them. Choose and disclose actual subscription allowances before selling a plan; the current `canvasly_plans.model_call_limit` is NULL because the owner has not chosen them. NULL is **not** a promise of unlimited usage. Set a positive allowance in that table when decided. Atomic usage reservations and operational anti-abuse/step limits already exist.

## 4. Self-hosted worker (required for unattended work)

A regular Linux server with Docker Compose, supported Chromium sandbox/user namespaces, and an HTTPS hostname is required. Start with enough memory for the configured Chromium capacity, measure actual usage, and scale deliberately. The provided Compose resource ceiling is **4 GB / 2 CPUs / two active browsers**, not a performance guarantee. Registered accounts do not consume an always-open browser; tasks queue and sessions close when finished.

On that server, clone the same committed source as Vercel, copy `worker/.env.example` to `worker/.env`, and fill it in. The worker needs **`APP_ENCRYPTION_KEY`, `SUPABASE_URL`, `SUPABASE_SECRET_KEY`, `OPENAI_API_KEY`, `WORKER_SECRET`**, and `WORKER_HOST` for Compose HTTPS. Encryption/worker keys must match the website. It does not need Stripe or Google credentials. Copy any optional model/Canvas credential configuration needed by the selected API connection too.

Point the worker hostname's DNS at that server. From the repository root:

```bash
node scripts/prepare-worker.mjs
docker compose --env-file worker/.env -f worker/compose.yaml up -d --build
```

The preparation script fetches Playwright's **v1.64.0** seccomp profile and verifies its exact Git blob checksum before writing the host file. Docker Compose enables it, uses non-root Chromium, and keeps the browser sandbox enabled. Unsupported hosts fail the startup probe. **Do not fix sandbox errors with `--no-sandbox`, a privileged container, or an exposed CDP port.** Review the host's user-namespace/AppArmor/firewall configuration. This Docker image has not been built or verified in the generation environment.

Caddy terminates HTTPS on 80/443. The worker's 8080 and internal CONNECT proxy are not published. The worker checks `WORKER_SECRET`; public callers cannot choose an arbitrary account/browser. Network requests are restricted to public HTTPS addresses with DNS pinning, private-IP rejection and no direct WebRTC/QUIC bypass. Also enforce an outbound firewall that denies host/private/metadata networks and limit access to the worker origin. Do not log command bodies, browser frames, credentials or authenticated URLs.

The worker polls a transactionally leased Supabase queue and heartbeats. No Vercel cron or browser tab drives execution. The UI reports a missing/offline worker. Its initial implementation deliberately runs **one model/job step at a time per worker**, with one active step per account. Interactive sessions can coexist within browser capacity. **Use one worker instance initially**: external tasks retain live DOM state on that instance. Multi-host scheduling of live browser sessions needs affinity and a tested session router; scaling replicas without that can pause tasks.

Restart/update the worker from the new commit when application/worker protocol changes. Browser storage is encrypted in Supabase; unfinished form state is not. A process interruption pauses an external workflow for review rather than replaying an ambiguous write. Cookies/MFA may expire: a student must reconnect when the school requires it.

## 5. Canvas connections

**Cloud browser:** Connections → enter the school's HTTPS Canvas origin → Connect cloud browser → use the real school login in the private browser view → complete MFA → Save connection. The backend verifies the Canvas account identity before saving encrypted browser storage. It does not collect personal API tokens or generate one through the UI. Some SSO, passkey, device-bound or anti-automation workflows will require another connection method or remain unsupported. Respect school/vendor permissions; do not bypass security controls.

**Official API:** Use only an institution-enabled or approved global developer key. Register:

```text
https://www.trycanvasly.com/canvas/callback
```

Either configure `CANVAS_CLIENT_ID` + `CANVAS_CLIENT_SECRET` for an authorized global registration on Instructure-owned `*.instructure.com` hosts, or use an exact-host credential map for issued school/custom-domain registrations. Global secrets are never sent to an arbitrary user-supplied site:

```dotenv
CANVAS_OAUTH_CLIENTS_JSON={"school.instructure.com":{"client_id":"ISSUED_ID","client_secret":"ISSUED_SECRET"}}
```

This mapping selects issued application credentials; it does **not** restrict who may sign up. Never invent a client registration or treat a normal browser login as API authorization. With no eligible API key, the UI reports that API access is unavailable and offers the browser connection. Students must authorize the app within whatever permissions the institution allows.

Both connection methods must resolve to the same school and Canvas user to be combined. Reconnecting another user invalidates previous draft/submit bindings. Disconnect clears saved state; if remote closure cannot be confirmed, the UI tells the user to revoke the session at the school. API revocation should also be done in Canvas Settings.

## 6. Remote MCP

In an OAuth-capable remote MCP client, connect:

```text
https://www.trycanvasly.com/mcp
```

The client discovers Canvasly's authorization server and registers its callback, uses S256 PKCE, opens the same Supabase-backed sign-in, then displays Canvasly's consent page. Tokens are **resource-bound opaque credentials**, hashed in Postgres, with short-lived access and rotating single-use refresh tokens. Website cookies/Supabase tokens are not accepted as MCP bearer tokens. Disconnecting a grant revokes that client family. Reconnection invalidates old grants rather than reviving their tokens.

The initial authorization is interactive; refresh handles normal later use. Reauthentication can still be required after revocation/expiry. Client feature/plan availability is not controlled by this repository. **No live ChatGPT connection, public plugin publication or independent review of this narrow OAuth adapter has been completed.** Do not enable a separate Supabase OAuth Server for this implementation; Supabase supplies identity and this app supplies the resource-bound MCP adapter.

Tools: `get_context`, `list_tasks`, `get_deliverable`, `control_task`, `read_assignment`, `sync_courses`, `plan_week`, `delegate_assignment`, `propose_memory`, `propose_commitment`, `stage_deliverable`.

MCP delegation returns a saved task ID immediately. The self-hosted worker continues independently of ChatGPT. A host client can also stage its own completed text/source files. Staged work needs a review; final submission is hash-bound. Any `submit_when_ready=true` call must reflect the student's explicit authorization for that specific assignment and the literal `SUBMIT` confirmation, not instructions hidden in a course document.

## Local development and tests

```cmd
npm ci
npm run check
npm run dev
```

Open `http://127.0.0.1:3000`. The public site and **explicitly labeled illustrative preview** need no keys. Live signup/data requires Supabase and `.env.local`; the worker requires its separate environment. Use `copy .env.example .env.local` on Windows. Do not expose the local server through an untrusted reverse proxy.

Root runtime has no third-party npm dependencies. The separate worker pins Playwright 1.64.0; it is installed during Docker build. The old local `mcp/` and v2 files are historical/regression code, not current public setup instructions. `npm run mcp` prints the new remote connection instructions.

## Supported scope and launch checks

See **[implementation plan](docs/IMPLEMENTATION-PLAN.md)** and **[launch checklist](docs/LAUNCH-CHECKLIST.md)** for acceptance tests and remaining operational requirements.

Ordinary Canvas text/source-file/real-URL submissions and supported visible external workflows are implemented. No proctored/timed-exam operator, CAPTCHA solving, device/MFA bypass, account/payment manipulation, arbitrary code execution, code sandbox, binary PDF/Office generation, desktop software, live calendar integration, universal external-site adapter or automatic retention policy is claimed. Prepare-only external tasks stop before entering potentially autosaved answers; authorize the specific assignment to allow those writes.

API source collection is bounded (active course cap, pagination, selected related pages and small supported attachments); the browser fallback reads visible instructions/rubrics and listings, not every linked document. Missing/partial data is exposed. Unknown due dates are never invented. LTI single-sign-on, iframe/cookie behavior and grade passback need platform-specific testing. A delayed external grade passback yields an unconfirmed result, not a fake receipt.

Secrets stay outside model context. Course text and websites are untrusted input. Tool allowlists, credential checks, account isolation, submission hashes and constrained browser actions reduce—but do not eliminate—prompt-injection or browser risk. HTML/model text is escaped in the app. Database access is server-only. The operator must arrange monitoring, backups, retention, privacy disclosures, dependency updates, security review and incident response. This source is not a formal security certification.

## Primary references

- [Canvas OAuth and developer-key rules](https://developerdocs.instructure.com/services/canvas/oauth2/file.oauth)
- [Canvas submissions](https://developerdocs.instructure.com/services/canvas/resources/submissions)
- [Supabase email authentication](https://supabase.com/docs/guides/auth/passwords)
- [Supabase Google authentication](https://supabase.com/docs/guides/auth/social-login/auth-google)
- [Stripe subscription webhooks](https://docs.stripe.com/billing/subscriptions/webhooks)
- [MCP authorization](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization)
- [OpenAI MCP authentication](https://developers.openai.com/plugins/build/auth)
- [Playwright Docker sandbox guidance](https://playwright.dev/docs/docker)
- [Browserbase MCP adapter](https://github.com/browserbase/mcp-server-browserbase)

Independent of Canvas, Instructure, OpenAI, Supabase, Stripe and any school.
