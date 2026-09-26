import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractDecisions } from '../src/extract/decisions.ts';
import type { TranscriptEntry } from '../src/extract/transcript.ts';

const at = '2026-09-20T09:00:00Z';
const EDIT = { type: 'tool_use', id: 'tu-e', name: 'Edit', input: { file_path: '/r/a.ts' } };

const turn = (text: string, tool: unknown = EDIT, req = 'req_1'): TranscriptEntry => ({
  type: 'assistant', timestamp: at, requestId: req,
  message: { role: 'assistant', content: [{ type: 'text', text }, tool] },
});

const stated = (entries: TranscriptEntry[]) => extractDecisions(entries).filter((d) => d.source === 'stated');

test('a rationale marker before an edit becomes a stated decision', () => {
  const d = stated([turn('I am using a Map here because lookup is on the hot path.')]);

  assert.equal(d.length, 1);
  assert.equal(d[0]?.confidence, 'stated');
  assert.match(d[0]?.text ?? '', /because lookup is on the hot path/);
});

test('only the sentence carrying the marker is kept, not the whole block', () => {
  const d = stated([turn('Let me start on the parser. I chose a hand-written lexer because regex backtracks. Running tests now.')]);

  assert.equal(d.length, 1);
  assert.equal(d[0]?.text, 'I chose a hand-written lexer because regex backtracks.');
});

test('an assumption marker is classified as an assumption', () => {
  const d = stated([turn('Assuming the store is always on local disk, no locking is needed.')]);

  assert.equal(d[0]?.kind, 'assumption');
});

test('an open-item marker is classified as an open item', () => {
  const d = stated([turn('TODO: the comment publisher is still unimplemented.')]);

  assert.equal(d[0]?.kind, 'open_item');
});

test('text with no marker yields nothing, which is the common case', () => {
  assert.deepEqual(stated([turn('Now let me run the tests.')]), []);
});

test('text not followed by an edit or command yields nothing', () => {
  const noTool: TranscriptEntry = {
    type: 'assistant', timestamp: at, requestId: 'req_1',
    message: { role: 'assistant', content: [{ type: 'text', text: 'I chose X because Y.' }] },
  };

  assert.deepEqual(stated([noTool]), []);
});

test('text before a read-only tool yields nothing, because nothing was changed', () => {
  const read = { type: 'tool_use', id: 'tu-r', name: 'Read', input: { file_path: '/r/a.ts' } };

  assert.deepEqual(stated([turn('I chose X because Y.', read)]), []);
});

test('the same rationale repeated across turns is recorded once', () => {
  const d = stated([
    turn('I chose a Map because lookup is hot.', EDIT, 'req_1'),
    turn('I chose a Map because lookup is hot.', EDIT, 'req_2'),
  ]);

  assert.equal(d.length, 1);
});

test('a sentence is truncated rather than publishing a paragraph', () => {
  const long = `I chose this because ${'x'.repeat(600)}.`;

  const d = stated([turn(long)]);

  assert.ok((d[0]?.text.length ?? 0) <= 320, `too long: ${d[0]?.text.length}`);
  assert.match(d[0]?.text ?? '', /…$/);
});

test('a marker inside a word does not count', () => {
  assert.deepEqual(stated([turn('The rechosen approach works.')]), []);
});

test('rationale in the preceding entry of the same turn is still linked to the edit', () => {
  const textOnly: TranscriptEntry = {
    type: 'assistant', timestamp: at, requestId: 'req_1',
    message: { role: 'assistant', content: [{ type: 'text', text: 'I chose a Map because lookup is hot.' }] },
  };
  const toolOnly: TranscriptEntry = {
    type: 'assistant', timestamp: at, requestId: 'req_1',
    message: { role: 'assistant', content: [EDIT] },
  };

  const d = stated([textOnly, toolOnly]);

  assert.equal(d.length, 1, 'rationale split across entries in one turn was missed');
  assert.match(d[0]?.text ?? '', /because lookup is hot/);
});

test('rationale from a different turn is not linked to a later edit', () => {
  const textOnly: TranscriptEntry = {
    type: 'assistant', timestamp: at, requestId: 'req_1',
    message: { role: 'assistant', content: [{ type: 'text', text: 'I chose a Map because lookup is hot.' }] },
  };
  const laterEdit: TranscriptEntry = {
    type: 'assistant', timestamp: at, requestId: 'req_2',
    message: { role: 'assistant', content: [EDIT] },
  };

  assert.deepEqual(stated([textOnly, laterEdit]), []);
});

test('a recommendation hint from the option label is not part of the decision', () => {
  const ask = {
    type: 'tool_use', id: 'tu-ask', name: 'AskUserQuestion',
    input: { questions: [{ question: 'Which version?', header: 'Version', options: [] }] },
  };
  const entries: TranscriptEntry[] = [
    { type: 'assistant', timestamp: at, message: { role: 'assistant', content: [ask] } },
    { type: 'user', timestamp: at, message: { role: 'user', content: [{
      type: 'tool_result', tool_use_id: 'tu-ask',
      content: 'Your questions have been answered: "Which version?"="v0.6.0 (Recommended)". Continue.',
    }] } },
  ];

  assert.equal(extractDecisions(entries)[0]?.text, 'Version: v0.6.0');
});

// Fixtures below are real sentences pulled from the author's own transcripts
// during a yield measurement. Each carries a rationale marker but describes
// the agent's own workflow, not a choice about the code.
const NARRATION = [
  'Before writing rule 2, let me check whether I can verify the real shape rather than guess at it.',
  "I've just verified that against the GitHub API rather than my own claim.",
  'Let me verify the shelf claim before explaining it, rather than asserting from memory:',
  'Verifying with a real build rather than trusting either signal:',
  'First, verifying two things I asserted rather than checked:',
  'Red for the right reason — the event is recorded because no kill switch exists.',
  'Let me check the remaining assumptions.',
];

for (const sentence of NARRATION) {
  test(`process narration is not a decision: ${sentence.slice(0, 45)}...`, () => {
    assert.deepEqual(stated([turn(sentence)]), [], `kept narration: ${sentence}`);
  });
}

// These are real too, and are genuine decisions. They must survive the filter.
const REAL = [
  "Rather than persisting the PR number, I'll re-derive it from the current branch, which removes a state file entirely.",
  'The design forbids rendering raw commands into a pull request body precisely because they can carry secrets.',
  'But a design spec already exists, so I will validate and extend it rather than invent a new one.',
  'Sharing turns out not to be load-bearing, so the assertion goes rather than gets propped up.',
];

for (const sentence of REAL) {
  test(`a genuine decision survives the filter: ${sentence.slice(0, 45)}...`, () => {
    assert.equal(stated([turn(sentence)]).length, 1, `dropped a real decision: ${sentence}`);
  });
}

test('markdown emphasis is stripped, because a PR body should not show raw asterisks', () => {
  const d = stated([turn('I chose **the windowed detector** because the naive one over-counted.')]);

  assert.equal(d[0]?.text, 'I chose the windowed detector because the naive one over-counted.');
});

test('someone else having assumed something is not the agent stating an assumption', () => {
  const d = stated([turn('Rule 1 is stronger than the spike assumed, because questions are answered by a person.')]);

  assert.equal(d[0]?.kind, 'decision', 'past-tense report was misread as an assumption');
});

test('the agent stating its own assumption is still classified as one', () => {
  const d = stated([turn('Assuming the store is local, no locking is needed.')]);

  assert.equal(d[0]?.kind, 'assumption');
});

test('an explicit assumption in the first person is classified as one', () => {
  const d = stated([turn('I assume the branch is always resolvable, so no fallback is needed.')]);

  assert.equal(d[0]?.kind, 'assumption');
});

test('a configured decision marker is recognised', () => {
  const d = extractDecisions([turn('Decision: keep the store outside the repo.')], { extraMarkers: ['Decision:'] }).filter((x) => x.source === 'stated');

  assert.equal(d.length, 1);
  assert.equal(d[0]?.kind, 'decision');
});

test('without the configured marker the same sentence is not a decision', () => {
  assert.deepEqual(stated([turn('Decision: keep the store outside the repo.')]), []);
});

test('a configured word marker matches whole words only', () => {
  const d = extractDecisions([turn('The rejectedness metric was fine.')], { extraMarkers: ['Rejected'] }).filter((x) => x.source === 'stated');

  assert.deepEqual(d, []);
});
