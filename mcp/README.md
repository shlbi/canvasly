# Canvas Unlocked MCP v0.2

**Canvas coursework agent toolkit:** read course materials, gather rubrics, draft complete text/code deliverables, review drafts with an AI model, stage them, and submit supported assignment types **only after an explicit local approval**.

This project is experimental, unaffiliated with Instructure or any university, and is intended for authorized coursework assistance. It does not bypass proctoring, access controls, course locks, or institution restrictions. Check your institution's AI and academic integrity policies before using generated work in graded submissions.

## Two ways to run agents

**1. MCP host-driven (uses your existing MCP client's model):** Connect this MCP server to a client such as an MCP-capable development assistant. The client can read Canvas content, plan, generate work, and call `canvas_stage_text_entry`, `canvas_stage_upload` or `canvas_stage_url` to stage the finished draft. This path does **not** require an API key for a second model. The MCP host must itself support connecting to a local stdio server.

**2. Standalone draft runner (requires a model API key):** The built-in CLI and `canvas_auto_draft` tool call an OpenAI-compatible Chat Completions endpoint to generate a draft and call the model in planning, generation, and independent review passes (with one optional revision) to critique it against the assignment/rubric. Each model call may cost money (normally 3 calls, up to 5 if revised). A ChatGPT app subscription does not automatically supply API credits.

**Neither path silently turns in assignments.** Staged work must be inspected and locally approved before `submit` can execute. Approving and submitting are intentionally not exposed as MCP tools.

## Capabilities

| Area | MCP tools or command | Status |
| --- | --- | --- |
| Courses/deadlines | `canvas_courses`, `canvas_course`, `canvas_assignments`, `canvas_semester_radar`, `canvas_todo`, `canvas_upcoming` | Built (read only) |
| Course materials | `canvas_assignment_packet`, `canvas_modules`, `canvas_module_items`, `canvas_page`, `canvas_announcements`, `canvas_whoami` | Built (read only) |
| AI-generated drafts (plan + worker + reviewer) | `canvas_auto_draft`; `npm run agent -- draft ...` | Built (requires model API) |
| Multiple assignments | `npm run agent -- batch <course_id> [limit]` | Built (max 5, drafts only) |
| Bring your own agent | `canvas_stage_text_entry`, `canvas_stage_upload`, `canvas_stage_url` | Built (stage only) |
| Draft queue | `canvas_draft_queue`, `canvas_draft_preview`; `npm run agent -- list` | Built |
| Approve/submit | `npm run agent -- approve <draft_id>`; `npm run agent -- submit <draft_id>` | Built, local user action required |
| PDFs/Office attachments, code execution, LMS discussions, New Quizzes, proctored exams | Not supported by this version | Not built |

The draft runner works best for standard text assignments and text-based code/file submissions. It can produce `.py`, `.js`, `.md`, `.txt`, etc. It **does not** execute generated code, guarantee factual accuracy, package actual binary PDFs, or read every document linked from Canvas. A review result is model opinion, not proof of correctness.

## Requirements

- Node.js 20+ (Node.js 22 recommended)
- A Canvas URL and a token for an account **you are authorized to use**. If your school blocks API tokens, use its approved integration process instead.
- Network access to npm, your school's Canvas domain, and optionally an AI model API.

## Installation

1. Extract this project and open a terminal within it.
2. Run:

```bash
npm install
npm test
```

3. Copy `.env.example` to `.env` in the project root. On Windows PowerShell:

```powershell
Copy-Item .env.example .env
```

4. Fill in your school Canvas origin and *private* Canvas API token in `.env`:

```dotenv
CANVAS_BASE_URL=https://school.instructure.com
CANVAS_API_TOKEN=your-private-token
```

Canvas token creation, **where enabled by the school**, may be found under Canvas Profile → Settings → Approved Integrations → New Access Token. Never put tokens in prompts, uploads, screenshots, GitHub, or public projects.

For the optional built-in autonomous drafting runner add:

```dotenv
OPENAI_API_KEY=your-provider-api-key
AI_MODEL=gpt-4o-mini
AI_API_BASE_URL=https://api.openai.com/v1
```

Use a model that supports an OpenAI-compatible `/chat/completions` API and reliably returns JSON text. AI_API_BASE_URL may point to an approved compatible provider. `.env` stays local and is git-ignored.

## MCP connection

This project uses the [MCP TypeScript Server SDK v2](https://ts.sdk.modelcontextprotocol.io/v2/) and a local stdio transport. Here is a generic MCP client configuration; adjust to your client's format:

```json
{
  "mcpServers": {
    "canvas-unlocked": {
      "command": "node",
      "args": ["C:/path/to/canvas-unlocked-mcp/src/index.mjs"],
      "env": {
        "CANVAS_BASE_URL": "https://school.instructure.com",
        "CANVAS_API_TOKEN": "YOUR_LOCAL_TOKEN"
      }
    }
  }
}
```

**Important:** The config works when the client supports local stdio MCP, but it does not create a remote ChatGPT connector. For a production web/remote MCP service, implement Streamable HTTP transport, institution-approved OAuth2, multi-user auth and secure secret management. The existing `.env` loader reads a file from the server's **current working directory**; if your MCP client launches outside the project directory, set credentials through the `env` configuration above instead.

### Example agent prompt (MCP-host driven)

> Inspect `canvas_semester_radar` for the next 14 days. For each open assignment I specify, read its `canvas_assignment_packet` and rubric, produce the required text or source files, check your work against every requirement, and stage a draft using the corresponding `canvas_stage_*` tool. Do not claim to have tested code that you have not run. Show me the remaining uncertainties and the draft IDs. Do not submit anything.

### Standalone runner commands

Generate and review one draft (replace IDs with those reported by Canvas):

```bash
npm run agent -- draft 12345 67890
```

Draft up to three open unsubmitted assignments in a course (3–5 model calls per assignment):

```bash
npm run agent -- batch 12345 3
```

Read the queue and **full** draft content:

```bash
npm run agent -- list
npm run agent -- show <draft_id>
```

Approve a particular draft from an **interactive terminal**. This prints the draft and asks you to type the exact confirmation text; it won't work in a noninteractive script:

```bash
npm run agent -- approve <draft_id>
```

Then execute the approved submission:

```bash
npm run agent -- submit <draft_id>
```

The CLI retrieves the live assignment again before submitting, checks that the type is still accepted and the assignment is not locked, and checks an approval digest. It stores a record in `.canvas-unlocked/queue/`. If a network problem happens after a submission request, the item becomes `needs_manual_check` rather than blindly retrying: inspect the Canvas website to avoid accidental duplicate submissions.

### Supported Canvas write types

- `online_text_entry` → submit HTML content via Canvas submissions endpoint.
- `online_url` → submit a **real** HTTP(S) URL, not a fabricated model output.
- `online_upload` → initiate per-file upload, upload via Canvas-provided destination without forwarding your bearer token, then submit returned file IDs.

The assignment must accept that submission type. Other submission modes need separate connectors or manual work.

## Architecture

```text
Canvas REST API
    │
    ▼
11 read-only MCP tools ──► assignment packet, rubric, materials
    │
    ├──► MCP client agent builds content ──► stage_* tools
    │
    └──► optional planner + worker + reviewer loop ──► auto_draft
                                            │
                                     local draft queue
                                            │
                                local explicit user approval
                                            │
                               Canvas submission API (CLI only)
```

Security features: restricted Canvas origin and API paths, no cross-origin authenticated pagination, no model access to Canvas credentials, writable functions restricted to typed submission operations, no auto-finalization tools exposed to MCP clients, approval bound to deliverable hash, local files ignored by git, basic filename and size checks. Course text is untrusted. For production, add OAuth, stronger API hardening, robust malicious-content defenses, user isolation, full audit logs, consent, and document extraction.

## Current testing status

- Automated Node.js tests cover origin controls, course context, semester radar, model drafting, explicit approvals, text and file submission requests, token isolation, and retry states.
- Canvas and AI-model requests were tested with **mocked** responses; there has been **no successful live university login or submission**.
- The complete MCP SDK handshake remains unverified in this execution environment if npm dependencies cannot be installed; run `npm install` and try `canvas_whoami` on your computer to validate your setup.

Official API references: [Canvas assignment submissions](https://developerdocs.instructure.com/services/canvas/resources/submissions), [Canvas file upload flow](https://developerdocs.instructure.com/services/canvas/basics/file.file_uploads), [MCP SDK](https://ts.sdk.modelcontextprotocol.io/v2/).
