import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectTestEditedAfterFailure, summariseCommand } from '../src/flags/test-edited-after-failure.ts';
import type { TimelineEvent } from '../src/flags/test-edited-after-failure.ts';

const cmd = (
  id: string, at: string, command: string, outcome: 'pass' | 'fail' | 'interrupted' | 'unknown', output = '',
): TimelineEvent => ({ kind: 'command', id, at, command, classification: 'test', outcome, output });

const edit = (
  id: string, at: string, path: string, before?: number, after?: number,
): TimelineEvent => ({ kind: 'edit', id, at, path, assertionsBefore: before, assertionsAfter: after });

test('flags a test file edited while a matching failure is unresolved', () => {
  const events: TimelineEvent[] = [
    cmd('c1', '09:30', 'npm test -- sync', 'fail', 'FAIL src/jobs/sync.test.ts\n  expected 2 got 3'),
    edit('e1', '09:35', 'src/jobs/sync.test.ts', 5, 4),
  ];

  const flags = detectTestEditedAfterFailure(events);

  assert.equal(flags.length, 1);
  assert.equal(flags[0]?.file, 'src/jobs/sync.test.ts');
  assert.deepEqual(flags[0]?.evidence, ['c1', 'e1']);
});

test('does not flag once the same command passes again (window closes on green)', () => {
  const events: TimelineEvent[] = [
    cmd('c1', '09:30', 'npm test -- sync', 'fail', 'FAIL src/jobs/sync.test.ts'),
    cmd('c2', '09:41', 'npm test -- sync', 'pass', '12 passed'),
    edit('e1', '09:50', 'src/jobs/sync.test.ts', 4, 6),
  ];

  assert.deepEqual(detectTestEditedAfterFailure(events), []);
});

test('does not flag when the failure output never names the edited file', () => {
  const events: TimelineEvent[] = [
    cmd('c1', '09:30', 'npm test', 'fail', 'FAIL src/auth/login.test.ts\n  expected true'),
    edit('e1', '09:35', 'src/jobs/sync.test.ts', 5, 4),
  ];

  assert.deepEqual(detectTestEditedAfterFailure(events), []);
});

test('matches on basename when output omits the directory', () => {
  const events: TimelineEvent[] = [
    cmd('c1', '09:30', 'npm test', 'fail', 'FAIL sync.test.ts (2 failed)'),
    edit('e1', '09:35', 'src/jobs/sync.test.ts', 5, 4),
  ];

  assert.equal(detectTestEditedAfterFailure(events).length, 1);
});

test('does not flag a purely additive edit (assertions increased)', () => {
  const events: TimelineEvent[] = [
    cmd('c1', '09:30', 'npm test', 'fail', 'FAIL src/jobs/sync.test.ts'),
    edit('e1', '09:35', 'src/jobs/sync.test.ts', 5, 9),
  ];

  assert.deepEqual(detectTestEditedAfterFailure(events), []);
});

test('flags when assertions are removed', () => {
  const events: TimelineEvent[] = [
    cmd('c1', '09:30', 'npm test', 'fail', 'FAIL src/jobs/sync.test.ts'),
    edit('e1', '09:35', 'src/jobs/sync.test.ts', 5, 2),
  ];

  const flags = detectTestEditedAfterFailure(events);
  assert.equal(flags.length, 1);
  assert.match(flags[0]?.detail ?? '', /5 -> 2/);
});

test('flags when assertion counts are unknown (cannot prove it was additive)', () => {
  const events: TimelineEvent[] = [
    cmd('c1', '09:30', 'npm test', 'fail', 'FAIL src/jobs/sync.test.ts'),
    edit('e1', '09:35', 'src/jobs/sync.test.ts'),
  ];

  assert.equal(detectTestEditedAfterFailure(events).length, 1);
});

test('an interrupted run does not open a window', () => {
  const events: TimelineEvent[] = [
    cmd('c1', '09:30', 'npm test', 'interrupted', 'FAIL src/jobs/sync.test.ts\n^C'),
    edit('e1', '09:35', 'src/jobs/sync.test.ts', 5, 4),
  ];

  assert.deepEqual(detectTestEditedAfterFailure(events), []);
});

test('a different command passing does not close the window', () => {
  const events: TimelineEvent[] = [
    cmd('c1', '09:30', 'npm test -- sync', 'fail', 'FAIL src/jobs/sync.test.ts'),
    cmd('c2', '09:33', 'npm run lint', 'pass', 'ok'),
    edit('e1', '09:35', 'src/jobs/sync.test.ts', 5, 4),
  ];

  assert.equal(detectTestEditedAfterFailure(events).length, 1);
});

test('editing the source file under test is normal and is not flagged', () => {
  // The failure output names BOTH files, so name-matching alone would flag
  // this. Fixing the source is the desired behaviour; only the test file is
  // suspicious.
  const events: TimelineEvent[] = [
    cmd('c1', '09:30', 'npm test', 'fail', 'FAIL src/jobs/sync.test.ts\n  at src/jobs/sync.ts:42'),
    edit('e1', '09:35', 'src/jobs/sync.ts', 0, 0),
  ];

  assert.deepEqual(detectTestEditedAfterFailure(events), []);
});

test('repeated edits to one file in one window produce a single flag', () => {
  const events: TimelineEvent[] = [
    cmd('c1', '09:30', 'npm test', 'fail', 'FAIL src/jobs/sync.test.ts'),
    edit('e1', '09:31', 'src/jobs/sync.test.ts', 5, 4),
    edit('e2', '09:32', 'src/jobs/sync.test.ts', 4, 3),
    edit('e3', '09:33', 'src/jobs/sync.test.ts', 3, 2),
  ];

  const flags = detectTestEditedAfterFailure(events);
  assert.equal(flags.length, 1);
  // The span should reflect the whole window, not just the first edit.
  assert.match(flags[0]?.detail ?? '', /5 -> 2/);
});

test('a second failure after a pass opens a new window', () => {
  const events: TimelineEvent[] = [
    cmd('c1', '09:30', 'npm test', 'fail', 'FAIL src/a.test.ts'),
    edit('e1', '09:31', 'src/a.test.ts', 5, 4),
    cmd('c2', '09:35', 'npm test', 'pass', 'ok'),
    cmd('c3', '09:40', 'npm test', 'fail', 'FAIL src/a.test.ts'),
    edit('e2', '09:41', 'src/a.test.ts', 4, 3),
  ];

  assert.equal(detectTestEditedAfterFailure(events).length, 2);
});

test('detail never embeds a raw multi-line command', () => {
  // Real corpus commands include whole shell scripts with heredocs, env vars
  // and absolute paths. DESIGN section 9 forbids rendering those into a PR.
  const script = [
    'cd /Users/someone/Projects/Thing',
    'export API_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123456789',
    'swift test --filter CorePurityTests 2>&1',
  ].join('\n');

  const flags = detectTestEditedAfterFailure([
    cmd('c1', '09:30', script, 'fail', 'FAIL Tests/CoreTests.swift'),
    edit('e1', '09:35', 'Tests/CoreTests.swift', 5, 4),
  ]);

  const detail = flags[0]?.detail ?? '';
  assert.equal(flags.length, 1);
  assert.ok(!detail.includes('\n'), 'detail must be a single line');
  assert.ok(!detail.includes('ghp_'), 'detail must not leak a token from the command');
  assert.ok(detail.length < 300, `detail must stay short, got ${detail.length}`);
});

test('summariseCommand picks the test-runner line out of a shell script', () => {
  const script = [
    'cd /Users/someone/Projects/Thing',
    'SCRATCH=/tmp/x',
    'swift test --filter CorePurityTests 2>&1',
  ].join('\n');

  assert.equal(summariseCommand(script), 'swift test --filter CorePurityTests 2>&1');
});

test('summariseCommand falls back to the first line when no runner is present', () => {
  assert.equal(summariseCommand('make check\nsomething else'), 'make check');
});

test('summariseCommand skips an echo that merely mentions a runner', () => {
  const script = ['echo "--- swift test --filter Core ---"', 'swift test --filter Core'].join('\n');
  assert.equal(summariseCommand(script), 'swift test --filter Core');
});

test('an unchanged assertion count is left out rather than shown as "0 -> 0"', () => {
  // Seen on a real run: the edit touched only the `test(...)` line, so the
  // count covered a fragment with no assertions and read as an empty test.
  const flags = detectTestEditedAfterFailure([
    cmd('c1', '09:00', 'npm test', 'fail', 'FAIL src/a.test.ts'),
    edit('e1', '09:01', 'src/a.test.ts', 0, 0),
    cmd('c2', '09:02', 'npm test', 'pass'),
  ]);

  assert.equal(flags.length, 1);
  assert.ok(!/assertion count/.test(flags[0]?.detail ?? ''), flags[0]?.detail);
});

test('a changed assertion count is still shown', () => {
  const flags = detectTestEditedAfterFailure([
    cmd('c1', '09:00', 'npm test', 'fail', 'FAIL src/a.test.ts'),
    edit('e1', '09:01', 'src/a.test.ts', 2, 1),
    cmd('c2', '09:02', 'npm test', 'pass'),
  ]);

  assert.match(flags[0]?.detail ?? '', /assertion count 2 -> 1/);
});
