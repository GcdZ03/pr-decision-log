import { test } from 'node:test';
import assert from 'node:assert/strict';
import { splice } from '../src/publish/splice.ts';

const SECTION = '<!-- pdl:start v=1 -->\n## Decision log\n- ran `npm test`\n<!-- pdl:end -->';

test('appends to an existing body, preserving the author text', () => {
  const r = splice('Fixes the sync bug.', SECTION);
  assert.equal(r.changed, true);
  assert.ok(r.body.startsWith('Fixes the sync bug.'));
  assert.ok(r.body.includes('## Decision log'));
});

test('a second identical run is a no-op', () => {
  const first = splice('Body', SECTION);
  const second = splice(first.body, SECTION);
  assert.equal(second.changed, false);
  assert.equal(second.body, first.body);
});

test('changed content replaces in place, leaving one marker pair', () => {
  const first = splice('Body', SECTION);
  const updated = SECTION.replace('- ran `npm test`', '- ran `npm test`\n- ran `npm run build`');
  const second = splice(first.body, updated);

  assert.equal(second.changed, true);
  assert.equal((second.body.match(/pdl:start/g) ?? []).length, 1);
  assert.ok(second.body.startsWith('Body'));
  assert.ok(second.body.includes('npm run build'));
});

test('handles an empty body', () => {
  assert.ok(splice('', SECTION).body.startsWith('<!-- pdl:start'));
});

test('handles a null body from the GitHub API', () => {
  assert.ok(splice(null, SECTION).body.startsWith('<!-- pdl:start'));
});

test('round-trips shell metacharacters untouched', () => {
  const nasty = '<!-- pdl:start v=1 -->\n`$(whoami)` "quoted" C:\\Users\\x 100% ✓\n<!-- pdl:end -->';
  const r = splice('Body', nasty);
  assert.ok(r.body.includes('$(whoami)'));
  assert.ok(r.body.includes('C:\\Users\\x'));
  assert.ok(r.body.includes('✓'));
});

test('preserves author text written after the block', () => {
  const body = `Intro\n\n${SECTION}\n\nTrailing note from a human.`;
  const updated = SECTION.replace('npm test', 'npm test -- --coverage');
  const r = splice(body, updated);

  assert.ok(r.body.includes('Trailing note from a human.'));
  assert.ok(r.body.startsWith('Intro'));
});
