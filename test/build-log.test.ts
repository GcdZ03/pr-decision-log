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

// CreativeNotch PR #49 linked `.claude/worktrees/wf_…/Tests/…`: an edit made
// in a subagent's worktree inside the repository, whose branch was merged
// into this one. The reviewer needs the path the file has in this diff.
test("an edit in a worktree nested in the repository is published under its path in the repository", () => {
  const log = buildLog([
    edit('e1', '/repo/.claude/worktrees/wf_164b2e66-38c-3/src/api.ts'),
    edit('e2', '/repo/.worktrees/feature/src/wip.ts'),
  ], { ...meta, diff: DIFF, repoRoot: '/repo' });

  assert.equal(log.changes.find((c) => c.file === 'src/api.ts')?.edits, 1);
  assert.equal(log.changes.find((c) => c.file === 'src/wip.ts')?.status, 'not in diff');
  assert.ok(!JSON.stringify(log).includes('worktrees'));
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

const writer = (id: string, command: string, writes: { path: string; append?: true; assertionsBefore?: number; assertionsAfter?: number }[],
  outcome: 'pass' | 'fail' = 'pass', output = ''): TimelineEvent =>
  ({ kind: 'command', id, at: '2026-09-19T09:00:00Z', command, classification: 'other', outcome, output, writes });

test('a test rewritten from the shell after a failure is flagged in the log', () => {
  const log = buildLog([
    { kind: 'command', id: 'c1', at: '2026-09-19T09:00:00Z', command: 'pnpm test', classification: 'test', outcome: 'fail', output: 'FAIL src/api.test.ts' },
    writer('w1', "cat > src/api.test.ts <<'EOF'\nit.todo('x');\nEOF", [{ path: '/repo/src/api.test.ts', assertionsAfter: 0 }]),
    { kind: 'command', id: 'c2', at: '2026-09-19T09:02:00Z', command: 'pnpm test', classification: 'test', outcome: 'pass' },
  ], { ...meta, repoRoot: '/repo' });

  const flag = log.flags.find((f) => f.code === 'TEST_EDITED_AFTER_FAILURE');
  assert.equal(flag?.file, 'src/api.test.ts');
});

test('shell writes count toward files in the diff, and a scratch file the diff lacks is left out', () => {
  const log = buildLog([
    writer('w1', 'x', [{ path: '/repo/src/api.ts' }, { path: '/repo/out.log' }]),
  ], { ...meta, repoRoot: '/repo', diff: DIFF });

  assert.equal(log.changes.find((c) => c.file === 'src/api.ts')?.edits, 1);
  assert.ok(!log.changes.some((c) => c.file === 'out.log'));
});

const REVIEW_DIFF = [
  'diff --git a/Dockerfile b/Dockerfile', '--- a/Dockerfile', '+++ b/Dockerfile', '@@ -1 +1 @@', '-FROM a', '+FROM b',
  'diff --git a/.github/workflows/ci.yml b/.github/workflows/ci.yml', '--- a/.github/workflows/ci.yml', '+++ b/.github/workflows/ci.yml', '@@ -1 +1 @@', '-x', '+y',
  'diff --git a/src/api.ts b/src/api.ts', '--- a/src/api.ts', '+++ b/src/api.ts', '@@ -1 +1,2 @@', '-a', '+b', '+c',
].join('\n');

test('the log carries checks, never-run gaps, risky files and scope from the diff', () => {
  const log = buildLog([
    { kind: 'command', id: 'c1', at: '2026-10-03T06:00:00Z', command: 'pnpm test 2>&1 | tail', classification: 'test', outcome: 'pass' },
  ], { ...meta, repoRoot: '/repo', diff: REVIEW_DIFF });

  assert.deepEqual(log.checks.map((c) => [c.command, c.tool, c.last]), [['pnpm test', 'pnpm test', 'pass']]);
  assert.deepEqual(log.neverRun, [{ check: 'docker build', because: 'a Docker file changed' }]);
  assert.deepEqual(log.risky, [{ category: 'CI and automation', paths: ['.github/workflows/ci.yml'] }]);
  assert.equal(log.scope?.files, 3);
  assert.equal(log.scope?.added, 4);
});

test('stray writes are in-repo writes the diff lacks, minus what git ignores', () => {
  const log = buildLog([
    writer('w1', 'x', [{ path: '/repo/src/api.ts' }, { path: '/repo/notes/todo.md' }, { path: '/repo/out.log' }, { path: '/tmp/scratch.txt' }]),
  ], { ...meta, repoRoot: '/repo', diff: REVIEW_DIFF, notIgnored: (paths) => paths.filter((p) => !p.endsWith('.log')) });

  assert.deepEqual(log.strayWrites, ['notes/todo.md']);
});

test('with no diff there is no scope, no never-run line and no stray list', () => {
  const log = buildLog([edit('e1', 'src/a.ts')], meta);

  assert.equal(log.scope, undefined);
  assert.deepEqual(log.neverRun, []);
  assert.deepEqual(log.strayWrites, []);
});

const ABSOLUTE = ['/Users', '/home', '/tmp', '/private', '/var'];

test('with no repo root, no absolute path reaches the log', () => {
  const home = '/Users/someone/secret-proj';
  const log = buildLog([
    { kind: 'command', id: 'c1', at: '2026-09-19T09:00:00Z', command: `pytest ${home}/tests/test_a.py -q`, classification: 'test', outcome: 'fail', output: 'FAILED tests/test_a.py::t' },
    edit('e1', `${home}/tests/test_a.py`, 3, 1),
    writer('w1', `cat > ${home}/notes.txt <<'EOF'\nbody\nEOF`, [{ path: `${home}/notes.txt` }, { path: '/private/var/folders/x/scratch.txt' }]),
    edit('e2', `${home}/src/api.ts`),
    edit('e3', '/home/dev/elsewhere/other.ts'),
    edit('e4', '/tmp/t/tool.ts'),
  ], { ...meta, diff: DIFF }, [{ text: `Decided to store at ${home}/data`, kind: 'decision', source: 'stated', confidence: 'stated' }]);

  const json = JSON.stringify(log);
  for (const prefix of ABSOLUTE) assert.ok(!json.includes(prefix), `${prefix} leaked: ${json}`);
  assert.deepEqual(log.strayWrites, []);
  assert.ok(log.flags.some((f) => f.code === 'TEST_EDITED_AFTER_FAILURE'));
});

test('with no repo root and no diff, edits keep only their names', () => {
  const log = buildLog([edit('e1', '/Users/someone/proj/src/a.ts'), edit('e2', 'src/b.ts')], meta);

  assert.deepEqual(log.changes.map((c) => c.file), ['a.ts', 'src/b.ts']);
});

test('with no repo root, an absolute edit of a file in the diff is matched to its diff path', () => {
  const log = buildLog([edit('e1', '/Users/someone/proj/src/api.ts')], { ...meta, diff: DIFF });

  assert.equal(log.changes.find((c) => c.file === 'src/api.ts')?.edits, 1);
  assert.ok(!log.changes.some((c) => c.status === 'not in diff'));
});

test('a stated decision publishes in-repo paths repo-relative and other private paths by name only', () => {
  const log = buildLog([], { ...meta, repoRoot: '/repo' }, [
    { text: 'Store uploads under /repo/data/uploads, and copy /Users/me/Downloads/sample.csv into fixtures.', kind: 'decision', source: 'stated', confidence: 'stated' },
    { text: 'Read /private/repo/config.toml and /var/folders/x/tmp.json first.', kind: 'assumption', source: 'stated', confidence: 'stated' },
  ]);

  assert.equal(log.decisions[0]?.text, 'Store uploads under data/uploads, and copy sample.csv into fixtures.');
  assert.equal(log.decisions[1]?.text, 'Read config.toml and tmp.json first.');
});

test('a macOS repo root reached through /private is stripped from decisions in either form', () => {
  const log = buildLog([], { ...meta, repoRoot: '/private/tmp/work/app' }, [
    { text: 'Edit /tmp/work/app/src/a.ts and /private/tmp/work/app/src/b.ts.', kind: 'decision', source: 'stated', confidence: 'stated' },
  ]);

  assert.equal(log.decisions[0]?.text, 'Edit src/a.ts and src/b.ts.');
});

test('NO_TEST_RUN counts files in proper English', () => {
  const one = buildLog([edit('e1', 'src/a.ts')], meta).flags.find((f) => f.code === 'NO_TEST_RUN');
  const two = buildLog([edit('e1', 'src/a.ts'), edit('e2', 'src/b.ts')], meta).flags.find((f) => f.code === 'NO_TEST_RUN');

  assert.equal(one?.detail, '1 file changed and no test command was recorded in this session.');
  assert.equal(two?.detail, '2 files changed and no test command was recorded in this session.');
});

const ORIGIN_DIFF = [
  'diff --git a/tests/test_v.py b/tests/test_v.py', '--- a/tests/test_v.py', '+++ b/tests/test_v.py', '@@ -1,2 +1,5 @@',
  ' def test_old():', '     assert 1',
  '+def test_new():', '+    assert 2',
  'diff --git a/src/v.py b/src/v.py', '--- a/src/v.py', '+++ b/src/v.py', '@@ -1 +1 @@', '-a', '+b',
  'diff --git a/src/auth.py b/src/auth.py', '--- a/src/auth.py', '+++ b/src/auth.py', '@@ -1 +1 @@', '-a', '+b',
].join('\n');

const episode = (testName: string): TimelineEvent[] => [
  { kind: 'command', id: 'c1', at: '2026-10-15T03:12:00Z', command: 'uv run pytest -q tests/test_v.py', classification: 'test', outcome: 'fail', output: `FAILED tests/test_v.py::${testName}` },
  writer('w1', 'x', [{ path: '/repo/tests/test_v.py', assertionsBefore: 2, assertionsAfter: 1 }]),
  { kind: 'command', id: 'c2', at: '2026-10-15T03:13:00Z', command: 'uv run pytest -q tests/test_v.py', classification: 'test', outcome: 'pass' },
];

test('a test-edit flag knows whether its failing test was added by the PR or already existed', () => {
  const added = buildLog(episode('test_new'), { ...meta, repoRoot: '/repo', diff: ORIGIN_DIFF });
  const existing = buildLog(episode('test_old'), { ...meta, repoRoot: '/repo', diff: ORIGIN_DIFF });

  assert.equal(added.flags.find((f) => f.code === 'TEST_EDITED_AFTER_FAILURE')?.origin, 'added');
  assert.equal(existing.flags.find((f) => f.code === 'TEST_EDITED_AFTER_FAILURE')?.origin, 'existing');
});

test('the log pairs changed code with changed tests and names the code without one', () => {
  const log = buildLog([], { ...meta, repoRoot: '/repo', diff: ORIGIN_DIFF });

  assert.deepEqual(log.coverage, { pairs: [{ source: 'src/v.py', tests: ['tests/test_v.py'] }], untested: ['src/auth.py'] });
});

test('the PR address is carried for links, and absent without one', () => {
  assert.equal(buildLog([], { ...meta, prUrl: 'https://github.com/o/r/pull/37' }).prUrl, 'https://github.com/o/r/pull/37');
  assert.equal(buildLog([], meta).prUrl, undefined);
  assert.equal(buildLog([], { ...meta, prUrl: 'javascript:alert(1)' }).prUrl, undefined, 'only a GitHub pull request URL');
});

// A tick says the last run passed, but code edited after the last test run
// was never tested. In 3 of 26 real PRs the agent changed code after its
// final test run (one 13 minutes after). Said per PR, from any test run: a
// later `npm test` re-verifies what an earlier `node --test` checked.
const at = (m: number) => `2026-10-17T10:${String(m).padStart(2, '0')}:00Z`;
const testRun = (id: string, m: number, command = 'npm test'): TimelineEvent =>
  ({ kind: 'command', id, at: at(m), command, classification: 'test', outcome: 'pass' });
const codeEdit = (id: string, m: number, path: string): TimelineEvent => ({ kind: 'edit', id, at: at(m), path });

test('code edited after the last test run is reported, with how long after', () => {
  const log = buildLog([
    testRun('t1', 1), codeEdit('e1', 5, '/repo/src/settings.py'), codeEdit('e2', 14, '/repo/src/api.py'), codeEdit('e3', 6, '/repo/src/settings.py'),
  ], { ...meta, repoRoot: '/repo' });

  assert.deepEqual(log.changedAfterTests, { files: ['src/settings.py', 'src/api.py'], lastTestAt: at(1), lastEditAt: at(14) });
});

test('a test run after the edits clears it, and tests, docs and config edits do not count', () => {
  assert.equal(buildLog([codeEdit('e1', 1, '/repo/src/a.py'), testRun('t1', 2)], { ...meta, repoRoot: '/repo' }).changedAfterTests, undefined);
  assert.equal(buildLog([testRun('t1', 1), codeEdit('e1', 2, '/repo/tests/test_a.py'), codeEdit('e2', 3, '/repo/README.md'), codeEdit('e3', 4, '/repo/pyproject.toml')], { ...meta, repoRoot: '/repo' }).changedAfterTests, undefined);
});

test('with no test run at all there is nothing to call stale; NO_TEST_RUN covers it', () => {
  assert.equal(buildLog([codeEdit('e1', 1, '/repo/src/a.py')], { ...meta, repoRoot: '/repo' }).changedAfterTests, undefined);
});

test('a lint or build run is not a test run, and an auto-fix after the tests is an edit like any other', () => {
  const log = buildLog([testRun('t1', 1), testRun('l1', 2, 'uv run ruff check .'), codeEdit('e1', 3, '/repo/src/a.py')], { ...meta, repoRoot: '/repo' });

  assert.deepEqual(log.changedAfterTests?.files, ['src/a.py']);
});

// Commits a human or another tool made are not covered by the log's checks
// or flags, and nothing said so. A commit is covered when a recorded git
// command that makes commits ran at that time.
const gitRun = (id: string, isoAt: string, command: string, durationMs?: number): TimelineEvent =>
  ({ kind: 'command', id, at: isoAt, command, classification: 'git', outcome: 'pass', ...(durationMs ? { durationMs } : {}) });

test('commits no recorded git command made are listed as outside the recorded sessions', () => {
  const log = buildLog([
    gitRun('g1', '2026-10-17T10:05:10Z', 'git commit -m "feat: x"'),
    gitRun('g2', '2026-10-17T11:00:00Z', 'git rebase main', 30_000),
  ], { ...meta, commits: [
    { sha: 'aaaaaaa1111111111111111111111111111111a1', at: '2026-10-17T10:05:08Z' },
    { sha: 'bbbbbbb2222222222222222222222222222222b2', at: '2026-10-17T10:59:40Z' },
    { sha: 'ccccccc3333333333333333333333333333333c3', at: '2026-10-17T12:30:00+02:00' },
  ] });

  assert.deepEqual(log.outsideCommits, [{ sha: 'ccccccc3333333333333333333333333333333c3', at: '2026-10-17T12:30:00+02:00' }]);
});

test('with every commit made in a session, or no commits known, nothing is listed', () => {
  const ev = [gitRun('g1', '2026-10-17T10:05:10Z', 'cd /w && git add -A && git commit -q -m x')];
  assert.equal(buildLog(ev, { ...meta, commits: [{ sha: 'a'.repeat(40), at: '2026-10-17T10:05:09Z' }] }).outsideCommits, undefined);
  assert.equal(buildLog(ev, meta).outsideCommits, undefined);
});

test('a session that recorded nothing claims nothing about commits', () => {
  assert.equal(buildLog([], { ...meta, commits: [{ sha: 'a'.repeat(40), at: '2026-10-17T10:05:09Z' }] }).outsideCommits, undefined);
});
