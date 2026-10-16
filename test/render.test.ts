import { test } from 'node:test';
import assert from 'node:assert/strict';
import { render, VISIBLE_LINE_BUDGET } from '../src/render/render.ts';
import { buildLog, type LogMeta } from '../src/render/build-log.ts';
import type { Outcome, TimelineEvent } from '../src/events/types.ts';
import type { Decision } from '../src/extract/decisions.ts';

const meta: LogMeta = { repo: 'github.com/g/r', branch: 'feat/x', headSha: 'abc1234', generatedAt: '2026-10-03T10:00:00Z', repoRoot: '/repo' };
let n = 0;
const run = (command: string, outcome: Outcome = 'pass', output = ''): TimelineEvent =>
  ({ kind: 'command', id: `c${n++}`, at: `2026-10-03T06:${String(n % 60).padStart(2, '0')}:00Z`, command, classification: 'other', outcome, output });
const fileDiff = (path: string, added = 1, status: 'modified' | 'added' = 'modified') => [
  `diff --git a/${path} b/${path}`, ...(status === 'added' ? ['new file mode 100644', '--- /dev/null'] : [`--- a/${path}`]),
  `+++ b/${path}`, '@@ -1 +1 @@', ...Array.from({ length: added }, (_, i) => `+line ${i}`),
].join('\n');
const visibleLines = (md: string) => {
  const start = md.indexOf('## Decision log') + '## Decision log'.length;
  const end = md.includes('<details>') ? md.indexOf('<details>') : md.indexOf('<sub>');
  return md.slice(start, end).split('\n').filter((l) => l.trim()).length;
};
const confirmed = (text: string): Decision => ({ text, kind: 'decision', source: 'human-answer', confidence: 'confirmed_by_human' });

test('blocks come in reviewer order: checks, decisions, look here, scope, then details', () => {
  const md = render(buildLog([
    run('npm test', 'fail', 'FAIL src/a.test.ts'),
    { kind: 'edit', id: 'e1', at: '2026-10-03T06:59:30Z', path: '/repo/src/a.test.ts', assertionsBefore: 2, assertionsAfter: 1 },
    run('npm test'),
  ], { ...meta, diff: fileDiff('src/a.test.ts') }, [confirmed('Base: main')]));

  const order = ['**Checks (last run):**', '### Decisions you confirmed', '### Look here', '### Scope', '<details>'].map((s) => md.indexOf(s));
  assert.ok(order.every((i, k) => i > -1 && (k === 0 || i > order[k - 1]!)), md);
});

test('the checks line shows each tool, and a last failure is said plainly', () => {
  const md = render(buildLog([run('uv run pytest -q'), run('uv run pytest tests/test_b.py -q', 'fail'), run('pnpm test')], meta));

  assert.match(md, /\*\*Checks \(last run\):\*\* pytest ✗ \(failed, not re-run\) · pnpm test ✓/);
});

test('fixers are not checks, and a session with only fixers ran none', () => {
  const md = render(buildLog([run('uv run ruff check --fix .')], meta));

  assert.match(md, /\*\*Checks:\*\* none were run\./);
  assert.doesNotMatch(md, /Auto-fixes|ruff/, 'an auto-fix is neither a check nor worth a line');
});

test('an interrupted last run is never a tick', () => {
  const md = render(buildLog([run('uv run pytest -q', 'interrupted')], meta));

  assert.match(md, /pytest ✗ \(interrupted\)/);
});

test('never-run gaps are the second line, with no boilerplate beside them', () => {
  const md = render(buildLog([run('npm test')], { ...meta, diff: fileDiff('Dockerfile') }));

  assert.match(md, /\n\*\*Never run:\*\* docker build \(a Docker file changed\)\n/);
  assert.doesNotMatch(render(buildLog([run('npm test')], meta)), /Intent: see/);
});

test('risky files are one bullet under Look here, grouped by category', () => {
  const md = render(buildLog([run('npm test')], { ...meta, diff: [fileDiff('.github/workflows/ci.yml'), fileDiff('uv.lock')].join('\n') }));

  assert.match(md, /- \*\*Privileged or risky files:\*\* CI and automation: `\.github\/workflows\/ci\.yml` · dependencies: `uv\.lock`/);
});

test('scope gives size, spread and tests', () => {
  const md = render(buildLog([run('npm test')], {
    ...meta, diff: [fileDiff('services/api/src/parse.py', 40, 'added'), fileDiff('services/api/tests/test_parse.py', 20, 'added'), fileDiff('README.md', 2)].join('\n'),
  }));

  assert.match(md, /### Scope\n\+62 −0 lines · 3 files \(2 added\) · services\/api · \(root\)\nTests: 1 file changed \(1 added\)\n/);
});

test('with no diff the log still shows checks and look-here, and no scope', () => {
  const md = render(buildLog([run('npm test', 'fail', 'FAIL src/a.test.ts'), { kind: 'edit', id: 'e', at: '2026-10-03T06:59:59Z', path: '/repo/src/a.test.ts' }], meta));

  assert.match(md, /\*\*Checks \(last run\):\*\* npm test ✗/);
  assert.match(md, /### Look here/);
  assert.doesNotMatch(md, /### Scope|Never run/);
});

test('empty blocks are omitted, with no "none" lines', () => {
  const md = render(buildLog([run('npm test')], meta));

  assert.doesNotMatch(md, /### Decisions you confirmed|### Look here|### Scope|none recorded/i);
});

test('the details list only checks that failed, and nothing a reviewer sees elsewhere', () => {
  const md = render(buildLog([run('npm test', 'fail'), run('npm test'), run('pnpm lint'), run('ls'), run('grep -n x src')], { ...meta, diff: fileDiff('src/a.ts') }));

  assert.match(md, /<details><summary>checks that failed \(1\)[^<]*<\/summary>/);
  assert.match(md, /\| `npm test` \| 2 \| 1 \| pass \| \d\d:\d\d \|/);
  assert.doesNotMatch(md, /`pnpm lint` \|/, 'a check that only passed is the tick above, not a row');
  assert.doesNotMatch(md, /#### Files|other command|every file|Redaction/);
});

test('a session whose checks all passed first time has no checks table', () => {
  assert.doesNotMatch(render(buildLog([run('npm test'), run('npm test')], meta)), /Checks that failed/);
});

test('stray writes are listed inside the details', () => {
  const log = { ...buildLog([run('npm test')], { ...meta, diff: fileDiff('src/a.ts') }), strayWrites: ['notes/todo.md'] };

  assert.match(render(log), /Written during the session but not in the diff: 1 file: `notes\/todo\.md`/);
});

test('at most three confirmed decisions and three look-here items are visible', () => {
  const events: TimelineEvent[] = [];
  let diff = '';
  for (let i = 0; i < 5; i++) {
    events.push(run(`npm test -- t${i}`, 'fail', `FAIL src/t${i}.test.ts`));
    events.push({ kind: 'edit', id: `e${i}`, at: `2026-10-03T07:0${i}:00Z`, path: `/repo/src/t${i}.test.ts` });
    diff += `${fileDiff(`src/t${i}.test.ts`)}\n`;
  }
  const decisions = Array.from({ length: 6 }, (_, i) => confirmed(i === 5 ? 'Storage: answered in the session' : `Q${i}: A`));
  const md = render(buildLog(events, { ...meta, diff }, decisions));

  assert.match(md, /- \*…and 3 more in the details below\.\*/);
  assert.match(md, /- \*…and 2 more in the details below\.\*/);
  assert.match(md, /Storage: answered in the session/);
});

test('a huge PR keeps the visible part within budget and the body within maxChars', () => {
  const events: TimelineEvent[] = [];
  for (let i = 0; i < 60; i++) events.push(run(`uv run pytest tests/test_${i}.py -q`, i % 7 === 0 ? 'fail' : 'pass', `FAIL tests/test_${i}.py`));
  const diff = Array.from({ length: 400 }, (_, i) => fileDiff(i % 10 === 0 ? `.github/workflows/w${i}.yml` : `services/s${i % 9}/src/f${i}.py`, 5)).join('\n');
  const decisions = Array.from({ length: 9 }, (_, i) => confirmed(`Q${i}: A`));

  const md = render(buildLog(events, { ...meta, diff }, decisions), { maxChars: 6000 });

  assert.ok(visibleLines(md) <= VISIBLE_LINE_BUDGET, `visible part is ${visibleLines(md)} lines`);
  assert.ok(md.length <= 6000, `body is ${md.length} chars`);
  assert.ok(md.startsWith('<!-- pdl:start') && md.trimEnd().endsWith('<!-- pdl:end -->'));
});

test('a tight budget drops the details first, with a note', () => {
  const log = buildLog([run('npm test')], { ...meta, diff: Array.from({ length: 80 }, (_, i) => fileDiff(`src/f${i}.ts`)).join('\n') });
  const max = render(log, { maxChars: 1_000_000 }).length - 1;
  const md = render(log, { maxChars: max });

  assert.ok(md.length <= max, `body is ${md.length} chars`);
  assert.doesNotMatch(md, /<details>/, 'the details went first');
  assert.match(md, /### Scope/, 'the visible blocks stayed');
  assert.match(md, /cut to fit the PR body/);
  assert.match(md, /\*\*Checks \(last run\):\*\*/, 'the verdict survives');
  assert.ok(md.trimEnd().endsWith('<!-- pdl:end -->'));
});

test('a path with a pipe or a backtick cannot break the table or the code span', () => {
  const md = render(buildLog([run('npm test')], { ...meta, diff: [fileDiff('src/we|ird.ts'), fileDiff('src/tick`name.ts')].join('\n') }));

  // Outside a table the pipe stays as written; GitHub would show a backslash.
  assert.ok(md.includes('`src/we|ird.ts`') && !md.includes('we\\|ird'), md);
  assert.match(md, /``src\/tick`name\.ts``/);
});

test('raw command output never reaches the markdown', () => {
  const md = render(buildLog([run('npm test', 'fail', 'secret-output-AKIAIOSFODNN7EXAMPLE')], meta));

  assert.doesNotMatch(md, /AKIAIOSFODNN7EXAMPLE|secret-output/);
});

test('the footer says where the log came from', () => {
  assert.match(render(buildLog([run('npm test')], { ...meta, sessions: ['a', 'b'] })), /<sub>Recorded from 2 agent sessions on `feat\/x`/);
  assert.match(render(buildLog([run('npm test')], meta)), /<sub>Recorded from the agent session on `feat\/x`/);
});

test('the footer states the timezone once', () => {
  assert.match(render(buildLog([run('npm test')], meta)), /times are UTC/);
});

/** A worst-case PR: many long paths, checks, confirmed decisions, warnings and risky files. */
function bigLog(files: number) {
  const events: TimelineEvent[] = [];
  for (let i = 0; i < 20; i++) events.push(run(`uv run pytest services/api/tests/ingestion/test_stage_${i}.py -q`, i % 5 === 0 ? 'fail' : 'pass'));
  const diff = [
    ...Array.from({ length: files }, (_, i) => fileDiff(`services/api/src/ingestion/pipelines/stage_${i}/handlers/transform_record_${i}.py`, (i % 7) + 1)),
    ...['.github/workflows/ci.yml', 'uv.lock', 'services/api/migrations/0001_init.py', 'services/api/auth/tokens.py', 'CODEOWNERS'].map((p) => fileDiff(p)),
  ].join('\n');
  const decisions = [
    ...Array.from({ length: 6 }, (_, i) => confirmed(`Question ${i}: Option ${i}`)),
    ...Array.from({ length: 10 }, (_, i): Decision => ({ text: `Stated thing ${i}`, kind: 'decision', source: 'stated', confidence: 'stated' })),
  ];
  const log = buildLog(events, { ...meta, diff }, decisions);
  for (let i = 0; i < 5; i++) log.flags.push({ code: 'TEST_SKIPPED', severity: 'warn', file: `t/test_${i}.py`, detail: '`@pytest.mark.skip` added.', evidence: [] });
  return log;
}

const detailsOf = (md: string) => (md.includes('<details>') ? md.slice(md.indexOf('<details>')) : '');
const RISKY = '**Privileged or risky files:**';

/** Every visible pointer to the details has a block there to point at. */
function assertPointersResolve(md: string) {
  const details = detailsOf(md);
  if (/### Look here\n(?:- .*\n)*- \*…and \d+ more in the details below\.\*/.test(md)) assert.match(details, /#### More to look at/, md);
  if (/### Decisions you confirmed\n(?:- .*\n)*- \*…and \d+ more in the details below\.\*/.test(md)) assert.match(details, /#### More decisions you confirmed/, md);
  if (!md.includes('<details>')) assert.doesNotMatch(md, /in the details below/, md);
}

// Since the file list, passing checks and other repeats left the details, a
// 305-file PR fits the default budget whole; it used to need cutting.
test('a large PR fits the default budget without cuts, and every pointer resolves', () => {
  const md = render(bigLog(300));

  assert.ok(md.length <= 12_000, `body is ${md.length} chars`);
  assert.ok(visibleLines(md) <= VISIBLE_LINE_BUDGET, `visible part is ${visibleLines(md)} lines`);
  assert.ok(md.startsWith('<!-- pdl:start') && md.trimEnd().endsWith('<!-- pdl:end -->'));
  assert.ok(md.includes('<details>'));
  assertPointersResolve(md);
  assert.ok(md.includes(RISKY), 'the risky-files bullet is reachable');
  assert.doesNotMatch(md, /cut to fit the PR body/);
  assert.match(md, /### Scope/);
});

test('under budget pressure the reading aids go first, then the failed-checks table, then the pointer blocks', () => {
  const full = render(bigLog(300), { maxChars: 1_000_000 });
  assert.match(full, /#### Code and tests/);
  const sizes: string[] = [];
  for (let max = full.length; max > 1_500; max -= 40) sizes.push(render(bigLog(300), { maxChars: max }));

  const noAids = sizes.find((md) => md.includes('#### Checks that failed') && !md.includes('#### Code and tests'));
  assert.ok(noAids, 'a budget with the failed checks but no reading aids');
  const noChecks = sizes.find((md) => md.includes('#### More to look at') && !md.includes('#### Checks that failed'));
  assert.ok(noChecks, 'a budget with the pointer blocks but no checks table');
  assert.ok(!sizes.some((md) => md.includes('#### Code and tests') && !md.includes('#### Checks that failed')), 'aids never outlast the checks table');
});

test('every budget keeps the visible part within 15 lines, pointers honest, and blocks dropped in order', () => {
  for (let max = 300; max <= 14_000; max += 37) {
    const md = render(bigLog(300), { maxChars: max });
    const label = `maxChars ${max}`;
    assert.ok(md.length <= max, `${label}: body is ${md.length} chars`);
    assert.ok(md.trimEnd().endsWith('<!-- pdl:end -->'), label);
    assert.ok(visibleLines(md) <= VISIBLE_LINE_BUDGET, `${label}: visible part is ${visibleLines(md)} lines`);
    assertPointersResolve(md);
    const has = (h: string) => md.includes(`### ${h}\n`);
    if (has('Scope')) assert.ok(has('Decisions you confirmed') && has('Look here'), `${label}: Scope outlived a block it should not`);
    if (has('Decisions you confirmed')) assert.ok(has('Look here'), `${label}: Decisions outlived Look here`);
    if (md.length > 600) assert.match(md, /\*\*Checks \(last run\):\*\*/, `${label}: the verdict survives`);
    if (!has('Scope') && md.includes('### Look here')) assert.match(md, /the Scope(?: and [\w ]+)? blocks? (?:was|were) cut|the Scope, /, `${label}: the note names the Scope block`);
  }
});

test('a pointer whose block was cut says so rather than pointing at the details', () => {
  let md = '';
  for (let max = 4_000; max > 0 && (md === '' || md.includes('<details>')); max -= 10) md = render(bigLog(300), { maxChars: max });

  assert.ok(!md.includes('<details>') && md.includes('### Look here'), md);
  assert.doesNotMatch(md, /in the details below/);
  assert.match(md, /- \*…and \d+ more, cut to fit the PR body\.\*/);
});

test('the untruncated worst case fits the visible budget', () => {
  const log = bigLog(3);
  const md = render(log, { maxChars: 1_000_000 });

  assert.ok(!/cut to fit/.test(md), md);
  assert.match(md, /### Decisions you confirmed[\s\S]*### Look here[\s\S]*### Scope\n.*\n.*\n/);
  assert.ok(md.includes(RISKY));
  assert.ok(visibleLines(md) <= VISIBLE_LINE_BUDGET, `visible part is ${visibleLines(md)} lines:\n${md}`);
});

test('the summary counts the decisions a visible pointer sends the reader to', () => {
  const md = render(bigLog(3), { maxChars: 1_000_000 });

  assert.match(md, /<summary>[^<]*more decisions \(3\)[^<]*<\/summary>/);
});

test('counts are singular when there is one', () => {
  const md = render(buildLog([run('npm test')], { ...meta, diff: [fileDiff('src/a.ts', 1), fileDiff('src/b.ts', 2)].join('\n') }));

  assert.match(md, /· 2 files ·/);
  assert.match(render(buildLog([run('npm test', 'fail'), run('npm test')], meta)), /<summary>checks that failed \(1\)/);
});

// Reviewer shortcuts: a link from each flagged file to its diff, whether the
// changed test was new or existing, and which changed code no test change
// accompanies.
import { createHash } from 'node:crypto';

const PR_URL = 'https://github.com/o/r/pull/37';
const anchor = (path: string) => `${PR_URL}/files#diff-${createHash('sha256').update(path).digest('hex')}`;
const SHORTCUT_DIFF = [
  'diff --git a/tests/test_v.py b/tests/test_v.py', '--- a/tests/test_v.py', '+++ b/tests/test_v.py', '@@ -1,2 +1,4 @@',
  ' def test_old():', '     assert 1', '+def test_new():', '+    assert 2',
  'diff --git a/src/v.py b/src/v.py', '--- a/src/v.py', '+++ b/src/v.py', '@@ -1 +1 @@', '-a', '+b',
  'diff --git a/src/auth.py b/src/auth.py', '--- a/src/auth.py', '+++ b/src/auth.py', '@@ -1 +1 @@', '-a', '+b',
  'diff --git a/.github/workflows/ci.yml b/.github/workflows/ci.yml', '--- a/.github/workflows/ci.yml', '+++ b/.github/workflows/ci.yml', '@@ -1 +1 @@', '-a', '+b',
].join('\n');
const flagged = (name: string): TimelineEvent[] => [
  { kind: 'command', id: 'f1', at: '2026-10-15T03:12:00Z', command: 'uv run pytest -q tests/test_v.py', classification: 'test', outcome: 'fail', output: `FAILED tests/test_v.py::${name}` },
  { kind: 'edit', id: 'e1', at: '2026-10-15T03:12:30Z', path: '/repo/tests/test_v.py', assertionsBefore: 2, assertionsAfter: 1 },
  { kind: 'command', id: 'f2', at: '2026-10-15T03:13:00Z', command: 'uv run pytest -q tests/test_v.py', classification: 'test', outcome: 'pass' },
];

test('with the PR known, flagged and risky files link to their diff', () => {
  const md = render(buildLog(flagged('test_new'), { ...meta, diff: SHORTCUT_DIFF, prUrl: PR_URL }));

  assert.ok(md.includes(`[\`tests/test_v.py\`](${anchor('tests/test_v.py')})`), md);
  assert.ok(md.includes(`[\`.github/workflows/ci.yml\`](${anchor('.github/workflows/ci.yml')})`));
});

test('without the PR, files stay plain code spans', () => {
  const md = render(buildLog(flagged('test_new'), { ...meta, diff: SHORTCUT_DIFF }));

  assert.doesNotMatch(md, /files#diff-/);
});

test('a test-edit flag says whether the test was added by this PR or already existed', () => {
  assert.match(render(buildLog(flagged('test_new'), { ...meta, diff: SHORTCUT_DIFF })), /\*\*Test changed after it failed\*\* \*\(a test this PR added\)\*/);
  assert.match(render(buildLog(flagged('test_old'), { ...meta, diff: SHORTCUT_DIFF })), /\*\*Test changed after it failed\*\* \*\(an existing test\)\*/);
});

test('scope counts changed code with no matching test change, and the details pair code with tests', () => {
  const md = render(buildLog(flagged('test_new'), { ...meta, diff: SHORTCUT_DIFF }));

  assert.match(md, /### Scope\n.*\nTests: 1 file changed(?: .*)? · no matching test change: 1 source file\n/);
  assert.match(md, /#### Code and tests\n- `src\/v\.py` ↔ `tests\/test_v\.py`\n\nChanged with no matching test change: `src\/auth\.py`/);
});

test('when the failing tests are a mix, the label says which test is new and which existed', () => {
  const mixed: TimelineEvent[] = [
    { kind: 'command', id: 'm1', at: '2026-10-15T03:12:00Z', command: 'uv run pytest -q tests/test_v.py', classification: 'test', outcome: 'fail', output: 'FAILED tests/test_v.py::test_old\nFAILED tests/test_v.py::test_new' },
    { kind: 'edit', id: 'm2', at: '2026-10-15T03:12:30Z', path: '/repo/tests/test_v.py', assertionsBefore: 2, assertionsAfter: 1 },
    { kind: 'command', id: 'm3', at: '2026-10-15T03:13:00Z', command: 'uv run pytest -q tests/test_v.py', classification: 'test', outcome: 'pass' },
  ];

  assert.match(render(buildLog(mixed, { ...meta, diff: SHORTCUT_DIFF })),
    /\*\*Test changed after it failed\*\* \*\(`test_new` added by this PR; `test_old` existed\)\*/);
});

test('code changed after the last test run is said on the second line, beside never-run gaps', () => {
  const md = render(buildLog([
    run('npm test'),
    { kind: 'edit', id: 'x1', at: '2026-10-03T07:40:00Z', path: '/repo/src/settings.py' },
  ], { ...meta, diff: fileDiff('Dockerfile') }));

  assert.match(md, /\n\*\*Never run:\*\* docker build \(a Docker file changed\) · \*\*Changed after the last test run:\*\* `src\/settings\.py` \(\d+ (?:min|h) later\)\n/);
});

test('when stray writes are all the details hold, the summary says so', () => {
  const log = { ...buildLog([run('npm test')], { ...meta, diff: fileDiff('src/a.ts') }), strayWrites: ['notes/todo.md'], coverage: { pairs: [], untested: [] } };

  assert.match(render(log), /<summary>written but not in the diff \(1\)<\/summary>/);
});
