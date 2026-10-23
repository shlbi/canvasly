import { AppError, requireValue } from '../security.mjs';
import { serviceOrigin } from './config.mjs';

/** Call the private worker API as the verified app account; caller-provided user IDs are never forwarded. */
export async function workerCall(userId, op, input = {}, fetchImpl = fetch) {
  const response = await fetchImpl(`${serviceOrigin('WORKER_URL')}/command`, { method: 'POST', headers: { Authorization: `Bearer ${requireValue('WORKER_SECRET')}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ user_id: userId, op, input }), signal: AbortSignal.timeout(50000), redirect: 'error' });
  const result = await response.json();
  if (!response.ok) throw new AppError(result.error || 'The cloud worker could not complete this action.', response.status);
  return result;
}

/** Present read-only browser operations to Vercel/MCP without exposing a Chrome debugging connection. */
export class RemoteBrowser {
  /** Preserve a transport seam for offline integration tests. */
  constructor(fetchImpl = fetch) { this.fetch = fetchImpl; }
  /** Match the Canvas client's packet/snapshot interface for authorized, owner-scoped reads. */
  canvas(userId) {
    return {
      packet: /* Ask the worker for the selected assignment's visible materials. */ (courseId, assignmentId) => workerCall(userId, 'canvas/packet', { course_id: courseId, assignment_id: assignmentId }, this.fetch),
      assignment: /* Read live status without exposing a write tool to this wrapper. */ (courseId, assignmentId) => workerCall(userId, 'canvas/assignment', { course_id: courseId, assignment_id: assignmentId }, this.fetch)
    };
  }
}
