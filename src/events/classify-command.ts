export type CommandKind = 'test' | 'build' | 'lint' | 'git' | 'other';

/**
 * Lines that merely mention a runner (banner echoes, comments) are not
 * invocations. Checked before anything else so `echo "npm test"` stays `other`.
 */
const NOT_INVOCATION = /^\s*(#|echo\b|printf\b)/;

// Ordered: the first matching kind wins. `test` precedes `build` deliberately —
// in `npm run build && npm test` the test outcome is what a reviewer needs.
const PATTERNS: ReadonlyArray<readonly [CommandKind, RegExp]> = [
  [
    'test',
    /\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?test\b|\b(?:npm|pnpm|yarn|bun)\s+run\s+test:[\w-]+|\bvitest\b|\bjest\b|\bpytest\b|\bgo\s+test\b|\bswift\s+test\b|\bcargo\s+test\b|\bnode\s+--test\b|\brspec\b|\bphpunit\b|\bdotnet\s+test\b|\bxcodebuild\b[^\n]*\btest\b/,
  ],
  [
    'lint',
    /\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?lint\b|\beslint\b|\bprettier\b|\bruff\b|\bblack\b|\bclippy\b|\bswiftlint\b|\bgolangci-lint\b|\bflake8\b|\bmypy\b/,
  ],
  [
    'build',
    /\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?build\b|\btsc\b|\bcargo\s+build\b|\bgo\s+build\b|\bswift\s+build\b|\bxcodebuild\b|\bmake\b|\bgradle\b|\bmvn\b|\bdocker\s+build\b/,
  ],
  ['git', /\bgit\s+\w|\bgh\s+\w/],
];

/**
 * Classify a shell command for the verification timeline.
 *
 * Commands in real sessions are frequently multi-line scripts, so every line is
 * considered and the strongest signal wins.
 */
export function classifyCommand(command: string): CommandKind {
  const lines = command
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !NOT_INVOCATION.test(l));

  for (const [kind, re] of PATTERNS) {
    if (lines.some((l) => re.test(l))) return kind;
  }
  return 'other';
}
