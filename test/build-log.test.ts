import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildLog } from '../src/render/build-log.ts';
import { compileExtraPatterns } from '../src/render/redact.ts';
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

test('flagEditAfterFailure: false turns the timeline flag off', () => {
  const log = buildLog([
    cmd('c1', 'npm test', 'fail', 'FAIL src/a.test.ts'),
    edit('e1', 'src/a.test.ts', 5, 2),
    cmd('c2', 'npm test', 'pass'),
  ], { ...meta, flagEditAfterFailure: false });

  assert.ok(!log.flags.some((f) => f.code === 'TEST_EDITED_AFTER_FAILURE'));
});

test('extra redaction rules apply to everything the log publishes', () => {
  const log = buildLog([cmd('c1', 'npm test', 'pass')], { ...meta, intent: 'fix INTERNAL-AB12CD34', extraRedactions: compileExtraPatterns(['INTERNAL-[A-Z0-9]{8}']) });

  assert.ok(!JSON.stringify(log).includes('INTERNAL-AB12CD34'));
});

// A real log listed about forty commands, nearly all `cat > f`, `sed` and
// `grep`, burying the nine test runs a reviewer needed.

const run = (id: string, command: string, classification: 'test' | 'build' | 'lint' | 'git' | 'other'): TimelineEvent =>
  ({ kind: 'command', id, at: '2026-09-19T09:00:00Z', command, classification, outcome: 'pass' });

test('verification lists test, build and lint runs and only counts the rest', () => {
  const log = buildLog([
    run('a', 'pnpm test', 'test'), run('b', 'pnpm run typecheck', 'build'), run('c', 'just lint', 'lint'),
    run('d', "cat > src/x.ts <<'EOF'\nexport {}\nEOF", 'other'), run('e', 'grep -n foo src', 'other'), run('f', 'git status', 'git'),
  ], meta);

  assert.deepEqual(log.verification.map((v) => v.command), ['pnpm test', 'pnpm run typecheck', 'just lint']);
  assert.equal(log.otherCommands, 3);
});

test('no command text that is not a runner fragment reaches the log', () => {
  const log = buildLog([
    run('a', "cat > Dockerfile <<'EOF'\nRUN npm install --global pnpm\nEOF\npnpm test", 'test'),
    run('b', "sed -i '' 's/secret-value/x/' /Users/someone/private/app.ts", 'other'),
  ], meta);

  const json = JSON.stringify(log);
  assert.doesNotMatch(json, /Dockerfile|RUN npm|secret-value|Users\/someone/);
  assert.equal(log.verification[0]?.command, 'pnpm test');
});

const DIFF = [
  'diff --git a/src/api.ts b/src/api.ts', 'index 1..2 100644', '--- a/src/api.ts', '+++ b/src/api.ts', '@@ -1 +1 @@', '-a', '+b',
  'diff --git a/src/api.test.ts b/src/api.test.ts', 'new file mode 100644', 'index 0..2', '--- /dev/null', '+++ b/src/api.test.ts', '@@ -0,0 +1 @@', '+it("x", () => {});',
  'diff --git a/old.md b/old.md', 'deleted file mode 100644', 'index 2..0', '--- a/old.md', '+++ /dev/null', '@@ -1 +0,0 @@', '-gone',
  'diff --git a/a/before.ts b/a/after.ts', 'similarity index 100%', 'rename from a/before.ts', 'rename to a/after.ts',
].join('\n');

test('changes come from the PR diff, however the files were written', () => {
  const log = buildLog([], { ...meta, diff: DIFF });

  assert.deepEqual(log.changes.map((c) => [c.file, c.status, c.role]), [
    ['src/api.ts', 'modified', 'source'],
    ['src/api.test.ts', 'added', 'test'],
    ['old.md', 'deleted', 'source'],
    ['a/after.ts', 'renamed', 'source'],
  ]);
});

test("the agent's own edit counts are added to the diff's files", () => {
  const log = buildLog([edit('e1', '/repo/src/api.ts'), edit('e2', '/repo/src/api.ts')], { ...meta, diff: DIFF, repoRoot: '/repo' });

  assert.equal(log.changes.find((c) => c.file === 'src/api.ts')?.edits, 2);
  assert.equal(log.changes.find((c) => c.file === 'src/api.test.ts')?.edits, 0);
});

test('an edit the diff does not contain is listed as not in the diff, and one outside the repo is dropped', () => {
  const log = buildLog([edit('e1', '/repo/src/wip.ts'), edit('e2', '/tmp/scratch.py')], { ...meta, diff: DIFF, repoRoot: '/repo' });

  assert.equal(log.changes.find((c) => c.file === 'src/wip.ts')?.status, 'not in diff');
  assert.ok(!log.changes.some((c) => c.file.includes('scratch')));
});

test('with no diff, changes still come from the edits, as before', () => {
  const log = buildLog([edit('e1', 'src/a.ts')], meta);

  assert.deepEqual(log.changes.map((c) => [c.file, c.edits]), [['src/a.ts', 1]]);
});

test('commands are classified when the log is built, so a stored misclassification is corrected', () => {
  // Recorded by an older classifier that read heredoc bodies.
  const stale: TimelineEvent = { kind: 'command', id: 'x', at: '2026-09-19T09:00:00Z',
    command: "cat > Dockerfile <<'EOF'\nRUN pnpm test\nEOF", classification: 'test', outcome: 'pass' };

  const log = buildLog([stale], meta);
  assert.equal(log.verification.length, 0);
  assert.equal(log.otherCommands, 1);
});
