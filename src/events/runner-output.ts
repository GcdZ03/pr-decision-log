/**
 * Summary lines that carry a failure count, one per runner. When one is
 * present it is authoritative: `fail 0` next to a test *named* "handles
 * failure" is a pass.
 */
const COUNTED: RegExp[] = [
  /^ℹ fail (\d+)/m, // node:test
  /^# fail (\d+)/m, // TAP
  /\bTests?:?\s+(\d+) failed/, // jest, vitest
  /^\s*(\d+) failing\b/m, // mocha
  /=+ .*?\b(\d+) failed\b/, // pytest
  /\bwith (\d+) failures?\b/, // XCTest
];

/**
 * Failure markers for when no summary survived, typically because the agent
 * piped the run through `tail` and cut it off. Only consulted as a fallback.
 */
const MARKERS: RegExp[] = [
  /^--- FAIL:/m, // go
  /^FAIL\s/m, // go package line, jest file line
  /test result: FAILED/, // cargo
  /Test Suite '.*' failed/, // XCTest
  /^✘ Test run with .* failed/m, // Swift Testing
  /\bERR_ASSERTION\b|\bAssertionError\b/, // node, python
  /^not ok \d+/m, // TAP
  /^\s*✖ /m, // node:test failing test
];

export function outputShowsFailure(output: string): boolean {
  let sawSummary = false;
  for (const re of COUNTED) {
    for (const m of output.matchAll(new RegExp(re.source, `${re.flags}g`))) {
      sawSummary = true;
      if (Number(m[1]) > 0) return true;
    }
  }
  if (sawSummary) return false;
  return MARKERS.some((re) => re.test(output));
}

/**
 * Whether a command's exit status may not be the test runner's.
 *
 * A pipeline exits with its last command's status, so `npm test | tail` is 0
 * even when tests fail; `|| true` and `; echo` do the same. Only then is the
 * output consulted. An unpiped run keeps trusting its exit code, so a passing
 * suite that merely prints the word "AssertionError" is not misread.
 */
export function exitStatusMaskable(command: string): boolean {
  return /[|;]/.test(command);
}

/** A failing test as a runner reports it: its file when the runner says, and its name. */
export type FailingTest = { file?: string; name: string };

/**
 * Per-runner lines that name one failing test. Line-anchored and specific:
 * these are the only parts of a test run's output that may reach a log, and
 * they hold code identifiers that the PR's own diff already shows.
 */
const FAILING_TEST_LINES: { re: RegExp; read: (m: RegExpMatchArray) => FailingTest }[] = [
  // pytest: FAILED path.py::Class::test_name[param] - message
  { re: /^(?:FAILED|ERROR) (\S+?\.py)::(\S+?)(?:\[[^\]\n]*\])?(?:\s+-\s.*)?$/gm, read: (m) => ({ file: m[1]!, name: m[2]! }) },
  // go: --- FAIL: TestName (0.00s)
  { re: /^\s*--- FAIL: (\S+)/gm, read: (m) => ({ name: m[1]! }) },
  // vitest: FAIL  path.test.ts > suite > test
  { re: /^\s*(?:FAIL|×)\s+(\S+\.[cm]?[tj]sx?)\s+>\s+(.+?)\s*$/gm, read: (m) => ({ file: m[1]!, name: m[2]! }) },
  // jest: ● suite › test
  { re: /^\s*● (.+?)\s*$/gm, read: (m) => ({ name: m[1]! }) },
  // node:test: ✖ test name (1.2ms)
  { re: /^\s*✖ (.+?) \(\d+(?:\.\d+)?m?s\)\s*$/gm, read: (m) => ({ name: m[1]! }) },
];

const MAX_NAME = 100;
const MAX_TESTS = 20;

/** The tests a failing run names, in output order, each once. */
export function failingTests(output: string): FailingTest[] {
  const found: { at: number; test: FailingTest }[] = [];
  for (const { re, read } of FAILING_TEST_LINES) {
    for (const m of output.matchAll(re)) {
      const t = read(m);
      const name = t.name.length > MAX_NAME ? `${t.name.slice(0, MAX_NAME - 1)}…` : t.name;
      found.push({ at: m.index, test: { ...(t.file ? { file: t.file } : {}), name } });
    }
  }
  const out: FailingTest[] = [];
  for (const { test } of found.sort((a, b) => a.at - b.at)) {
    if (out.length >= MAX_TESTS) break;
    if (!out.some((t) => t.name === test.name && t.file === test.file)) out.push(test);
  }
  return out;
}
