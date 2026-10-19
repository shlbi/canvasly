# v2 verification record

Date: 2026-10-18. Source baseline: `shlbi/canvasly` commit `b9eafa0128f7f62b7de45db43f8f8b2e81f6c0cc`.

## Evidence

`npm run check`: syntax/configuration valid; **75/75 tests passed**, none skipped. Of these, 43 are legacy regressions and 32 specifically exercise the v2 paths.

The v2 integration suite substitutes Canvas and OpenAI HTTP responses and signed identity fixtures. It covers a saved local browser account, Canvas sync, queued planning/writing/review, changed-draft review invalidation and a confirmed text submission. No university or real OpenAI account was accessed.

A separate test spawns the real stdio MCP bridge, completes initialization/tool discovery, calls its tool over a real local HTTP server and reads the same student profile held by the website backend. This validates the adapter, not compatibility with every third-party MCP client or a hosted ChatGPT plugin.

Chromium source-rendering harness: desktop 1440px and mobile 390px. Checked initial agent view, plan view, recurring-commitment creation, profile save, illustrative delegation, draft editing/review invalidation, and explicitly illustrative chat. No JavaScript errors; no mobile horizontal overflow. The harness substitutes only startup configuration/auth state, inlines the project's real JS/CSS, and provides secure-context `crypto.randomUUID` because its document origin is `about:blank`. Example-agent replies remain clearly labeled as examples.

Browser navigations were blocked by the environment. Full browser → live OAuth → real database → real model → real Canvas was **not tested**. Screenshots are actual rendered project source, not generated concept art.

## Still requiring external validation

- Live eligible ChatGPT local authorization, or approved hosted client and plan-usage grants.
- Institution-enabled Canvas developer keys and authorized test account.
- Hosted database migration and permission checks against a real Supabase project.
- A deployed, scheduled worker with monitoring and interruption recovery exercises.
- External-client MCP interoperation and separately authenticated remote MCP work.
- Security, accessibility and load audits; approved branding assets for public sign-in.

## Operational limitations

Native OIDC validation and a private-beta JSON-record store are not a substitute for a security audit. Local data is not fully encrypted; server secret/key rotation needs a migration policy. Idle pre-login state/usage records require an operational cleanup policy. Hosted worker account scanning is bounded and process-local fairness is not a global scheduling guarantee. No code execution sandbox or external homework platform integration exists.

No Vercel deployment or scheduled task was created by this revision.
