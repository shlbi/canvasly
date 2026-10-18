#!/usr/bin/env node
import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { CanvasClient } from './canvas.mjs';
import { DraftQueue, CourseworkModel, autoDraft, draftPreview } from './workflow.mjs';
import { loadLocalEnv } from './env.mjs';

loadLocalEnv();
const queue = new DraftQueue();
const usage = `Usage:
  npm run agent -- list
  npm run agent -- show <draft_id>
  npm run agent -- draft <course_id> <assignment_id>
  npm run agent -- batch <course_id> [limit=3]
  npm run agent -- approve <draft_id>  (requires interactive human approval)
  npm run agent -- submit <draft_id>   (requires an approved draft)

AI_API_KEY/OPENAI_API_KEY needed only for draft and batch.\n`;
const args = process.argv.slice(2);
const print = obj => console.log(JSON.stringify(obj, null, 2));
function cid(s) { const n = Number(s); if (!Number.isSafeInteger(n) || n <= 0) throw new Error('Expected positive integer ID'); return n; }
function getCanvas() { return new CanvasClient({ baseUrl: process.env.CANVAS_BASE_URL, token: process.env.CANVAS_API_TOKEN }); }
async function main() {
  const action = args[0];
  if (action === 'list') return print(await queue.list());
  if (action === 'show') {
    if (!args[1]) throw new Error('Need draft ID');
    const record = await queue.get(args[1]);
    return print({ ...queue.summary(record), preview: draftPreview(record), approved_at: record.approved_at, submission: record.canvas_submission, error: record.error });
  }
  if (action === 'draft') {
    if (!args[1] || !args[2]) throw new Error('Need course ID and assignment ID');
    return print(await autoDraft(getCanvas(), queue, new CourseworkModel(), cid(args[1]), cid(args[2])));
  }
  if (action === 'batch') {
    const course = cid(args[1]);
    const limit = args[2] ? cid(args[2]) : 3;
    if (limit > 5) throw new Error('Batch limit max 5 to control model costs');
    const canvas = getCanvas(), model = new CourseworkModel();
    const existing = await queue.list();
    const assignments = (await canvas.listAssignments(course))
      .filter(a => a.submission_types?.some(t => ['online_text_entry', 'online_upload', 'online_url'].includes(t)))
      .filter(a => !a.submission?.submitted_at && !a.has_submitted_submissions)
      .filter(a => !a.lock_at || Date.parse(a.lock_at) > Date.now())
      .filter(a => !a.unlock_at || Date.parse(a.unlock_at) <= Date.now())
      .filter(a => !existing.some(d => d.course_id === course && d.assignment_id === a.id && d.status !== 'needs_manual_check'))
      .sort((a,b) => Date.parse(a.due_at || '9999-12-31') - Date.parse(b.due_at || '9999-12-31'))
      .slice(0, limit);
    const results = [];
    for (const a of assignments) {
      try { results.push({ assignment: a.name, result: await autoDraft(canvas, queue, model, course, a.id) }); }
      catch (err) { results.push({ assignment: a.name, error: err.message }); }
    }
    return print(results);
  }
  if (action === 'approve') {
    if (!args[1]) throw new Error('Need draft ID');
    if (!input.isTTY) throw new Error('Human approval must run in an interactive terminal');
    const record = await queue.get(args[1]);
    console.log(JSON.stringify({ ...queue.summary(record), preview: draftPreview(record) }, null, 2));
    const phrase = `APPROVE ${record.assignment_id} ${record.id.slice(0, 8)}`;
    const rl = createInterface({ input, output });
    let entered;
    try { entered = await rl.question(`\nTo authorize this exact deliverable, type: ${phrase}\n> `); }
    finally { rl.close(); }
    return print(await queue.approve(record.id, entered));
  }
  if (action === 'submit') {
    if (!args[1]) throw new Error('Need draft ID');
    return print(await queue.submit(getCanvas(), args[1]));
  }
  console.log(usage);
  if (action && action !== '--help' && action !== '-h') process.exitCode = 1;
}
main().catch(err => { console.error(`Error: ${err.message}`); process.exitCode = 1; });
