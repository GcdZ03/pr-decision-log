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
        { question: 'Which base?', header: 'Base', options: [{ label: 'main' }, { label: 'develop' }] },
        { question: 'Squash?', header: 'Squash', options: [{ label: 'Yes' }, { label: 'No' }] },
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
  const withComma = { ...ASK, input: { questions: [{ ...ASK.input.questions[0], options: [{ label: 'Merge, then tag a release' }, { label: 'Keep PR open' }] }] } };
  const decisions = extractDecisions([
    assistant([withComma]),
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

// An answer is published only when it is one of the options the question
// offered. "Other" lets the human type anything, and that text was published
// verbatim: the one place the log could carry words the human typed.

test('a free-text answer is recorded as answered, without its text', () => {
  const decisions = extractDecisions([
    assistant([ASK]),
    answer('Your questions have been answered: "What would you like to do?"="ask Dana at acme-corp first, the prod DB is fragile". Continue.'),
  ]);

  assert.equal(decisions.length, 1);
  assert.equal(decisions[0]?.text, 'Integration: answered in the session');
  assert.doesNotMatch(JSON.stringify(decisions), /Dana|acme|prod DB/);
});

test('a multi-select answer of offered options is published', () => {
  const multi = { ...ASK, input: { questions: [{ question: 'Which checks?', header: 'Checks', multiSelect: true,
    options: [{ label: 'Lint' }, { label: 'Unit, fast' }, { label: 'E2E' }] }] } };

  const decisions = extractDecisions([
    assistant([multi]),
    answer('Your questions have been answered: "Which checks?"="Lint, Unit, fast, E2E". Continue.'),
  ]);

  assert.equal(decisions[0]?.text, 'Checks: Lint, Unit, fast, E2E');
});

test('a multi-select answer with a typed entry among the options is withheld whole', () => {
  const multi = { ...ASK, input: { questions: [{ question: 'Which checks?', header: 'Checks', multiSelect: true,
    options: [{ label: 'Lint' }, { label: 'E2E' }] }] } };

  const decisions = extractDecisions([
    assistant([multi]),
    answer('Your questions have been answered: "Which checks?"="Lint, my private staging check". Continue.'),
  ]);

  assert.equal(decisions[0]?.text, 'Checks: answered in the session');
});

test('a question with no offered options never publishes its answer', () => {
  const open = { ...ASK, input: { questions: [{ question: 'Anything else?', header: 'Notes' }] } };

  const decisions = extractDecisions([assistant([open]), answer('Your questions have been answered: "Anything else?"="no". Continue.')]);

  assert.equal(decisions[0]?.text, 'Notes: answered in the session');
});
