/**
 * Rough cross-language assertion matcher, deliberately shallow (DESIGN section
 * 11): where precision matters for one language, delegate to assert-diff or
 * Swarm Orchestrator rather than growing this into a parser.
 *
 * The Python forms are line-anchored. A bare `assert` statement is only an
 * assertion at the start of a line; the same word inside a JavaScript comment
 * is prose.
 */
const ASSERT_RE =
  /\b(?:expect\(|assert[._(]|assert[A-Z_]\w*\(|XCTAssert\w*|require\.\w+|t\.(?:Error|Fatal)\w*|Assert\.\w+)|^[ \t]*assert\s/gm;

const STRING_RE = /(["'`])(?:\\.|(?!\1).)*\1/g;

/**
 * Empty every single-line string literal, keeping its quotes.
 *
 * Test files are full of code quoted as data: fixtures, snapshots, this very
 * repository's own tests. Matching inside those strings flagged fixture text
 * as real skips and real assertion removals the first time the analyser ran
 * on its own branch. Keeping the quotes means `expect('bob')` still reads as
 * an assertion; only the contents are ignored.
 */
export function blankStrings(s: string): string {
  return s.replace(STRING_RE, (m) => `${m[0]}${m[0]}`);
}

export function countAssertions(s: unknown): number {
  if (typeof s !== 'string') return 0;
  return (blankStrings(s).match(ASSERT_RE) ?? []).length;
}
