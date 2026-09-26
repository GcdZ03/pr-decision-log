import { test } from 'node:test';
import assert from 'node:assert/strict';
import { outputShowsFailure, exitStatusMaskable } from '../src/events/runner-output.ts';

// Summaries from each runner, failing and passing. Zero counts must not read as failures.
const CASES: [string, string, boolean][] = [
  ['node:test fail', 'ℹ tests 2\nℹ pass 1\nℹ fail 1', true],
  ['node:test pass', 'ℹ tests 2\nℹ pass 2\nℹ fail 0', false],
  ['TAP fail', '# tests 2\n# pass 1\n# fail 1', true],
  ['jest fail', 'Tests:       1 failed, 3 passed, 4 total', true],
  ['jest pass', 'Tests:       4 passed, 4 total', false],
  ['vitest fail', ' Test Files  1 failed (1)\n      Tests  1 failed | 2 passed (3)', true],
  ['mocha fail', '  3 passing (12ms)\n  2 failing', true],
  ['mocha pass', '  3 passing (12ms)', false],
  ['pytest fail', '========= 1 failed, 2 passed in 0.12s =========', true],
  ['pytest pass', '========= 3 passed in 0.10s =========', false],
  ['go fail', '--- FAIL: TestSum (0.00s)\nFAIL\texample.com/sum\t0.1s', true],
  ['go pass', 'ok  \texample.com/sum\t0.1s', false],
  ['cargo fail', 'test result: FAILED. 1 passed; 1 failed; 0 ignored', true],
  ['cargo pass', 'test result: ok. 2 passed; 0 failed; 0 ignored', false],
  ['XCTest fail', "Test Suite 'All tests' failed at 2026-09-26.\n\t Executed 3 tests, with 1 failure (0 unexpected)", true],
  ['XCTest pass', "Test Suite 'All tests' passed at 2026-09-26.\n\t Executed 3 tests, with 0 failures (0 unexpected)", false],
  ['Swift Testing fail', '✘ Test run with 3 tests failed after 0.01 seconds with 1 issue.', true],
  ['Swift Testing pass', '✔ Test run with 3 tests passed after 0.01 seconds.', false],
];

for (const [name, output, fails] of CASES) {
  test(`${name}: ${fails ? 'reads as a failure' : 'reads as a pass'}`, () => {
    assert.equal(outputShowsFailure(output), fails);
  });
}

test('a tail that cut off the summary still shows a failure from the assertion error', () => {
  // The real output from a piped `npm test | tail -12`: stack trace only.
  const output = [
    '      at Test.run (node:internal/test_runner/test:1382:25)',
    '    generatedMessage: true,',
    "    code: 'ERR_ASSERTION',",
    '    actual: 4,',
    '    expected: 3,',
  ].join('\n');

  assert.equal(outputShowsFailure(output), true);
});

test('a passing test whose name mentions failure is not a failure', () => {
  assert.equal(outputShowsFailure('✔ handles failure paths (1.2ms)\n✔ reports failed uploads (0.4ms)\nℹ fail 0'), false);
});

test('empty output is not a failure', () => {
  assert.equal(outputShowsFailure(''), false);
});

test('a pipe makes the exit status unreliable', () => {
  assert.equal(exitStatusMaskable('npm test 2>&1 | tail -30'), true);
});

test('an or-true makes the exit status unreliable', () => {
  assert.equal(exitStatusMaskable('npm test || true'), true);
});

test('a plain run keeps a reliable exit status', () => {
  assert.equal(exitStatusMaskable('npm test'), false);
  assert.equal(exitStatusMaskable('npm test && echo done'), false);
});

test('a trailing command after a semicolon makes the exit status unreliable', () => {
  assert.equal(exitStatusMaskable('npm test; echo done'), true);
});
