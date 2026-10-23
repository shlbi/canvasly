import { AppError, requireValue } from '../security.mjs';
import { Model } from '../agent.mjs';

/** Choose the server-funded model; no student ChatGPT token or hidden subscription fallback is used. */
export function modelName() { return process.env.OPENAI_MODEL || 'gpt-4.1-mini'; }

/** Extract only user-visible text from a completed Responses result. */
export function responseText(response) { return (response.output || []).flatMap(/* Ignore reasoning/tool metadata in the visible answer. */ item => item.content || []).filter(/* Only final output text is rendered. */ item => item.type === 'output_text').map(/* Keep the provider's text, not arbitrary JSON fields. */ item => item.text).join('\n'); }

/** Meter a normal tool-using model request before execution and persist real returned token usage. */
export async function callModel(store, userId, jobId, body, fetchImpl = fetch) {
  const callId = await store.reserveModel(userId, jobId);
  const response = await fetchImpl('https://api.openai.com/v1/responses', { method: 'POST', headers: { Authorization: `Bearer ${requireValue('OPENAI_API_KEY')}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ ...body, model: modelName(), store: false, stream: false }), redirect: 'error', signal: AbortSignal.timeout(90000) });
  if (!response.ok) throw new AppError(response.status === 429 ? 'AI provider usage or rate limit reached. The task is paused.' : 'The AI request failed. The task is paused; no output was marked complete.', 502);
  const result = await response.json();
  if (result.status !== 'completed') throw new AppError('The AI response was incomplete. Partial work was not marked finished.', 502);
  await store.finishModel(callId, result.usage);
  return result;
}

/** Reuse the schema-validated planning/writing/review engine with our API credentials and usage ledger. */
export async function draftStep(store, userId, jobId, phase, draft, fetchImpl = fetch) {
  const callId = await store.reserveModel(userId, jobId);
  const model = new Model(fetchImpl, { access_token: requireValue('OPENAI_API_KEY'), model: modelName() });
  const result = await model.run(phase, draft);
  await store.finishModel(callId, result.usage);
  return result.result;
}
