import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildLog } from '../src/render/build-log.ts';
import { render } from '../src/render/render.ts';
import type { TimelineEvent } from '../src/events/types.ts';

const meta = { repo: 'github.com/g/r', branch: 'feat/x', headSha: 'abc1234', generatedAt: '2026-09-26T10:00:00Z' };
const ran: TimelineEvent = { kind: 'command', id: 'c1', at: '2026-09-26T09:00:00Z', command: 'npm test', classification: 'test', outcome: 'pass' };

const diff = (path: string, body: string[]) => [
  `diff --git a/${path} b/${path}`, 'index 1..2 100644', `--- a/${path}`, `+++ b/${path}`, '@@ -1,3 +1,3 @@', ...body,
].join('\n');

test('flags from the pull request diff reach the log', () => {
  const log = buildLog([ran], { ...meta, diff: diff('src/sum.test.ts', ['-  expect(sum(1, 2)).toBe(3);']) });

  assert.ok(log.flags.some((f) => f.code === 'ASSERTIONS_REMOVED'));
});

test('no diff means no diff flags, so existing callers are unaffected', () => {
  assert.deepEqual(buildLog([ran], meta).flags, []);
});

test('a secret quoted in a changed expectation is redacted before publishing', () => {
  const log = buildLog([ran], {
    ...meta,
    diff: [
      diff('src/auth.ts', ['-  return k;', '+  return k.trim();']),
      diff('src/auth.test.ts', [
        "-  expect(key()).toBe('AKIAIOSFODNN7EXAMPLE');",
        "+  expect(key()).toBe('AKIAIOSFODNN7EXAMPLF');",
      ]),
    ].join('\n'),
  });

  assert.ok(log.flags.some((f) => f.code === 'EXPECTATION_LOOSENED'), 'expected the flag to fire');
  assert.ok(!JSON.stringify(log).includes('AKIAIOSFODNN7EXAMPL'), 'a secret survived into the log');
});

test('an informational flag is rendered as a note, not as an accusation', () => {
  const md = render(buildLog([ran], {
    ...meta,
    diff: [
      diff('src/sum.ts', ['-  return a + b;', '+  return a + b + 1;']),
      diff('src/sum.test.ts', ['-  expect(sum(1, 2)).toBe(3);', '+  expect(sum(1, 2)).toBe(4);']),
    ].join('\n'),
  }));

  const line = md.split('\n').find((l) => l.includes('EXPECTATION_LOOSENED'));
  assert.ok(line, 'flag missing from the markdown');
  assert.match(line, /\(note\)/);
});

test('a warning is not labelled as a note', () => {
  const md = render(buildLog([ran], { ...meta, diff: diff('src/sum.test.ts', ["+  it.only('adds', () => {"]) }));

  const line = md.split('\n').find((l) => l.includes('TEST_SKIPPED'));
  assert.ok(line && !line.includes('(note)'));
});

test('a diff removal in a file the timeline caught being edited after a failure escalates to a warning', () => {
  const at = (m: number) => `2026-09-26T09:0${m}:00Z`;
  const events: TimelineEvent[] = [
    { kind: 'command', id: 'c1', at: at(0), command: 'npm test', classification: 'test', outcome: 'fail', output: 'FAIL src/sum.test.ts' },
    { kind: 'edit', id: 'e1', at: at(1), path: 'src/sum.test.ts', assertionsBefore: 2, assertionsAfter: 1 },
    { kind: 'command', id: 'c2', at: at(2), command: 'npm test', classification: 'test', outcome: 'pass' },
  ];

  const log = buildLog(events, { ...meta, diff: diff('src/sum.test.ts', ['-  expect(sum(2, 2)).toBe(4);']) });

  const removed = log.flags.find((f) => f.code === 'ASSERTIONS_REMOVED');
  assert.equal(removed?.severity, 'warn');
});
