import { dirname, isAbsolute } from 'node:path';
import type { TimelineEvent } from './types.ts';

/**
 * The timeline with every shell write as an edit event, placed just before
 * the command that made it: in `cat > a.test.ts <<EOF ... EOF && pnpm test`
 * the file is written before the tests run. Done when a log is built, so the
 * store keeps one event per tool call.
 */
export function expandWrites(events: TimelineEvent[]): TimelineEvent[] {
  return events.flatMap((e): TimelineEvent[] => {
    if (e.kind !== 'command' || !e.writes?.length) return [e];
    const edits: TimelineEvent[] = e.writes.map((w, i) => ({
      kind: 'edit',
      id: `${e.id}#write${i}`,
      at: e.at,
      path: w.path,
      via: 'shell',
      ...(isAbsolute(w.path) ? { dir: dirname(w.path) } : {}),
      ...(w.append ? { additive: true as const } : {}),
      ...(w.assertionsAfter !== undefined ? { assertionsAfter: w.assertionsAfter } : {}),
    }));
    return [...edits, e];
  });
}
