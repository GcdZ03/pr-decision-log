import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readTranscript, toolUses, assistantText } from '../src/extract/transcript.ts';

function withTranscript(lines: unknown[], fn: (path: string) => void) {
  const dir = mkdtempSync(join(tmpdir(), 'pdl-tx-'));
  const path = join(dir, 'session.jsonl');
  writeFileSync(path, lines.map((l) => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n'));
  try { fn(path); } finally { rmSync(dir, { recursive: true, force: true }); }
}

const assistant = (content: unknown[], over: Record<string, unknown> = {}) => ({
  type: 'assistant', timestamp: '2026-09-20T09:00:00Z', requestId: 'req_1', uuid: 'u1',
  message: { role: 'assistant', content }, ...over,
});

test('reads every entry from a transcript file', () => {
  withTranscript([assistant([{ type: 'text', text: 'hello' }]), assistant([{ type: 'text', text: 'world' }])], (p) => {
    assert.equal(readTranscript(p).length, 2);
  });
});

test('a torn trailing line is skipped rather than failing the read', () => {
  withTranscript([assistant([{ type: 'text', text: 'hello' }]), '{"type":"assist'], (p) => {
    assert.equal(readTranscript(p).length, 1);
  });
});

test('a missing transcript reads as empty, because publishing must not depend on it', () => {
  assert.deepEqual(readTranscript('/nonexistent/session.jsonl'), []);
});

test('sidechain entries are excluded, because a subagent is not this session', () => {
  withTranscript([
    assistant([{ type: 'text', text: 'main' }]),
    assistant([{ type: 'text', text: 'sub' }], { isSidechain: true }),
  ], (p) => {
    assert.equal(readTranscript(p).length, 1);
    assert.equal(assistantText(readTranscript(p)[0]!), 'main');
  });
});

test('tool uses are extracted with their name and input', () => {
  withTranscript([assistant([
    { type: 'text', text: 'running' },
    { type: 'tool_use', id: 'tu-1', name: 'Bash', input: { command: 'npm test' } },
  ])], (p) => {
    const uses = toolUses(readTranscript(p)[0]!);
    assert.equal(uses.length, 1);
    assert.equal(uses[0]?.name, 'Bash');
    assert.deepEqual(uses[0]?.input, { command: 'npm test' });
  });
});

test('assistant text joins multiple text blocks and ignores tool uses', () => {
  withTranscript([assistant([
    { type: 'text', text: 'first' },
    { type: 'tool_use', id: 'tu-1', name: 'Bash', input: {} },
    { type: 'text', text: 'second' },
  ])], (p) => {
    assert.equal(assistantText(readTranscript(p)[0]!), 'first\nsecond');
  });
});

test('a thinking block contributes no text, because they are stored empty', () => {
  withTranscript([assistant([{ type: 'thinking', thinking: '' }])], (p) => {
    assert.equal(assistantText(readTranscript(p)[0]!), '');
  });
});
