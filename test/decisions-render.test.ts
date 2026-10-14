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

test('confirmed decisions are visible, and stated claims are inside the details', () => {
  const md = render(buildLog([cmd], meta, [
    dec({ text: 'Base: main', source: 'human-answer', confidence: 'confirmed_by_human' }),
    dec({}),
  ]));

  assert.match(md, /### Decisions you confirmed\n- Base: main\n/);
  assert.ok(md.indexOf('#### Stated by the agent') > md.indexOf('<details>'), 'stated claims escaped the details');
  assert.match(md, /- Retry at the job level because the client is shared\. \*\(stated\)\*/);
});

test('assumptions and open items are labelled inside the stated claims', () => {
  const md = render(buildLog([cmd], meta, [dec({ kind: 'assumption', text: 'Assuming one session per PR.' }), dec({ kind: 'open_item', text: 'TODO: comment mode.' })]));

  assert.match(md, /- Assumption: Assuming one session per PR\. \*\(stated\)\*/);
  assert.match(md, /- Open item: TODO: comment mode\. \*\(stated\)\*/);
});

test('no decisions means no decision headings at all, which is the common case', () => {
  const md = render(buildLog([cmd], meta, []));

  assert.doesNotMatch(md, /Decisions you confirmed|Stated by the agent|none recorded/i);
});

test('omitting decisions entirely still builds, so existing callers keep working', () => {
  assert.deepEqual(buildLog([cmd], meta).decisions, []);
});
