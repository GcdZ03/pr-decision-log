export type CommandKind = 'test' | 'build' | 'lint' | 'git' | 'other';

import { commandSegments, runsKind, RUNNER_KINDS } from './command-text.ts';

// Ordered: the first matching kind wins. `test` precedes `build` deliberately —
// in `npm run build && npm test` the test outcome is what a reviewer needs.
const PATTERNS: ReadonlyArray<readonly [CommandKind, RegExp]> = [
  ['test', RUNNER_KINDS.test],
  ['lint', RUNNER_KINDS.lint],
  ['build', RUNNER_KINDS.build],
  ['git', /\bgit\s+\w|\bgh\s+\w/],
];

/**
 * Classify a shell command for the verification timeline.
 *
 * Commands in real sessions are frequently multi-line scripts, so every
 * command in the script is considered and the strongest signal wins. Heredoc
 * bodies and quoted strings are not commands and are never read: a script
 * that writes a Dockerfile containing `RUN npm test` did not run the tests.
 */
export function classifyCommand(command: string): CommandKind {
  const segments = commandSegments(command);
  for (const [kind, re] of PATTERNS) {
    if (segments.some((l) => runsKind(l, re))) return kind;
  }
  return 'other';
}
