import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractDecisions } from '../src/extract/decisions.ts';
import type { TranscriptEntry } from '../src/extract/transcript.ts';

const at = '2026-09-20T09:00:00Z';

const assistant = (content: unknown[], over: Record<string, unknown> = {}): TranscriptEntry => ({
  type: 'assistant', timestamp: at, requestId: 'req_1',
  message: { role: 'assistant', content }, ...over,
});
const user = (content: unknown[]): TranscriptEntry => ({
  type: 'user', timestamp: at, message: { role: 'user', content },
});

const ASK = {
  type: 'tool_use', id: 'tu-ask', name: 'AskUserQuestion',
  input: {
    questions: [{
      question: 'What would you like to do?',
      header: 'Integration',
      options: [{ label: 'Merge to main locally' }, { label: 'Keep PR open' }],
    }],
  },
};

const answer = (text: string) => user([{ type: 'tool_result', tool_use_id: 'tu-ask', content: text }]);

test('a question the human answered becomes a confirmed decision', () => {
  const decisions = extractDecisions([
    assistant([ASK]),
    answer('Your questions have been answered: "What would you like to do?"="Merge to main locally". You can now continue.'),
  ]);

  assert.equal(decisions.length, 1);
  assert.equal(decisions[0]?.confidence, 'confirmed_by_human');
  assert.match(decisions[0]?.text ?? '', /Integration/);
  assert.match(decisions[0]?.text ?? '', /Merge to main locally/);
});

test('an unanswered question yields nothing, because nothing was decided', () => {
  assert.deepEqual(extractDecisions([assistant([ASK])]), []);
});

test('two questions answered in one call become two decisions', () => {
  const two = {
    ...ASK,
    input: {
      questions: [
        { question: 'Which base?', header: 'Base', options: [] },
        { question: 'Squash?', header: 'Squash', options: [] },
      ],
    },
  };

  const decisions = extractDecisions([
    assistant([two]),
    answer('Your questions have been answered: "Which base?"="main", "Squash?"="No". You can now continue.'),
  ]);

  assert.equal(decisions.length, 2);
  assert.deepEqual(decisions.map((d) => d.text), ['Base: main', 'Squash: No']);
});

test('an answer containing a comma is not split into two decisions', () => {
  const decisions = extractDecisions([
    assistant([ASK]),
    answer('Your questions have been answered: "What would you like to do?"="Merge, then tag a release". Continue.'),
  ]);

  assert.equal(decisions.length, 1);
  assert.equal(decisions[0]?.text, 'Integration: Merge, then tag a release');
});

test('the decision carries the time it was confirmed', () => {
  const decisions = extractDecisions([
    assistant([ASK]),
    answer('Your questions have been answered: "What would you like to do?"="Keep PR open". Continue.'),
  ]);

  assert.equal(decisions[0]?.at, at);
});

test('a transcript with no questions yields nothing', () => {
  assert.deepEqual(extractDecisions([assistant([{ type: 'text', text: 'just talking' }])]), []);
});
