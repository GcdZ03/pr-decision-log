import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildLog } from '../src/render/build-log.ts';
import type { TimelineEvent } from '../src/events/types.ts';

const meta = { repo: 'github.com/g/r', branch: 'feat/x', headSha: 'abc1234' };

const cmd = (
  id: string, command: string, outcome: 'pass' | 'fail' | 'interrupted', output = '',
): TimelineEvent => ({ kind: 'command', id, at: '2026-09-19T09:00:00Z', command, classification: 'test', outcome, output });

const edit = (id: string, path: string, b?: number, a?: number): TimelineEvent =>
  ({ kind: 'edit', id, at: '2026-09-19T09:05:00Z', path, assertionsBefore: b, assertionsAfter: a });

test('summarises verification runs', () => {
  const log = buildLog([cmd('c1', 'npm test', 'fail'), cmd('c2', 'npm test', 'pass')], meta);

  assert.equal(log.verification.length, 2);
  assert.equal(log.verification[0]?.outcome, 'fail');
  assert.equal(log.verification[1]?.outcome, 'pass');
});

test('NEVER carries raw command output into the log', () => {
  // DESIGN section 9: raw tool output must not reach anything renderable.
  const secret = 'AKIAIOSFODNN7EXAMPLE';
  const log = buildLog([cmd('c1', 'npm test', 'fail', `leaked ${secret}`)], meta);

  assert.ok(!JSON.stringify(log).includes(secret), 'output leaked into the log');
  assert.ok(!JSON.stringify(log).includes('leaked'));
});

test('groups edits per file with counts and a test/source role', () => {
  const log = buildLog([
    edit('e1', 'src/a.ts'), edit('e2', 'src/a.ts'), edit('e3', 'src/a.test.ts'),
  ], meta);

  assert.equal(log.changes.length, 2);
  const a = log.changes.find((c) => c.file === 'src/a.ts');
  assert.equal(a?.edits, 2);
  assert.equal(a?.role, 'source');
  assert.equal(log.changes.find((c) => c.file === 'src/a.test.ts')?.role, 'test');
});

test('carries flags produced by the analysers', () => {
  const log = buildLog([
    cmd('c1', 'npm test', 'fail', 'FAIL src/a.test.ts'),
    edit('e1', 'src/a.test.ts', 5, 2),
  ], meta);

  assert.equal(log.flags.length, 1);
  assert.equal(log.flags[0]?.code, 'TEST_EDITED_AFTER_FAILURE');
});

test('raises NO_TEST_RUN when code changed but nothing was verified', () => {
  const log = buildLog([edit('e1', 'src/a.ts')], meta);
  assert.ok(log.flags.some((f) => f.code === 'NO_TEST_RUN'));
});

test('does not raise NO_TEST_RUN when a test actually ran', () => {
  const log = buildLog([edit('e1', 'src/a.ts'), cmd('c1', 'npm test', 'pass')], meta);
  assert.ok(!log.flags.some((f) => f.code === 'NO_TEST_RUN'));
});

test('redacts free text and reports the hit count', () => {
  const log = buildLog([], { ...meta, intent: 'deploy with token ghp_' + 'a1B2c3D4e5'.repeat(4) });
  assert.ok(!JSON.stringify(log).includes('ghp_a1B2'));
  assert.equal(log.redaction.hits, 1);
});

test('records schema version and metadata', () => {
  const log = buildLog([], meta);
  assert.equal(log.schema, 'pdl/1');
  assert.equal(log.branch, 'feat/x');
  assert.equal(log.repo.remote, 'github.com/g/r');
});

test('file paths are repo-relative in changes and in flag details', () => {
  const log = buildLog([
    cmd('c1', 'npm test', 'fail', 'FAIL /repo/src/a.test.ts'),
    edit('e1', '/repo/src/a.test.ts', 5, 2),
  ], { ...meta, repoRoot: '/repo' });

  assert.equal(log.changes[0]?.file, 'src/a.test.ts');
  assert.equal(log.flags[0]?.file, 'src/a.test.ts');
  assert.ok(!JSON.stringify(log).includes('/repo/src'), 'absolute path leaked into the log');
});
