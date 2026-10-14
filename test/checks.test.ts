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
    ['pnpm --filter @atlas/web build', 'pnpm build'],
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
