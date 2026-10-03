import { test } from 'node:test';
import assert from 'node:assert/strict';
import { render } from '../src/render/render.ts';
import { buildLog } from '../src/render/build-log.ts';
import type { TimelineEvent } from '../src/events/types.ts';

const meta = { repo: 'github.com/g/r', branch: 'feat/x', headSha: 'abc1234', generatedAt: '2026-09-19T10:00:00Z' };
const cmd = (id: string, command: string, outcome: 'pass' | 'fail', output = ''): TimelineEvent =>
  ({ kind: 'command', id, at: '2026-09-19T09:00:00Z', command, classification: 'test', outcome, output });
const edit = (id: string, path: string, b?: number, a?: number): TimelineEvent =>
  ({ kind: 'edit', id, at: '2026-09-19T09:05:00Z', path, assertionsBefore: b, assertionsAfter: a });

test('facts come before claims: flags, then verification, then changes', () => {
  const md = render(buildLog([
    cmd('c1', 'npm test', 'fail', 'FAIL src/a.test.ts'),
    edit('e1', 'src/a.test.ts', 5, 2),
    cmd('c2', 'npm test', 'pass'),
  ], meta));

  const iFlags = md.indexOf('### Flags');
  const iVerify = md.indexOf('### Verification');
  const iChanges = md.indexOf('### Changes');
  assert.ok(iFlags > -1 && iVerify > iFlags && iChanges > iVerify, `order wrong:\n${md}`);
});

test('suppresses empty sections instead of writing "none recorded"', () => {
  const md = render(buildLog([cmd('c1', 'npm test', 'pass')], meta));

  assert.ok(!md.includes('### Flags'), 'empty Flags section should be absent');
  assert.ok(!md.includes('### Decisions'), 'empty Decisions section should be absent');
  assert.ok(!md.toLowerCase().includes('none recorded'));
  assert.ok(md.includes('### Verification'));
});

test('renders the verification table with outcomes', () => {
  const md = render(buildLog([cmd('c1', 'npm test', 'fail'), cmd('c2', 'npm test', 'pass')], meta));
  assert.match(md, /\|\s*fail\s*\|/);
  assert.match(md, /\|\s*pass\s*\|/);
});

test('is wrapped in stable markers so it can be replaced', () => {
  const md = render(buildLog([], meta));
  assert.ok(md.startsWith('<!-- pdl:start'));
  assert.ok(md.trimEnd().endsWith('<!-- pdl:end -->'));
});

test('stays within the byte budget, with a truncation note when trimmed', () => {
  const many: TimelineEvent[] = Array.from({ length: 400 }, (_, i) => edit(`e${i}`, `src/file-${i}.ts`));
  const md = render(buildLog(many, meta), { maxChars: 800 });

  assert.ok(md.length <= 800, `budget exceeded: ${md.length}`);
  assert.match(md, /truncated/i);
  assert.ok(md.trimEnd().endsWith('<!-- pdl:end -->'), 'markers must survive truncation');
});

test('never renders raw command output', () => {
  const md = render(buildLog([cmd('c1', 'npm test', 'fail', 'secret-output-AKIAIOSFODNN7EXAMPLE')], meta));
  assert.ok(!md.includes('AKIAIOSFODNN7EXAMPLE'));
  assert.ok(!md.includes('secret-output'));
});

test('a piped command renders as its runner alone, so the table keeps its cells', () => {
  const markdown = render(buildLog([cmd('c1', 'npm test 2>&1 | tail -40', 'pass')], meta));

  const row = markdown.split('\n').find((l) => l.includes('`npm test`'));
  assert.ok(row, 'verification row missing');
  const delimiters = (row.match(/(?<!\\)\|/g) ?? []).length;
  assert.equal(delimiters, 4, `row has the wrong cell count: ${row}`);
  assert.doesNotMatch(row, /tail/);
});

test('a pipe outside a table is left alone, because a list needs no escape', () => {
  const markdown = render(buildLog([edit('e1', 'src/we|ird.ts', 2, 2)], meta));

  const row = markdown.split('\n').find((l) => l.includes('ird.ts'));
  assert.ok(row, 'changes row missing');
  assert.ok(row.includes('src/we|ird.ts'), `a list item should not be escaped: ${row}`);
});

test('a log built from several sessions says so', () => {
  const md = render(buildLog([cmd('c1', 'npm test', 'pass')], { ...meta, sessions: ['aaaaaaaa-1', 'bbbbbbbb-2'] }));

  assert.match(md, /2 agent sessions/);
});

test('a single-session log keeps the singular wording', () => {
  const md = render(buildLog([cmd('c1', 'npm test', 'pass')], { ...meta, sessions: ['aaaaaaaa-1'] }));

  assert.match(md, /the agent session/);
});

const other = (id: string, command: string): TimelineEvent =>
  ({ kind: 'command', id, at: '2026-09-19T09:01:00Z', command, classification: 'other', outcome: 'pass' });

test('commands left out of the table are counted under it', () => {
  const md = render(buildLog([cmd('c1', 'npm test', 'pass'), other('o1', 'grep -n x src'), other('o2', 'ls')], meta));

  assert.match(md, /\| `npm test` \| pass \|\n\n\*2 other commands \(file writes, searches, git\) not listed\.\*/);
  assert.doesNotMatch(md, /grep|`ls`/);
});

test('a session that ran only other commands says so instead of an empty table', () => {
  const md = render(buildLog([other('o1', 'ls')], meta));

  assert.doesNotMatch(md, /\| When \|/);
  assert.match(md, /### Verification \(recorded\)\n\nNo test, build or lint run was recorded\. 1 other command not listed\./);
});

const DIFF = [
  'diff --git a/src/api.ts b/src/api.ts', '--- a/src/api.ts', '+++ b/src/api.ts', '@@ -1 +1 @@', '-a', '+b',
  'diff --git a/src/api.test.ts b/src/api.test.ts', 'new file mode 100644', '--- /dev/null', '+++ b/src/api.test.ts', '@@ -0,0 +1 @@', '+x',
].join('\n');

test('changes from the diff render with their status, and edit counts only where the agent used its edit tools', () => {
  const md = render(buildLog([edit('e1', 'src/api.ts'), edit('e2', 'src/wip.ts')], { ...meta, diff: DIFF }));

  assert.match(md, /### Changes\n- `src\/api\.ts` - 1 edit\n- `src\/api\.test\.ts` \(added, test\)\n- `src\/wip\.ts` \(not in diff\) - 1 edit\n/);
});

test('a long change list is capped with a count of the rest', () => {
  const diff = Array.from({ length: 45 }, (_, i) => `diff --git a/f${i}.ts b/f${i}.ts\n--- a/f${i}.ts\n+++ b/f${i}.ts\n@@ -1 +1 @@\n-a\n+b`).join('\n');
  const md = render(buildLog([], { ...meta, diff }));

  assert.equal((md.match(/^- `f\d+\.ts`/gm) ?? []).length, 30);
  assert.match(md, /\*and 15 more files\.\*/);
});
