# canvasly

**What can I take off your plate?**

A student agent, not a study-planner dashboard. Talk to the agent, delegate supported coursework, and review what it produces. Planning is the supporting feature: it fits around real work shifts, classes and life, then adjusts estimates using the student's own study check-ins.

This revision is **v2 of the product, package version 0.4.0**. It replaces the green/serif dashboard with a neutral conversation workspace. It is an engineering preview with tested local flows, not a claim of approved public integrations or a production security audit.

## What is implemented

| Surface | Included |
| --- | --- |
| Agent | Conversation, current course context, tools to read materials, propose memory/schedule changes, plan, and queue full supported assignment drafts |
| Delegated work | Persisted plan → write → review jobs, editable complete text/source-file deliverables, manual pause/resume and explicit Canvas submission |
| Student context | Recurring obligations, overnight shifts, buffers, time zone, possible study window, daily cap, course types, explanation preferences and approved memories |
| Adaptive planning | Per-course duration estimates based on self-reported study sessions; no inference of mastery from agent-written assignments |
| Website | Responsive conversation, My work, My week, About you and Connections |
| MCP | A local stdio bridge using the exact same paired account, profile, Canvas connection and saved drafts as the local website |
| Authentication | ChatGPT authorization-code/PKCE/OIDC flow, local dynamic registration, hosted registration gates, rotating refresh credentials and encrypted sessions |
| Canvas | Institution-authorized OAuth, bounded source collection, sync, text/file/URL submission controls |

The preview workspace uses a fictitious student and example coursework. No sample data is copied into real accounts. Preview chat and example drafts are explicitly illustrative, not live inference. A student's unknown start time, work days or sleep schedule must be supplied rather than invented.

## Two ways to use it

### Website agent using the student's ChatGPT plan

The new workspace does **not** use `OPENAI_API_KEY` or silently fall back to founder-funded API calls. It uses the authorized student's OAuth token at the public Responses endpoint, with `stream: true` and `store: false`. Models are discovered for that signed-in account rather than hardcoded.

OpenAI documents a **local open-source direct flow** separately from **hosted/commercial access**. Hosted sign-in is a limited-trial approval process, and hosted plan usage needs approval too. Neither an `oaiapp_`-looking string nor a feature flag grants access. Confirm the applicable program eligibility and source licensing before distributing this as an open-source integration.

Sign-in does not import the student's ChatGPT conversations or existing personal context. Canvasly's memory is built from context the student supplies here and explicitly approves. Usage remains subject to the student's plan and app limits; it is not unlimited or “no API” technically. The difference is whose plan authorizes inference.

### MCP using the host client's model

Start the local website and choose **Connections → Use a local MCP workspace**, or sign in with ChatGPT. Connect Canvas, then **Pair this workspace with MCP**. The stdio bridge reads a private local pairing file. The host model reads requirements, generates the deliverable and stages it in **My work**. The bridge itself does not call a paid model API.

The two surfaces share the *explicitly paired local account*. A local MCP-only account and a new ChatGPT identity are separate until you select and pair the intended account; they are not silently merged. Local accounts do not synchronize automatically to a Vercel-hosted account.

This build does **not** expose a hosted Streamable HTTP MCP server or publish a ChatGPT plugin. It needs a client that supports **local stdio MCP**. A public remote MCP surface still requires a separately authenticated transport, provider registration and end-to-end client testing.

## Run locally on Windows

Extract the source ZIP into a new folder. Run commands in the folder that actually contains `package.json`:

```cmd
npm ci
npm run check
npm run dev
```

Open **http://127.0.0.1:3000**. Do not substitute `localhost`: the local ChatGPT callback flow uses a literal loopback address.

No keys are required to inspect the interactive preview or use a local MCP-only profile. To configure actual services:

```cmd
copy .env.example .env.local
```

Edit `.env.local` and restart the server. Local mode automatically creates `.canvasly/encryption.key` and private data files; keep that folder out of source control and backups you share. Losing the key makes stored credentials unreadable. The local server binds only to `127.0.0.1` and validates its Host header. Do not expose this local mode through a tunnel or public reverse proxy.

### ChatGPT local sign-in

Choose **Continue with ChatGPT**. The backend starts the documented dynamic registration, binds callback state to this browser, validates the returned identity and saves the issued client registration. Choose the saved account on later launches. Select an available model in Connections. Real provider acceptance and inference must be tested with your own eligible account; they were not tested here.

### Canvas connection

For a multi-student product, use OAuth. Canvas explicitly disallows asking other users to generate and paste personal access tokens. Ask the relevant institution's Canvas administrator to issue/enable an API developer key for Canvasly and register this callback:

```text
http://127.0.0.1:3000/canvas/callback
```

For hosted use, register your exact HTTPS origin followed by `/canvas/callback` instead. Use separate registrations when required by the school.

Put exact hostname mappings in `.env.local` or the hosted server environment:

```dotenv
CANVAS_ALLOWED_HOSTS=school.instructure.com
CANVAS_OAUTH_CLIENTS_JSON={"school.instructure.com":{"client_id":"ISSUED_ID","client_secret":"ISSUED_SECRET"}}
```

The JSON value must be one valid JSON object, not escaped twice. Match permitted API scopes to the endpoints used in `lib/canvas.mjs`; an optional `scope` string in each registration is passed into the authorization request. An institution may decline or restrict approval. The app never collects university passwords or bypasses institutional controls.

For testing **your own account only**, `CANVAS_PERSONAL_TEST=true` enables a local-only personal-token form. This switch is ignored in hosted mode. It is not a student onboarding shortcut.

### MCP configuration

Start the website first, connect Canvas, pair the intended account, and add this to a stdio-compatible MCP client:

```json
{
  "mcpServers": {
    "canvasly": {
      "command": "node",
      "args": ["C:/actual/path/to/canvasly/scripts/mcp.mjs"]
    }
  }
}
```

Only the `args` path needs replacing in the default layout. The script resolves `.canvasly` relative to its own repository folder, not the MCP client's working directory. A custom `CANVASLY_DATA_DIR` must be the same absolute directory for the server and bridge. Do not use `npm run mcp` as the host command because npm can print non-protocol text to stdout.

Try: “Read my Canvasly context. Read the OS assignment. Prepare the complete answer or source files and stage the deliverable in My work. Propose any schedule changes; do not submit.”

Tools: `get_context`, `read_assignment`, `plan_week`, `propose_memory`, `propose_commitment`, `stage_deliverable`. The host can save full text and UTF-8 source files. Binary PDFs from Canvas are noted but not returned through the text-only MCP tool. Website drafting can pass supported PDFs to the model. No submission, secret-access or blanket profile-edit tools are exposed to MCP.

## Planning that respects real life

Enter or approve your recurring work/class/activity blocks, possible study window, buffers and daily study cap. A Monday shift from 17:00 to 01:00 protects Monday evening **and Tuesday morning**, including the configured buffer. Time-zone conversion accounts for daylight-saving offsets. The scheduler uses 15-minute slots, honors deadlines and breaks, and reports unscheduled work when capacity is insufficient.

The conversational agent can propose a fully specified recurring block; it must ask for missing days/times. Suggestions appear in **About you → Memory** and affect planning only after approval. Initial availability still requires confirmation in About you.

Log your own study sessions to improve per-course estimates. At least three observations are required before changing the initial pace estimate; early values are shrunk toward the original estimate. Explanation-format preferences and self-reported understanding are editable. This is a transparent heuristic, not a newly trained learning model, diagnosis, fixed “learning style,” or independently verified mastery measurement. Automatic extraction of study duration or grades from behavior is not implemented.

## Work that continues while the browser is closed

The browser creates persisted jobs. It is not the scheduler.

**Local:** `npm run dev` runs a polling worker with the server. Closing the tab is fine; stopping Node, sleeping or shutting down the computer stops execution. Saved queued work is retained. An interrupted in-flight job becomes paused for explicit recovery rather than silently repeating an uncertain model request.

**Hosted:** the repository contains `/api/worker` and `scripts/worker.mjs`, but **nothing has been deployed or scheduled**. Add a trusted scheduler that calls `/api/worker` with `Authorization: Bearer <CRON_SECRET>`, or run `npm run worker` on an always-on server with `APP_URL` and `CRON_SECRET`. Each invocation performs one saved agent/model step. Merely setting environment variables or opening Vercel does not start a scheduler. Validate the scheduler frequency and execution limits for your chosen hosting plan. Public launch needs a production queue/monitoring configuration; the included private-beta polling worker is not a high-throughput queue service.

There is one active model step per student, version-checked data writes and time-limited leases. Timeout/uncertain-response recovery pauses for explicit resume; completed work is not replayed automatically. Account scanning is bounded to 1,000 private-beta accounts; worker fairness is process-local and not a global scheduling guarantee.

## Hosted environment and database

The new app uses verified ChatGPT identity and its own session, not the old Supabase email/password flow. It still uses Supabase Postgres for hosted storage. Run **`supabase/v2.sql`** in your Supabase SQL editor first. Table access is service-only; do not grant browser access to the records table.

| Variable | Purpose |
| --- | --- |
| `CANVASLY_MODE=hosted` | Explicit hosted mode; Vercel automatically forces hosted behavior too |
| `APP_URL` | Exact HTTPS origin of your website |
| `APP_ENCRYPTION_KEY` | Stable random 32-byte key encoded as 64 hexadecimal characters |
| `SUPABASE_URL` | Project URL |
| `SUPABASE_SECRET_KEY` | Server-only Supabase secret key; legacy service-role keys also work |
| `CHATGPT_CLIENT_ID` | Actual approved OpenAI application registration |
| `CHATGPT_CLIENT_SECRET` | Only when issued for your registered confidential-client setup |
| `CHATGPT_TOKEN_AUTH_METHOD` | Registered method: `none`, `client_secret_post`, or `client_secret_basic` |
| `CHATGPT_PLAN_USAGE_ENABLED` | `true` only once hosted plan usage is approved; default false |
| `CANVAS_ALLOWED_HOSTS` | Exact institution Canvas hostnames |
| `CANVAS_OAUTH_CLIENTS_JSON` | Per-institution approved client ID/secret mapping |
| `CRON_SECRET` | Long random secret shared with your trusted scheduled worker |
| `ALLOWED_EMAILS` | Recommended private-beta verified-email allowlist |
| `DAILY_AI_LIMIT` | Optional per-user model calls per UTC day; default 48 |
| `CANVAS_FILE_HOSTS` | Optional exact authorized attachment storage hosts |

Generate each server secret locally:

```cmd
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

The published direct plan-usage flow is implemented behind explicit local/hosted gates. Confirm that your approved hosted agreement supports the requested plan-usage scopes and token authentication method before enabling it. Identity-only authorization does not power inference. Unsupported provider grants are rejected, not replaced with a hidden API bill.

**Do not add `NEXT_PUBLIC_` prefixes.** Do not put student tokens in Vercel environment variables. `OPENAI_API_KEY`, `SUPABASE_PUBLISHABLE_KEY`, and `OPENAI_MODEL` from the previous website are not used by the new workspace. Supabase Auth redirect settings are no longer the v2 identity flow.

Vercel settings for your own manual deployment remain: root `.`, framework **Other**, Node **22.x**, install `npm ci`, build `npm run build`, output `public`. Register the exact `/auth/callback` and `/canvas/callback` URLs before using real OAuth. No cron is enabled automatically in `vercel.json` and no deployment was created.

## Migration and original code

This is an additive database revision, not a destructive migration. The old `supabase/schema.sql` and old records remain intact. Old Supabase-user accounts are not mapped to ChatGPT identities by matching email: that would be unsafe. Export old data and implement an explicit verified account-linking flow before a migration of real users. There is no automatic cross-account migration in this source package.

The original standalone toolkit remains under `mcp/`. It has its old independent setup and does **not** share v2 records. Its historical personal-token/API-key instructions are for that local legacy tool, not the new multi-user website. The former web API is retained as `lib/legacy-api.mjs` solely for regression coverage and is not exposed by the new API routes.

## Privacy, reliability and boundaries

Credentials and cookies are encrypted using the app key. Local coursework/profile JSON is stored in a private local directory, **not encrypted as a whole**; use full-disk encryption for your computer. The local encryption key resides on that same computer, not in an OS keychain. Hosted records are private to your server secret; back up, expire and delete them according to your operational policy.

Course content is untrusted input. Tokens stay outside model context and UI state. The model has an explicit tool allowlist; profile/memory changes need approval. This mitigates but does not eliminate prompt-injection risk. The native OIDC implementation validates signature, issuer, audience, expiry and nonce; arrange an independent security review and consider a maintained OIDC library before public launch.

`store: false` is not a universal promise of zero provider retention. Read the provider's applicable account/program policies. Sign-out attempts remote revocation and reports when it cannot confirm it. Canvas disconnect clears local credentials and directs users to revoke the grant in Canvas Settings. Data erasure does not retract submissions already sent to the institution.

Supported deliverables are normal text, a bounded set of UTF-8 source files and real URLs staged by the MCP host. There is no code sandbox, proctored/timed quiz automation, external homework-site operator, academic discussion impersonation, browser-use agent, Office/PDF output generator, payment system, automatic calendar integration or remote MCP OAuth server. The new UI does not yet offer arbitrary additional document uploads beyond gathered Canvas materials. Source collection remains bounded; inspect warnings for missing modules, pages and files. Use only authorized content and respect applicable course rules.

Submitting is a separate, explicit browser action tied to the exact saved content hash, review state, current assignment instructions and Canvas-account binding. Unsaved editor changes block submit/review; saving invalidates the prior review. An uncertain submission result requires manual inspection instead of a blind retry. Reviews are model assessments, not verified grades or proof generated code ran.

## Validation

`npm run check` runs syntax/configuration validation and the native tests. This revision has **75 passing automated tests**: 43 original regression tests plus 32 tests of the v2 scheduling, identity, inference, persistent-work and integration paths.

New tests include overnight shifts, DST repeated hours, unavailable-time protection, course-specific pace, signed OIDC fixtures, PKCE/issued-client registration, callback replay rejection, refresh rotation, origin checks, account isolation, memory approval, atomic writes, worker checkpoints, concurrent-worker exclusion, stale-job pause, interrupted/late-error model streams, a real local stdio MCP → HTTP bridge, and a **mocked** Canvas → subscriber-funded inference → edit/review → confirmed submission workflow.

Desktop/mobile Chromium checks rendered the actual frontend source in a local harness, checked navigation, schedule editing, illustrative delegation, draft editing/review invalidation and preview chat. No JavaScript errors or mobile horizontal overflow were observed. Browser URL navigation was restricted in the build environment, so these were a source-rendering harness, not a browser session against live providers.

**Not performed:** a real ChatGPT authorization or inference call, live Canvas login/submission, live Supabase migration, Vercel deployment, production scheduler execution, external MCP-client approval, load test or independent security audit. Passing fixtures is not proof of provider acceptance. Before inviting students, validate the complete configured flow in an authorized test course and confirm external approvals.

## Primary references

- [ChatGPT plan usage overview](https://developers.openai.com/siwc/token-sharing-open-source)
- [Website sign-in and commercial access](https://developers.openai.com/siwc/website)
- [Local registration and PKCE sign-in](https://developers.openai.com/siwc/token-sharing-open-source/sign-in)
- [Account-specific models and completed inference](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference)
- [Token rotation and sessions](https://developers.openai.com/siwc/token-sharing-open-source/profiles-and-sessions)
- [Canvas OAuth and multi-user API policy](https://developerdocs.instructure.com/services/canvas/oauth2/file.oauth)
- [MCP stdio transport](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports)

Independent of Canvas, Instructure, OpenAI and any university.
