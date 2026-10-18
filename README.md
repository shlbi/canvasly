# canvasly.

**Your semester, a little lighter.** A minimal school-themed Canvas workspace with a checkpointed AI coursework agent.

Warm paper, forest green, course folders, a deadline desk, and a draft editor. The website is a working application, not just a landing page. The clearly labeled preview workspace runs without API keys; real accounts never inherit preview records.

## What works

- Email/password sign-in, email confirmation, password recovery, encrypted HttpOnly sessions.
- Per-user Canvas connection; courses, assignments, deadlines, submission status, search/filtering, and calendar export.
- Assignment packets containing instructions, rubric, related module pages and bounded PDF/text attachments. Unsupported or missing sources are reported.
- Separate planning, writing and review stages, with saved database checkpoints and optimistic concurrency control. Resume interrupted runs; draft up to three assignments sequentially.
- Text answers, editable source files, and review of a user-provided URL. Download, edit, save, revise and review deliverables.
- Explicitly confirmed Canvas text/file/URL submissions, with current-content hashes, fresh assignment checks, submission receipts, and uncertain-result protection.
- A responsive preview mode for demonstrating the interface without exposing real course records.

The original Canvas Unlocked MCP/CLI is preserved in [`mcp/`](mcp/README.md). It is a separate local stdio application, not a remotely hosted MCP endpoint, and does not share the website's database.

## Stack

Native JavaScript modules + CSS in `public/`; a Node.js 22 Vercel function in `api/index.js`; server modules in `lib/`; Supabase Auth/Postgres; OpenAI Responses API. The website has **no third-party runtime npm dependencies**. No framework bundler or browser SDK is needed. `npm run build` validates syntax and configuration; static assets are already in `public/`.

## 1. Create the database and authentication

Create a Supabase project, then:

1. Run the complete [`supabase/schema.sql`](supabase/schema.sql) in the project's SQL editor. It creates the tables, restrictive grants/RLS, and atomic usage-limit function. Do not make these tables publicly readable.
2. Enable email/password authentication. Keep email confirmation enabled for a public-facing service. Configure your email delivery before inviting outside users; your project's email settings may restrict recipients.
3. Set **Authentication → URL Configuration → Site URL** to your final website origin. Add that URL, with a trailing `/`, to Redirect URLs. For local testing also allow `http://localhost:3000/`.
4. Copy the project URL, publishable key, and server secret key from the project's Connect/API Keys settings. The server also accepts legacy anon/service-role values, but the environment names below remain unchanged.

## 2. Environment variables

Set these on Vercel before **you** deploy. For local development put them in `.env.local`, which is ignored by Git. No variable needs a `NEXT_PUBLIC_` prefix.

| Variable | Value |
| --- | --- |
| `SUPABASE_URL` | Your Supabase project URL, e.g. `https://PROJECT.supabase.co` |
| `SUPABASE_PUBLISHABLE_KEY` | Supabase publishable key (`sb_publishable_...`) |
| `SUPABASE_SECRET_KEY` | Supabase **server-only** secret key (`sb_secret_...`) |
| `OPENAI_API_KEY` | An OpenAI API key with API billing/credits and access to the configured model |
| `APP_ENCRYPTION_KEY` | A random 32-byte key encoded as **64 hexadecimal characters**; generate below |
| `APP_URL` | Exact website origin, e.g. `https://your-project.vercel.app`; locally `http://localhost:3000` |
| `CANVAS_ALLOWED_HOSTS` | Exact permitted Canvas hostname(s), comma-separated; no scheme, path, port or wildcard |
| `ALLOWED_EMAILS` | Recommended private-beta allowlist, e.g. `you@example.com`; blank permits public registration |
| `OPENAI_MODEL` | Optional; defaults to `gpt-4.1-mini` |
| `DAILY_AI_LIMIT` | Optional; defaults to `24` model calls per user per UTC day |
| `CANVAS_FILE_HOSTS` | Optional extra exact storage hostnames for your institution's attachments |

Generate the encryption key on your own computer:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Keep this key stable. Changing it invalidates sessions and stored Canvas tokens, requiring reconnection. Never commit keys or paste them into chat/screenshots. A ChatGPT subscription is not an API key.

`CANVAS_ALLOWED_HOSTS` is the hostname from your school's Canvas URL. Example: a Canvas URL of `https://school.instructure.com` requires `school.instructure.com`. This is an administrator-controlled network allowlist, not a wildcard request proxy.

Supabase, OpenAI and Canvas credentials are read on the server only. **Do not put one shared student Canvas token in Vercel environment variables.** Each user signs in, opens Settings, and connects their own token; it is encrypted in their database row.

Use separate environment values/projects for development and production. `APP_URL` must match the address you are actually visiting; writes from a different preview domain are rejected. Set an OpenAI project spending limit and a private-beta email allowlist before inviting users.

## 3. Vercel settings — deployment is manual

Import this GitHub repository yourself. No deployment is created by this source package.

| Setting | Value |
| --- | --- |
| Root directory | `.` (not `mcp/`) |
| Framework preset | **Other** |
| Node.js version | **22.x** |
| Install command | `npm ci` |
| Build command | `npm run build` |
| Output directory | `public` |

`vercel.json` supplies the static output, security headers and the single native API function with a 60-second maximum duration. Each model stage is a separate request. After adding/changing environment variables, deploy/redeploy so they take effect. Once you choose your final origin, update `APP_URL` and the Supabase authentication URLs to the same origin.

## 4. Connect Canvas and run an assignment

Sign up and confirm your email. In **Settings**, enter the Canvas origin and your own personal Canvas API token. Where enabled, Canvas tokens are created under Account/Settings → Approved Integrations → New Access Token. If your school disables this, use its approved integration process; this application cannot bypass that restriction.

Connect and sync. Open an assignment, inspect its materials, add any missing supported sources, select a deliverable format, and start the agent. The app discloses that the selected content goes to OpenAI. Keep the tab open while a run proceeds. You can pause between stages or reopen a saved draft and resume.

Review the full result. Editing a saved deliverable invalidates its prior review. Submitting requires a fresh review and typing `SUBMIT`; the server verifies the exact saved content, current assignment and account binding. A submission with an uncertain network outcome is marked for manual inspection rather than retried. Already-submitted assignments cannot be overwritten through the app; use Canvas itself for an intentional resubmission.

Use authorized course materials and follow the applicable course rules for generated work.

## Local development (Windows works)

Install Node.js 22, then:

```bash
git clone https://github.com/shlbi/canvasly.git
cd canvasly
npm ci
npm run check
npm run dev
```

Open `http://localhost:3000`. Preview mode works with no credentials. For live integrations, copy `.env.example` to `.env.local`, fill it in, and restart the server:

```cmd
copy .env.example .env.local
```

To run the original standalone MCP, use the separate instructions in `mcp/README.md`. Its additional dependencies are not installed by the website's root `npm ci`.

## Data and security

Canvasly stores connection metadata, encrypted Canvas tokens, cached courses/assignments, assignment packets, drafts, reviews and submission receipts in your Supabase project. PDFs included in a draft packet are stored as bounded base64 data. Database access goes through authenticated server routes, with user ownership checks on every row operation; direct anon/authenticated table access is revoked. The service key is privileged and must remain server-only.

The model receives selected assignment content, sources, notes and draft text — not Canvas tokens or Supabase credentials. Responses requests use `store: false`; this does not by itself promise zero retention under every provider policy. Generated code is never executed by the server. Model-provided text is escaped before UI rendering, and source instructions are treated as untrusted input. Canvas origin allowlists, constrained signed-download hosts, file/type limits, quotas, version locks and CSRF-origin checks are included.

Settings allows disconnecting Canvas or erasing application data. Erasing app data does not delete work already submitted in Canvas or the Supabase Auth login itself. Configure database retention/backups and operational monitoring to suit your deployment. This is not a formal security audit.

## Scope and limitations

This is a deployable **private-beta implementation**, not proof that AI can autonomously complete a degree.

- Supports ordinary Canvas text entries, text/source-file uploads and a real URL you supply. It does not operate timed/proctored quizzes, external homework platforms, discussions, or hands-on assignments.
- No computer-use agent, code sandbox, web research tool, binary PDF/Office output, payment system or university-wide OAuth onboarding is implemented.
- Course extraction is bounded: up to 24 courses, paginated assignment lists, first 20 modules, up to 3 relevant pages and 2 linked files per packet. Canvas downloads are capped at 1 MB each. The UI accepts up to 3 small extra sources; request/packet limits also apply. DOCX/PPTX and large or unusual files need conversion or manual context. Warnings expose skipped/partial data.
- An agent review is a model assessment, not a verified grade or a claim that generated code passed execution tests. Small model limits can truncate complex work; incomplete/refused output is rejected rather than silently accepted.
- Runs save checkpoints but are **browser-driven**, not background queue workers. Closing the tab stops subsequent stages; already-running requests may finish. Reopen and resume. Stale-step recovery waits 2 minutes.
- Public multi-institution launch needs approved OAuth onboarding, stronger abuse controls/monitoring, load tests and appropriate institutional review. Start with `ALLOWED_EMAILS` restricted.

## Validation

`npm run check` passes **43 automated tests**: 29 web/backend tests and 14 original MCP tests. Coverage includes encrypted tokens, origin/path restrictions, file-upload credential isolation, storage limits, agent checkpoints, concurrency locks, changed-content checks, uncertain submissions and a mocked sign-in-to-submission workflow.

The integration tests substitute Supabase, Canvas and OpenAI responses. **No live university login, live AI generation, live database migration or live Canvas submission was performed.** The original MCP SDK handshake remains unverified. Browser checks exercised local source in a Chromium harness at desktop/mobile widths, including simulated drafting, review, edit/save invalidation and navigation; they are not proof of a deployed provider integration. The included GitHub workflow runs native tests only and never deploys.

After configuring your services, validate with an authorized test course before real submissions: confirm email, connect/sync, generate one draft, edit/review, and confirm one test submission in the Canvas website.

## Official references

- [Canvas submissions](https://developerdocs.instructure.com/services/canvas/resources/submissions)
- [Canvas file uploads](https://developerdocs.instructure.com/services/canvas/basics/file.file_uploads)
- [Supabase API keys](https://supabase.com/docs/guides/getting-started/api-keys)
- [Supabase redirect URLs](https://supabase.com/docs/guides/auth/redirect-urls)
- [OpenAI structured outputs](https://developers.openai.com/api/docs/guides/structured-outputs)
- [OpenAI GPT-4.1 mini](https://developers.openai.com/api/docs/models/gpt-4.1-mini)
- [Vercel Node.js functions](https://vercel.com/docs/functions/runtimes/node-js)

Independent of Canvas, Instructure and any university.
