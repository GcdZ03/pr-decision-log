import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectPrCreation } from '../src/publish/detect-pr.ts';
import type { CommandEvent } from '../src/events/types.ts';

const cmd = (over: Partial<CommandEvent>): CommandEvent => ({
  kind: 'command',
  id: 'tu-1',
  at: '2026-09-19T09:00:00Z',
  command: 'gh pr create --fill',
  classification: 'git',
  outcome: 'pass',
  output: 'https://github.com/GcdZ03/pr-decision-log/pull/42\n',
  ...over,
});

test('a successful gh pr create yields the pull request number', () => {
  assert.deepEqual(detectPrCreation(cmd({})), { prNumber: 42 });
});

test('the number is read from a url buried in longer output', () => {
  const event = cmd({
    output: 'Warning: 3 uncommitted changes\n\nCreating pull request for feat into main\n\nhttps://github.com/GcdZ03/pr-decision-log/pull/7\n',
  });

  assert.deepEqual(detectPrCreation(event), { prNumber: 7 });
});

test('a failed gh pr create yields nothing', () => {
  assert.equal(detectPrCreation(cmd({ outcome: 'fail', output: 'Exit code 1\npull request already exists' })), null);
});

test('an interrupted gh pr create yields nothing, because the run did not finish', () => {
  assert.equal(detectPrCreation(cmd({ outcome: 'interrupted' })), null);
});

test('gh pr view is not a creation', () => {
  assert.equal(detectPrCreation(cmd({ command: 'gh pr view 42' })), null);
});

test('an unrelated command is not a creation', () => {
  assert.equal(detectPrCreation(cmd({ command: 'npm test' })), null);
});

test('an echo that merely mentions gh pr create is not a creation', () => {
  const event = cmd({ command: 'echo "run gh pr create when ready"' });

  assert.equal(detectPrCreation(event), null);
});

test('a gh pr create inside a multi-line script is still detected', () => {
  const event = cmd({ command: 'set -e\nnpm test\ngh pr create --fill --base main' });

  assert.deepEqual(detectPrCreation(event), { prNumber: 42 });
});

test('a creation that printed no url yields nothing rather than guessing', () => {
  assert.equal(detectPrCreation(cmd({ output: 'Creating pull request for feat into main\n' })), null);
});

test('an edit event is never a creation', () => {
  assert.equal(detectPrCreation({ kind: 'edit', id: 'e1', at: '2026-09-19T09:00:00Z', path: 'a.ts' }), null);
});

test('a url pointing at a different host is ignored', () => {
  const event = cmd({ output: 'https://evil.example.com/GcdZ03/x/pull/99\n' });

  assert.equal(detectPrCreation(event), null);
});
