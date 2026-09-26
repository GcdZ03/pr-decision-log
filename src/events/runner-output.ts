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
