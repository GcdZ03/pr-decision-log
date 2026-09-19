import type { TimelineEvent } from '../events/types.ts';

/**
 * `gh pr create` at the start of a line, allowing leading whitespace and the
 * usual shell chaining. Anchoring this way is what keeps an `echo` that merely
 * mentions the command from being mistaken for running it — the same class of
 * false positive the test-edit detector hit.
 */
const CREATE_RE = /(?:^|[\n;&|]\s*)\s*gh\s+pr\s+create\b/;

/** Only github.com, so output naming another host can never redirect a publish. */
const PR_URL_RE = /https:\/\/github\.com\/[^\s/]+\/[^\s/]+\/pull\/(\d+)/;

export type PrCreation = { prNumber: number };

/**
 * Recognise a pull request that a session just opened.
 *
 * Detection is post-hoc rather than a `PreToolUse` rewrite of `--body`: two
 * hooks rewriting the same tool input resolve in non-deterministic order, so a
 * user running any other input-rewriting hook would lose their log
 * intermittently, which is close to unreportable. See DESIGN, publish path.
 */
export function detectPrCreation(event: TimelineEvent): PrCreation | null {
  if (event.kind !== 'command') return null;
  if (event.outcome !== 'pass') return null;
  if (!CREATE_RE.test(event.command)) return null;

  const match = PR_URL_RE.exec(event.output ?? '');
  if (!match?.[1]) return null;

  return { prNumber: Number(match[1]) };
}
