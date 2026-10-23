# Launch checklist — evidence before accepting payments

## Configuration

- [ ] Apply `supabase/v3.sql` in the actual project and verify a non-service browser role cannot read any Canvasly table or call a privileged RPC.
- [ ] Set the exact canonical app origin and register Supabase/email/Google redirect URLs. Configure SMTP and test confirmation/recovery with an external email address.
- [ ] Set separate production secrets, API billing safeguards and the chosen model. Never reuse a sample value.
- [ ] Create the USD $20 monthly Stripe Price, configure Portal and signed subscription webhooks. Choose/disclose actual usage allowances and tax handling before selling access.
- [ ] Start the worker on a separately administered HTTPS Linux host. Verify its checksum-pinned seccomp profile, non-root sandbox, outbound firewall, memory ceiling, private ports and shared secret.
- [ ] Verify Vercel uses the same source version as the worker, and the app shows a current worker heartbeat.

## Live acceptance flow

- [ ] Sign up with email, confirm, log out/in, recover the password and sign in with Google. Verify they resolve to the intended Supabase identity; do not merge accounts by an unverified email assertion.
- [ ] Connect a real authorized test Canvas account in the cloud browser. Complete actual school SSO/MFA. Verify another account cannot see that browser or reuse its storage.
- [ ] Where an approved API registration exists, connect it and verify its user matches the browser. Test refresh/revocation and changed-account handling.
- [ ] Sync course listings and due dates. Inspect explicit warnings for partial or missing sources; do not market full coverage based on a single school.
- [ ] Complete a Stripe **sandbox** subscription. Test initial payment, delayed webhook, duplicate event, renewal, failure, cancellation, changed plan and returning-user portal. A success URL alone must not unlock computation.
- [ ] Start a permitted test assignment, close the laptop, and open the phone site. Observe actual saved progress and a complete deliverable. Test an interrupted worker and a lost browser session.
- [ ] Edit the deliverable, confirm review invalidation, re-review, authorize that exact saved content and check the actual Canvas receipt. Inject a timeout after write and ensure there is no automatic second submission.
- [ ] Test one external-tool/LTI assignment end-to-end, including popup/frame and several unsaved fields. Verify session state is retained and Canvas grade passback is not assumed instantaneous.
- [ ] Connect a real OAuth MCP client, verify the consent identity/resource/scopes, initial authorization and refresh. Revoke the connection, check old access/refresh rejection, reconnect and verify old credentials remain rejected.
- [ ] Start a task through MCP, stop the client, inspect it on the phone and confirm the shared subscription and deliverable.
- [ ] Test phone navigation, keyboard accessibility, dark-text contrast, unsaved edits, slow networks, repeated clicks and connection expiration.

## Operations

- [ ] Independent security review of OAuth, school-session custody, browser/host isolation, egress restrictions, cross-user data controls, payment state and prompt-injection exposure.
- [ ] Retention/deletion and encrypted backup policy; avoid retaining unnecessary student records or browser sessions. Record actual subprocessor/model data handling accurately.
- [ ] Alert on stale worker heartbeat, queue age, paused tasks, failed webhooks, database errors and unusual model/browser consumption. Do not log student credentials, raw frames or authenticated URLs.
- [ ] Capacity/load testing and cost measurement before advertising scale. Single worker is the default; live-browser multi-host affinity is not implemented.

## What repository tests establish

Automated native tests use synthetic school, Stripe, Supabase and model responses. They validate logic and failure handling; they do not establish real OAuth approval, successful provider billing, a real database migration, production sandbox compatibility or universal Canvas coverage. Frontend/DOM fixture tests may use local Chromium; those are not real school interactions. Record the actual local results in `VALIDATION.md`.

**Do not describe the service as fully live or production-verified until the configured live acceptance checks above pass.**
