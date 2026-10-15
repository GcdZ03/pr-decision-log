import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectTestEditedAfterFailure, summariseCommand } from '../src/flags/test-edited-after-failure.ts';
import type { TimelineEvent } from '../src/flags/test-edited-after-failure.ts';
import { expandWrites } from '../src/events/expand-writes.ts';

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

  assert.equal(summariseCommand(script), 'swift test --filter CorePurityTests');
});

test('summariseCommand never publishes a command that ran no runner, only that one ran', () => {
  assert.equal(summariseCommand('sed -i "" s/a/b/ /Users/someone/secret.txt'), '(other command)');
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

  assert.match(flags[0]?.detail ?? '', /Assertion count 2 -> 1/);
});

// Shell writes reach the detector as edit events, expanded from the command
// that made them and placed before it: a write and a test run in one command
// happen in that order.
test('a test file rewritten from the shell after a failure is flagged', () => {
  const fail = cmd('c1', '09:00', 'pnpm test 2>&1 | tail', 'fail', 'FAIL src/a.test.ts');
  const rewrite: TimelineEvent = { kind: 'command', id: 'c2', at: 'T09:05', command: "cat > src/a.test.ts <<'EOF'\n...\nEOF\npnpm test",
    classification: 'test', outcome: 'pass', writes: [{ path: 'src/a.test.ts', assertionsAfter: 1 }] };

  const flags = detectTestEditedAfterFailure(expandWrites([fail, rewrite]));

  assert.equal(flags.length, 1);
  assert.equal(flags[0]?.file, 'src/a.test.ts');
  assert.match(flags[0]?.detail ?? '', /^\`pnpm test\` failed at /);
});

test('an append to a test file after a failure only adds, so it is not flagged', () => {
  const fail = cmd('c1', '09:00', 'pnpm test', 'fail', 'FAIL test/cli.test.ts');
  const append: TimelineEvent = { kind: 'command', id: 'c2', at: 'T09:05', command: 'cat >> test/cli.test.ts <<EOF\nx\nEOF',
    classification: 'other', outcome: 'pass', writes: [{ path: 'test/cli.test.ts', append: true }] };

  assert.deepEqual(detectTestEditedAfterFailure(expandWrites([fail, append, cmd('c3', '09:06', 'pnpm test', 'pass')])), []);
});

test('the window closes when the same runner passes, however its output was piped', () => {
  const flags = detectTestEditedAfterFailure([
    cmd('c1', '09:00', 'pnpm test 2>&1 | tail -20', 'fail', 'FAIL src/a.test.ts'),
    cmd('c2', '09:01', 'pnpm test', 'pass'),
    edit('e1', '09:02', 'src/a.test.ts', 3, 1),
  ]);

  assert.deepEqual(flags, [], 'the edit came after the failure was resolved');
});

test('a failing command that is not a test run neither opens nor closes a window', () => {
  // Seen in a planted run: a GNU-style `sed -i` failed on macOS while
  // rewriting the test, which ended the real window and opened a second one.
  const flags = detectTestEditedAfterFailure(expandWrites([
    cmd('c1', '09:00', 'npm test', 'fail', 'FAIL sum.test.js'),
    { kind: 'command', id: 's1', at: '09:01', command: "sed -i 's/3/4/' sum.test.js", classification: 'other', outcome: 'fail',
      output: 'sed: 1: "sum.test.js": unterminated substitute pattern', writes: [{ path: 'sum.test.js' }] },
    { kind: 'command', id: 's2', at: '09:02', command: "sed -i '' 's/3/4/' sum.test.js", classification: 'other', outcome: 'pass',
      writes: [{ path: 'sum.test.js' }] },
    cmd('c2', '09:03', 'npm test', 'pass'),
  ]));

  assert.equal(flags.length, 1, JSON.stringify(flags));
  assert.match(flags[0]?.detail ?? '', /^\`npm test\` failed at /);
});

test('the flag says what failed, how and how soon the test changed, and when it passed', () => {
  const flags = detectTestEditedAfterFailure(expandWrites([
    { kind: 'command', id: 'c1', at: '2026-10-03T06:18:32.200Z', command: 'uv run pytest tests/test_p.py -q', classification: 'test', outcome: 'fail', output: 'FAILED tests/test_p.py::t' },
    { kind: 'command', id: 'w1', at: '2026-10-03T06:18:40.247Z', command: "python3 - <<'EOF'\nx\nEOF", classification: 'other', outcome: 'pass', writes: [{ path: 'tests/test_p.py' }] },
    { kind: 'command', id: 'c2', at: '2026-10-03T06:19:52.000Z', command: 'uv run pytest tests/test_p.py -q', classification: 'test', outcome: 'pass' },
  ]));

  assert.equal(flags[0]?.detail, '`uv run pytest tests/test_p.py -q` failed at 06:18; the test was written from the shell 8 s later; it passed at 06:19.');
});

test('several edits are counted, and a failure that never passed says so', () => {
  const flags = detectTestEditedAfterFailure([
    cmd('c1', '2026-10-03T09:00:00Z', 'npm test', 'fail', 'FAIL src/a.test.ts'),
    edit('e1', '2026-10-03T09:02:00Z', 'src/a.test.ts', 3, 2),
    edit('e2', '2026-10-03T09:05:00Z', 'src/a.test.ts', 2, 1),
  ]);

  assert.equal(flags[0]?.detail, '`npm test` failed at 09:00; the test was changed 2 times with the Edit tool, first 2 min later; it has not passed since. Assertion count 3 -> 1.');
});

// Seen on a real PR: the same check failed, the test was rewritten, it failed
// again, the test was rewritten again, and it passed. Two windows produced two
// bullets, and the first claimed "it has not passed since", which was false.
const RUN = 'uv run pytest -q tests/test_import_validate.py';
const fail = (id: string, at: string, command = RUN) =>
  ({ kind: 'command' as const, id, at, command, classification: 'test' as const, outcome: 'fail' as const, output: 'FAILED tests/test_import_validate.py::t' });
const pass = (id: string, at: string, command = RUN) =>
  ({ kind: 'command' as const, id, at, command, classification: 'test' as const, outcome: 'pass' as const });
const shellWrite = (id: string, at: string) =>
  ({ kind: 'command' as const, id, at, command: "python3 - <<'EOF'\nx\nEOF", classification: 'other' as const, outcome: 'pass' as const, writes: [{ path: 'tests/test_import_validate.py' }] });

test('a check that fails again before it passes is one episode, said truthfully', () => {
  const flags = detectTestEditedAfterFailure(expandWrites([
    fail('c1', '2026-10-15T03:10:00Z'),
    shellWrite('w1', '2026-10-15T03:12:00Z'),
    fail('c2', '2026-10-15T03:12:10Z'),
    shellWrite('w2', '2026-10-15T03:12:20Z'),
    pass('c3', '2026-10-15T03:12:40Z'),
  ]));

  assert.equal(flags.length, 1, JSON.stringify(flags));
  assert.equal(flags[0]?.detail,
    `\`${RUN}\` failed at 03:10; the test was changed 2 times from the shell, first 2 min later; it failed again at 03:12, then passed at 03:12.`);
});

test('a check that keeps failing says how often, and only then that it has not passed', () => {
  const flags = detectTestEditedAfterFailure(expandWrites([
    fail('c1', '2026-10-15T03:10:00Z'),
    shellWrite('w1', '2026-10-15T03:11:00Z'),
    fail('c2', '2026-10-15T03:12:00Z'),
    fail('c3', '2026-10-15T03:14:00Z'),
  ]));

  assert.equal(flags.length, 1);
  assert.match(flags[0]?.detail ?? '', /it failed again 2 more times, last at 03:14, and has not passed since\.$/);
});

test('a refailure that names only another file still keeps the episode open for this one', () => {
  const flags = detectTestEditedAfterFailure(expandWrites([
    fail('c1', '2026-10-15T03:10:00Z'),
    shellWrite('w1', '2026-10-15T03:11:00Z'),
    { ...fail('c2', '2026-10-15T03:12:00Z'), output: 'FAILED tests/test_other.py::t' },
    pass('c3', '2026-10-15T03:13:00Z'),
  ]));

  assert.equal(flags.length, 1);
  assert.match(flags[0]?.detail ?? '', /it failed again at 03:12, then passed at 03:13\.$/);
});

test('when a different check fails next, the flag says that instead of guessing', () => {
  const flags = detectTestEditedAfterFailure(expandWrites([
    fail('c1', '2026-10-15T03:10:00Z'),
    shellWrite('w1', '2026-10-15T03:11:00Z'),
    fail('c2', '2026-10-15T03:12:00Z', 'uv run pytest -q tests/test_other.py'),
  ]));

  assert.equal(flags.length, 1);
  assert.match(flags[0]?.detail ?? '', /it did not pass again before `uv run pytest -q tests\/test_other\.py` failed at 03:12\.$/);
  assert.doesNotMatch(flags[0]?.detail ?? '', /has not passed since/);
});
