import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildLog } from '../src/render/build-log.ts';
import { render } from '../src/render/render.ts';
import type { TimelineEvent } from '../src/events/types.ts';
import type { Decision } from '../src/extract/decisions.ts';

const meta = { repo: 'github.com/g/r', branch: 'feat/x', headSha: 'abc1234', generatedAt: '2026-09-20T10:00:00Z' };
const cmd: TimelineEvent = { kind: 'command', id: 'c1', at: '2026-09-20T09:00:00Z', command: 'npm test', classification: 'test', outcome: 'pass' };

const dec = (over: Partial<Decision>): Decision => ({
  text: 'Retry at the job level because the client is shared.',
  kind: 'decision', source: 'stated', confidence: 'stated', at: '2026-09-20T09:00:00Z', ...over,
});

test('decisions reach the built log', () => {
  const log = buildLog([cmd], meta, [dec({})]);

  assert.equal(log.decisions.length, 1);
  assert.match(log.decisions[0]!.text, /Retry at the job level/);
});

test('a secret in a stated decision is redacted before it can be published', () => {
  const log = buildLog([cmd], meta, [dec({ text: 'Used the key AKIAIOSFODNN7EXAMPLE because it was handy.' })]);

  assert.ok(!JSON.stringify(log).includes('AKIAIOSFODNN7EXAMPLE'), 'a secret survived into the log');
});

test('claims are rendered after the facts', () => {
  const md = render(buildLog([cmd], meta, [dec({})]));

  assert.ok(md.indexOf('### Decisions') > md.indexOf('### Verification'), 'decisions came before the evidence');
});

test('a human-confirmed decision is labelled differently from a stated one', () => {
  const md = render(buildLog([cmd], meta, [
    dec({ text: 'Base: main', source: 'human-answer', confidence: 'confirmed_by_human' }),
  ]));

  assert.match(md, /confirmed by (?:a )?human/i);
});

test('assumptions render under their own heading', () => {
  const md = render(buildLog([cmd], meta, [dec({ kind: 'assumption', text: 'Assuming one session per PR.' })]));

  assert.match(md, /### Assumptions/);
  assert.ok(!md.includes('### Decisions'), 'an assumption leaked into Decisions');
});

test('open items render under their own heading', () => {
  const md = render(buildLog([cmd], meta, [dec({ kind: 'open_item', text: 'TODO: comment mode.' })]));

  assert.match(md, /### Open items/);
});

test('no decisions means no heading at all, which is the common case', () => {
  const md = render(buildLog([cmd], meta, []));

  assert.ok(!md.includes('### Decisions'));
  assert.ok(!md.includes('### Assumptions'));
  assert.ok(!md.includes('### Open items'));
  assert.ok(!md.toLowerCase().includes('none recorded'));
});

test('omitting decisions entirely still builds, so existing callers keep working', () => {
  assert.deepEqual(buildLog([cmd], meta).decisions, []);
});
