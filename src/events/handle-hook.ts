import { normalize } from './normalize.ts';
import type { EventStore } from './store.ts';
import type { TimelineEvent } from './types.ts';

/**
 * The kill switch. `0`, `false` and the empty string read as "off" to anyone
 * exporting the variable, so only a deliberate value disables recording.
 */
export function isDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = env['PDL_DISABLE'];
  if (v === undefined) return false;
  return !['', '0', 'false'].includes(v.trim().toLowerCase());
}

/**
 * Record one hook payload and return the event it produced, or null when the
 * payload was not something the log records. Callers use the return value to
 * react to what just happened, such as publishing after `gh pr create`.
 *
 * Fail-open by contract: a hook that throws would surface as a non-blocking
 * error in the agent's loop, and a logging tool has no business doing that.
 * Every failure here is swallowed deliberately.
 */
export function handleHook(
  store: EventStore,
  payload: Record<string, unknown>,
  recordedAt: string = new Date().toISOString(),
): TimelineEvent | null {
  try {
    if (isDisabled()) return null;

    const sessionId = typeof payload['session_id'] === 'string' ? payload['session_id'] : '';
    if (!sessionId) return null;

    const event = normalize(payload, recordedAt);
    if (!event) return null;

    store.append(sessionId, event);
    return event;
  } catch {
    // Never propagate. See DESIGN principle 2 (fail open, never block).
    return null;
  }
}
