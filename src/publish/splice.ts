import { createHash } from 'node:crypto';
import { MARKER_END } from '../render/render.ts';

const BLOCK = /<!-- pdl:start[\s\S]*?<!-- pdl:end -->/;

/**
 * Insert or replace the log block in a PR body.
 *
 * Idempotent by content hash: republishing unchanged content is a true no-op,
 * so pushing three times does not produce three edits. The body is never
 * interpolated into a shell (DESIGN principle 6); it travels to `gh` on stdin.
 */
/** The content hash stamped into a published section, and used to skip unchanged publishes. */
export function sectionHash(section: string): string {
  return createHash('sha256').update(section).digest('hex').slice(0, 12);
}

export function splice(body: string | null | undefined, section: string): { body: string; changed: boolean } {
  const existing = body ?? '';
  const hash = sectionHash(section);
  const stamped = section.replace(MARKER_END, `<!-- pdl:hash=${hash} -->\n${MARKER_END}`);

  const current = BLOCK.exec(existing);
  if (current) {
    if (current[0].includes(`pdl:hash=${hash}`)) return { body: existing, changed: false };
    return { body: existing.replace(BLOCK, stamped), changed: true };
  }

  const prefix = existing.trim() ? `${existing.trimEnd()}\n\n` : '';
  return { body: prefix + stamped, changed: true };
}
