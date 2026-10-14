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
  assert.match(md, /Auto-fixes: `uv run ruff check --fix \.`/);
});

test('an interrupted last run is never a tick', () => {
  const md = render(buildLog([run('uv run pytest -q', 'interrupted')], meta));

  assert.match(md, /pytest ✗ \(interrupted\)/);
});

test('never-run gaps and the intent pointer share the second line', () => {
  const md = render(buildLog([run('npm test')], { ...meta, diff: fileDiff('Dockerfile') }));

  assert.match(md, /\n\*\*Never run:\*\* docker build \(a Docker file changed\) · Intent: see the PR description\.\n/);
});

test('risky files are one bullet under Look here, grouped by category', () => {
  const md = render(buildLog([run('npm test')], { ...meta, diff: [fileDiff('.github/workflows/ci.yml'), fileDiff('uv.lock')].join('\n') }));

  assert.match(md, /- \*\*Privileged or risky files:\*\* ci and automation: `\.github\/workflows\/ci\.yml` · dependencies: `uv\.lock`/);
});

test('scope gives size, spread, tests and the largest files', () => {
  const md = render(buildLog([run('npm test')], {
    ...meta, diff: [fileDiff('services/api/src/parse.py', 40, 'added'), fileDiff('services/api/tests/test_parse.py', 20, 'added'), fileDiff('README.md', 2)].join('\n'),
  }));

  assert.match(md, /### Scope\n\+62 −0 lines · 3 files \(2 added\) · services\/api · \(root\)\nTests: 1 file changed \(1 added\) · Largest: `services\/api\/src\/parse\.py` \(40 lines\), `services\/api\/tests\/test_parse\.py` \(20 lines\)\n/);
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

test('the details name what they hold, with counts', () => {
  const md = render(buildLog([run('npm test'), run('npm test'), run('ls'), run('grep -n x src')], { ...meta, diff: fileDiff('src/a.ts') }));

  assert.match(md, /<details><summary>every check \(1 distinct, 2 runs\) · every file \(1\) · 2 other commands<\/summary>/);
  assert.match(md, /\| `npm test` \| 2 \| 0 \| pass \| \d\d:\d\d \|/);
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
  const md = render(buildLog([run('npm test')], { ...meta, diff: Array.from({ length: 80 }, (_, i) => fileDiff(`src/f${i}.ts`)).join('\n') }), { maxChars: 900 });

  assert.ok(md.length <= 900, `body is ${md.length} chars`);
  assert.match(md, /truncated/i);
  assert.match(md, /\*\*Checks \(last run\):\*\*/, 'the verdict survives');
  assert.ok(md.trimEnd().endsWith('<!-- pdl:end -->'));
});

test('a path with a pipe or a backtick cannot break the table or the code span', () => {
  const md = render(buildLog([run('npm test')], { ...meta, diff: [fileDiff('src/we|ird.ts'), fileDiff('src/tick`name.ts')].join('\n') }));

  assert.match(md, /- `src\/we\\\|ird\.ts`|- `src\/we\|ird\.ts`/);
  assert.match(md, /- ``src\/tick`name\.ts``/);
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
