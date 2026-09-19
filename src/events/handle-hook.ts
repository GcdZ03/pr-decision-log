import { normalize } from './normalize.ts';
import type { EventStore } from './store.ts';

/**
 * Record one hook payload.
 *
 * Fail-open by contract: a hook that throws would surface as a non-blocking
 * error in the agent's loop, and a logging tool has no business doing that.
 * Every failure here is swallowed deliberately.
 */
export function handleHook(
  store: EventStore,
  payload: Record<string, unknown>,
  recordedAt: string = new Date().toISOString(),
): void {
  try {
    const sessionId = typeof payload['session_id'] === 'string' ? payload['session_id'] : '';
    if (!sessionId) return;

    const event = normalize(payload, recordedAt);
    if (!event) return;

    store.append(sessionId, event);
  } catch {
    // Never propagate. See DESIGN principle 2 (fail open, never block).
  }
}
