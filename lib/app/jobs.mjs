import { randomUUID } from 'node:crypto';
import { AppError, id, bounded, digest, validateDeliverable } from '../security.mjs';

/** Append a durable task; the database trigger wakes a worker in the same transaction. */
export async function enqueue(store, userId, job) {
  const jobId = randomUUID();
  await store.mutate(userId, /* Store no runnable code or credentials in a task payload. */ data => {
    if (data.jobs.filter(/* An operational concurrency guard is not a subscription allowance. */ item => ['queued','running'].includes(item.status)).length >= 10) throw new AppError('Finish or pause some active tasks before adding more.', 429);
    if (job.kind === 'assignment' && data.jobs.some(/* Protect against concurrent duplicate task requests inside the atomic update. */ item => item.kind === 'assignment' && item.course_id === job.course_id && item.assignment_id === job.assignment_id && !['done','cancelled'].includes(item.status))) throw new AppError('This assignment already has an active task. Finish or cancel it first.', 409);
    if (job.kind === 'sync' && data.jobs.some(/* A single queued sync is enough for this account. */ item => item.kind === 'sync' && ['queued','running'].includes(item.status))) throw new AppError('Canvas is already being synced.', 409);
    if (job.connection_key && data.connection?.binding !== job.connection_key) throw new AppError('Canvas connection changed. Refresh before starting.', 409);
    data.jobs.push({ ...job, id: jobId, status: 'queued', attempts: 0, created_at: new Date().toISOString() });
  });
  return { job_id: jobId, status: 'queued' };
}

/** Queue an ordinary or external assignment, binding submission permission to this specific assignment. */
export async function delegate(store, userId, input, allowSubmission = false) {
  await store.requirePaid(userId);
  const courseId = id(input.course_id), assignmentId = id(input.assignment_id);
  const auto = input.submit_when_ready === true;
  if (auto && (!allowSubmission || input.confirmation !== 'SUBMIT')) throw new AppError('Explicitly authorize submission of this assignment before enabling that mode.', 403);
  const row = await store.read(userId);
  if (!row.data.connection) throw new AppError('Connect Canvas before delegating.', 422);
  if (row.data.jobs.some(/* Avoid accidental duplicate tasks for the same assignment. */ job => job.assignment_id === assignmentId && job.course_id === courseId && !['done','cancelled'].includes(job.status))) throw new AppError('This assignment already has an active task.', 409);
  return enqueue(store, userId, { kind: 'assignment', title: 'Reading assignment', course_id: courseId, assignment_id: assignmentId, notes: bounded(input.notes || '', 10000), step: 'fetch', auto_submit: auto, connection_key: row.data.connection.binding });
}

/** Queue a conversation turn while retaining only a bounded recent transcript. */
export async function chat(store, userId, input) {
  await store.requirePaid(userId);
  const text = bounded(input.message || '', 12000).trim();
  if (!text) throw new AppError('Write a message first.');
  const jobId = randomUUID();
  await store.mutate(userId, /* Write the user message and its task atomically. */ data => {
    if (data.jobs.some(/* Avoid racing two conversations over the same student context. */ job => job.kind === 'chat' && ['queued','running'].includes(job.status))) throw new AppError('Wait for the current response or pause it first.', 409);
    data.messages = [...data.messages.slice(-199), { id: randomUUID(), role: 'user', text, at: new Date().toISOString() }];
    data.jobs.push({ id: jobId, kind: 'chat', title: 'Responding to your message', status: 'queued', step: 'respond', allow_delegation: input.allow_delegation === true, attempts: 0, created_at: new Date().toISOString() });
  });
  return { job_id: jobId, status: 'queued' };
}

/** Pause after the current step or resume a safe checkpoint; ambiguous writes are never silently retried. */
export async function controlJob(store, userId, input) {
  await store.mutate(userId, /* Lease owners observe cancel_requested before advancing to another step. */ data => {
    const job = data.jobs.find(/* Scope the requested job to this user's workspace. */ item => item.id === input.id);
    if (!job) throw new AppError('Task not found.', 404);
    if (input.action === 'pause') {
      if (job.status === 'running') job.cancel_requested = true;
      else if (job.status === 'queued') job.status = 'paused';
    } else if (input.action === 'resume') {
      if (job.status !== 'paused') throw new AppError('Only paused tasks can be resumed.', 409);
      if (job.uncertain || job.step === 'submit') throw new AppError('Check the actual submission outcome in Canvas. An uncertain write cannot be replayed automatically.', 409);
      job.status = 'queued'; delete job.error; delete job.cancel_requested; delete job.browser_session_id;
    } else if (input.action === 'cancel') {
      if (job.status === 'running') throw new AppError('Pause and wait for the current step before canceling.', 409);
      job.status = 'cancelled';
    } else throw new AppError('Unknown task action.');
  });
  return { saved: true };
}

/** Persist edits only when no worker owns the draft; invalidate review and any previous auto-submit grant. */
export async function saveDraft(store, userId, input) {
  await store.mutate(userId, /* Content hashes bind approval to saved bytes, not a stale editor. */ data => {
    const draft = data.drafts.find(/* Find the owner's exact saved deliverable. */ item => item.id === input.id);
    if (!draft || draft.version !== input.version || !['ready','written'].includes(draft.stage)) throw new AppError('Refresh this draft before editing.', 409);
    if (data.jobs.some(/* Running or queued steps must not observe a half-edited deliverable. */ job => job.draft_id === draft.id && ['queued','running'].includes(job.status))) throw new AppError('Pause the task before editing its deliverable.', 409);
    draft.deliverable = validateDeliverable(input.deliverable, draft.packet.assignment.submission_types);
    draft.stage = 'written'; draft.review = null; draft.review_hash = null; draft.version++;
    for (const job of data.jobs) if (job.draft_id === draft.id) job.auto_submit = false;
  });
  return { saved: true };
}

/** Queue a new review of saved content; it does not implicitly re-enable automatic submission. */
export async function reviewDraft(store, userId, draftId) {
  await store.requirePaid(userId);
  const draft = (await store.read(userId)).data.drafts.find(/* Read only a draft in this account. */ item => item.id === draftId);
  if (!draft || !['written','ready'].includes(draft.stage)) throw new AppError('Save a complete draft first.');
  return enqueue(store, userId, { kind: 'assignment', title: draft.title, course_id: draft.course_id, assignment_id: draft.assignment_id, draft_id: draft.id, connection_key: draft.connection_key, step: 'review', auto_submit: false });
}

/** Queue a specifically authorized submission without tying execution to an open browser tab. */
export async function submitDraft(store, userId, input) {
  await store.requirePaid(userId);
  const row = await store.read(userId), draft = row.data.drafts.find(/* Match the exact owner-bound draft. */ item => item.id === input.id);
  if (!draft || draft.stage !== 'ready' || input.confirmation !== 'SUBMIT' || input.content_hash !== digest(draft.deliverable) || draft.review_hash !== input.content_hash) throw new AppError('Review the saved draft and type SUBMIT to authorize these exact contents.', 409);
  return enqueue(store, userId, { kind: 'assignment', title: draft.title, course_id: draft.course_id, assignment_id: draft.assignment_id, draft_id: draft.id, connection_key: draft.connection_key, step: 'submit', approved_hash: input.content_hash, auto_submit: true });
}
