import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isFixer, summariseChecks, toolOf, toolStatuses } from '../src/review/checks.ts';
import type { Outcome, TimelineEvent } from '../src/events/types.ts';

let n = 0;
const run = (command: string, outcome: Outcome, at = `2026-10-03T06:${String(10 + n).padStart(2, '0')}:00Z`): TimelineEvent =>
  ({ kind: 'command', id: `c${n++}`, at, command, classification: 'other', outcome });

test('a check is one distinct runner fragment, with its runs, failures and last result', () => {
  const checks = summariseChecks([
    run('uv run pytest tests/test_p.py -q 2>&1 | tail', 'fail'),
    run('uv run pytest tests/test_p.py -q', 'pass'),
    run('uv run pytest -q', 'pass'),
    run('ls -la', 'pass'),
  ]);

  assert.deepEqual(checks.map((c) => [c.command, c.tool, c.runs, c.failures, c.last]), [
    ['uv run pytest tests/test_p.py -q', 'pytest', 2, 1, 'pass'],
    ['uv run pytest -q', 'pytest', 1, 0, 'pass'],
  ]);
});

test('tool names come from the runner, not its launcher or arguments', () => {
  const cases: [string, string][] = [
    ['pnpm --filter @app/web build', 'pnpm build'],
    ['pnpm run typecheck', 'pnpm typecheck'],
    ['npm test --', 'npm test'],
    ['npx vitest run', 'vitest'],
    ['python3 -m pytest -x', 'pytest'],
    ['pnpm exec playwright test e2e/a.spec.ts', 'playwright test'],
    ['just test', 'just test'],
    ['go test ./...', 'go test'],
    ['cargo test', 'cargo test'],
    ['node --test test/a.test.ts', 'node --test'],
    ['docker compose build web', 'docker compose build'],
    ['docker build -t x .', 'docker build'],
    ['tsc --noEmit', 'tsc'],
    ['uv run ruff check .', 'ruff'],
  ];
  for (const [fragment, tool] of cases) assert.equal(toolOf(fragment), tool, fragment);
});

test('a command that rewrites files is a fixer, unless it only checks', () => {
  for (const f of ['uv run ruff check --fix .', 'pnpm exec prettier --write apps/web', 'uv run ruff format .', 'cargo fmt', 'gofmt -w .', 'black src']) {
    assert.equal(isFixer(f), true, f);
  }
  for (const f of ['uv run ruff check .', 'prettier --check .', 'cargo fmt --check', 'black --check src', 'pnpm test']) {
    assert.equal(isFixer(f), false, f);
  }
});

test('a tool passes only when the last run of every one of its checks passed', () => {
  const statuses = toolStatuses(summariseChecks([
    run('uv run pytest -q', 'pass'),
    run('uv run pytest tests/test_a.py -q', 'fail'),
    run('pnpm test', 'fail'),
    run('pnpm test', 'pass'),
    run('uv run pytest tests/test_b.py -q', 'interrupted'),
  ]));

  assert.deepEqual(statuses, [{ tool: 'pytest', status: 'fail' }, { tool: 'pnpm test', status: 'pass' }]);
});

test('an interrupted last run is never shown as a pass', () => {
  assert.deepEqual(toolStatuses(summariseChecks([run('uv run pytest -q', 'pass'), run('uv run pytest -q', 'interrupted')])),
    [{ tool: 'pytest', status: 'interrupted' }]);
});

test('fixers are summarised but never count toward a tool status', () => {
  const checks = summariseChecks([run('uv run ruff check --fix .', 'pass')]);

  assert.equal(checks[0]?.fixer, true);
  assert.deepEqual(toolStatuses(checks), []);
});

test('-w means workspace/watch for most tools, not a fixer flag', () => {
  // -w is a fixer flag only for gofmt
  assert.equal(isFixer('gofmt -w .'), true);
  // For other tools, -w means workspace or watch, not write
  assert.equal(isFixer('pnpm -w test'), false);
  assert.equal(isFixer('tsc -w'), false);
  assert.equal(isFixer('vitest -w'), false);
  assert.equal(isFixer('npm test -w pkg'), false);
  // But --write and --fix still work for any tool
  assert.equal(isFixer('prettier --write file.js'), true);
  assert.equal(isFixer('ruff check --fix .'), true);
});

test('formatters are only matched at the tool position, not in filenames', () => {
  // pytest tests/black/ should not be treated as a fixer (black is just a path)
  assert.equal(isFixer('uv run pytest tests/black/'), false);
  // But actual formatters should still work
  assert.equal(isFixer('black src'), true);
  assert.equal(isFixer('uv run ruff format .'), true);
  assert.equal(isFixer('cargo fmt'), true);
  assert.equal(isFixer('rustfmt --check'), false); // but --check negates it
  assert.equal(isFixer('gofmt -w .'), true);
});

test('toolOf handles option values and special cases correctly', () => {
  const cases: [string, string][] = [
    // docker with -f/-p options
    ['docker compose -f a.yml build web', 'docker compose build'],
    ['docker compose --file a.yml build web', 'docker compose build'],
    ['docker compose -p proj build web', 'docker compose build'],
    ['docker compose --project-name proj build web', 'docker compose build'],
    // docker-compose as one word
    ['docker-compose build web', 'docker compose build'],
    // npm -w takes a value (workspace), pnpm -w is a flag (workspace-root)
    ['npm run -w pkg test', 'npm test'],
    ['npm run -w @pkg/name typecheck', 'npm typecheck'],
    ['pnpm -w test', 'pnpm test'],
    // yarn workspace
    ['yarn workspace web test', 'yarn test'],
    ['yarn workspace @org/pkg run lint', 'yarn lint'],
    // cargo +toolchain
    ['cargo +nightly test', 'cargo test'],
    ['cargo +stable clippy', 'cargo clippy'],
  ];
  for (const [fragment, tool] of cases) assert.equal(toolOf(fragment), tool, fragment);
});

// Seen on a real PR: `swift test --filter "ShelfStoreTests"` failed, then the
// full `swift test` passed three times. The Checks line still said
// `swift test ✗ (failed, not re-run)`, which was false: the full run re-ran
// the filtered tests. A later passing run of the same command with fewer
// arguments covers a narrower failed run.
test('a narrower failed run is superseded by a later passing broader run of the same tool', () => {
  const checks = summariseChecks([
    run('swift test 2>&1 | tail', 'fail', '2026-10-23T23:51:39Z'),
    run('swift test --filter "ShelfStoreTests" 2>&1', 'fail', '2026-10-23T23:52:18Z'),
    run('swift test 2>&1 | tail', 'pass', '2026-10-23T23:52:50Z'),
  ]);

  const filtered = checks.find((c) => c.command === 'swift test --filter ShelfStoreTests');
  assert.equal(filtered?.last, 'fail');
  assert.deepEqual(filtered?.supersededBy, { command: 'swift test', at: '2026-10-23T23:52:50Z' });
  assert.deepEqual(toolStatuses(checks), [{ tool: 'swift test', status: 'pass' }]);
});

// CreativeNotch PR #49: the filter `"LimitsWiringTests|ShelfPendingCopyTests"`
// is not one plain word, so its value was blanked and the check recorded as a
// bare `swift test --filter`. The full `swift test` that passed 30 s later did
// not cover it, because the rule wanted a value after the flag.
test('a filtered run whose value was blanked is still covered by a later full run', () => {
  const checks = summariseChecks([
    run('swift test --filter "LimitsWiringTests|ShelfPendingCopyTests" 2>&1 | tail', 'fail', '2026-10-24T01:50:25Z'),
    run('swift test 2>&1 | grep -E "Executed"', 'pass', '2026-10-24T01:50:56Z'),
  ]);

  assert.deepEqual(checks.find((c) => c.command === 'swift test --filter')?.supersededBy, { command: 'swift test', at: '2026-10-24T01:50:56Z' });
  assert.deepEqual(toolStatuses(checks), [{ tool: 'swift test', status: 'pass' }]);
});

test('a broader run that passed before the narrow failure, or a different narrow run, does not cover it', () => {
  const before = summariseChecks([run('swift test', 'pass', '2026-10-23T23:50:00Z'), run('swift test --filter A', 'fail', '2026-10-23T23:52:00Z')]);
  assert.deepEqual(toolStatuses(before), [{ tool: 'swift test', status: 'fail' }]);

  const sibling = summariseChecks([run('uv run pytest -q tests/test_a.py', 'fail', '2026-10-23T23:50:00Z'), run('uv run pytest -q tests/test_b.py', 'pass', '2026-10-23T23:52:00Z')]);
  assert.deepEqual(toolStatuses(sibling), [{ tool: 'pytest', status: 'fail' }]);
});

test('the full pytest run covers a single-file run that failed before it', () => {
  const checks = summariseChecks([run('uv run pytest -q tests/test_a.py', 'fail', '2026-10-23T23:50:00Z'), run('uv run pytest -q', 'pass', '2026-10-23T23:52:00Z')]);
  assert.deepEqual(toolStatuses(checks), [{ tool: 'pytest', status: 'pass' }]);
});

// Self-review of the rule above: "fewer arguments" is not "broader". Extra
// arguments can build more (--build-tests), switch project (-p), or point at
// packages or directories a bare run does not include. Only a test filter or
// named test files make a run narrower.
test('fewer arguments that are not a test filter or test files cover nothing', () => {
  const cases: [string, string][] = [
    ['swift build --build-tests', 'swift build'],
    ['npx tsc -p tsconfig.build.json', 'npx tsc'],
    ['go test ./...', 'go test'],
    ['uv run pytest integration/', 'uv run pytest'],
    ['uv run pytest -q --runslow', 'uv run pytest -q'],
  ];
  for (const [narrow, broad] of cases) {
    const statuses = toolStatuses(summariseChecks([run(narrow, 'fail', '2026-10-24T10:01:00Z'), run(broad, 'pass', '2026-10-24T10:02:00Z')]));
    assert.ok(statuses.some((s) => s.status === 'fail'), `${narrow} then ${broad}: ${JSON.stringify(statuses)}`);
  }
});

test('a test filter or named test files make a run narrower, so the full run covers them', () => {
  const cases: [string, string][] = [
    ['swift test --filter ShelfStoreTests', 'swift test'],
    ['uv run pytest -q -k ranking', 'uv run pytest -q'],
    ['uv run pytest -q tests/test_a.py tests/test_b.py::test_x', 'uv run pytest -q'],
    ['npx vitest run src/lib/review.test.ts', 'npx vitest run'],
    ['go test ./... -run TestRank', 'go test ./...'],
    ['pnpm test -- -t keeps', 'pnpm test --'],
  ];
  for (const [narrow, broad] of cases) {
    const statuses = toolStatuses(summariseChecks([run(narrow, 'fail', '2026-10-24T10:01:00Z'), run(broad, 'pass', '2026-10-24T10:02:00Z')]));
    assert.ok(statuses.every((s) => s.status === 'pass'), `${narrow} then ${broad}: ${JSON.stringify(statuses)}`);
  }
});

// Found by sweeping the real sessions: `node --test a.test.ts b.test.ts`
// failing was counted as covered by `node --test a.test.ts` passing. A run that
// already selects tests is not the full run; adding files to it widens it.
test('a run that itself selects tests covers nothing', () => {
  const statuses = toolStatuses(summariseChecks([
    run('node --test test/a.test.ts test/b.test.ts', 'fail', '2026-10-24T10:01:00Z'),
    run('node --test test/a.test.ts', 'pass', '2026-10-24T10:02:00Z'),
  ]));
  assert.deepEqual(statuses, [{ tool: 'node --test', status: 'fail' }]);

  const filtered = toolStatuses(summariseChecks([
    run('swift test --filter A --filter B', 'fail', '2026-10-24T10:01:00Z'),
    run('swift test --filter A', 'pass', '2026-10-24T10:02:00Z'),
  ]));
  assert.deepEqual(filtered, [{ tool: 'swift test', status: 'fail' }]);
});

// Found by sweeping 55 published logs for 0.1.10: six PRs kept a ✗ that a
// later passing run had covered, because the two runs differed in output
// flags, or the passing run named the directory holding the failed file.
test('a passing run covers a failure that differs only in output flags or sits in a directory it ran', () => {
  const cases: [string, string][] = [
    ['uv run pytest services/operator-api -q -x', 'uv run pytest services/operator-api -q'],
    ['uv run pytest services/conduit-api/tests/test_audit.py', 'uv run pytest services/conduit-api/tests/test_audit.py -q'],
    ['uv run pytest services/operator-api/tests/test_delegation.py -q', 'uv run pytest services/operator-api -q'],
    ['uv run pytest workers/import-worker/tests/test_chaos.py -x -q -p', 'uv run pytest workers/import-worker/tests/test_chaos.py -q -p no:cacheprovider'],
    ['swift test --skip-build --filter', 'swift test'],
    ['uv run pytest services/a/tests -q', 'uv run pytest services/a'],
  ];
  for (const [narrow, broad] of cases) {
    const statuses = toolStatuses(summariseChecks([run(narrow, 'fail', '2026-10-24T10:01:00Z'), run(broad, 'pass', '2026-10-24T10:02:00Z')]));
    assert.ok(statuses.every((s) => s.status === 'pass'), `${narrow} then ${broad}: ${JSON.stringify(statuses)}`);
  }
});

test('a directory covers only what is inside it, and a whole-suite filter is not covered by a directory', () => {
  const cases: [string, string][] = [
    ['uv run pytest services/b/tests/test_x.py', 'uv run pytest services/a'],
    ['uv run pytest services/ab/tests/test_x.py', 'uv run pytest services/a'],
    ['uv run pytest -k ranking', 'uv run pytest services/a'],
    ['uv run pytest services/a services/b', 'uv run pytest services/a'],
    ['uv run pytest services/a -q --runslow', 'uv run pytest services/a -q'],
  ];
  for (const [narrow, broad] of cases) {
    const statuses = toolStatuses(summariseChecks([run(narrow, 'fail', '2026-10-24T10:01:00Z'), run(broad, 'pass', '2026-10-24T10:02:00Z')]));
    assert.ok(statuses.some((s) => s.status === 'fail'), `${narrow} then ${broad}: ${JSON.stringify(statuses)}`);
  }
});

// atlas-platform #50 and #79: `ruff check <dir>` failed, then the whole project
// passed `ruff check .`. A linter checks each file on its own.
test('a whole-project lint run covers a failed lint of a directory; a fix run covers nothing', () => {
  const covered = summariseChecks([
    run('uv run ruff check services/conduit-api', 'fail', '2026-10-24T10:01:00Z'),
    run('uv run ruff check . -q', 'pass', '2026-10-24T10:02:00Z'),
  ]);
  assert.deepEqual(toolStatuses(covered), [{ tool: 'ruff', status: 'pass' }]);

  const fixed = summariseChecks([
    run('uv run ruff check services/a', 'fail', '2026-10-24T10:01:00Z'),
    run('uv run ruff check --fix services/a', 'pass', '2026-10-24T10:02:00Z'),
  ]);
  assert.ok(toolStatuses(fixed).some((s) => s.status === 'fail'));

  const other = summariseChecks([
    run('uv run ruff check services/a', 'fail', '2026-10-24T10:01:00Z'),
    run('uv run ruff check services/b', 'pass', '2026-10-24T10:02:00Z'),
  ]);
  assert.ok(toolStatuses(other).some((s) => s.status === 'fail'));
});
