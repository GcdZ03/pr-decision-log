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
  const md = render(buildLog(many, meta), { maxChars: 2000 });

  assert.ok(md.length <= 2000, `budget exceeded: ${md.length}`);
  assert.match(md, /truncated/i);
  assert.ok(md.trimEnd().endsWith('<!-- pdl:end -->'), 'markers must survive truncation');
});

test('never renders raw command output', () => {
  const md = render(buildLog([cmd('c1', 'npm test', 'fail', 'secret-output-AKIAIOSFODNN7EXAMPLE')], meta));
  assert.ok(!md.includes('AKIAIOSFODNN7EXAMPLE'));
  assert.ok(!md.includes('secret-output'));
});
