import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventStore } from '../src/events/store.ts';
import type { TimelineEvent } from '../src/events/types.ts';

const cmd = (id: string): TimelineEvent => ({
  kind: 'command', id, at: '2026-09-19T09:00:00Z', command: 'npm test',
  classification: 'test', outcome: 'pass',
});

function withStore(fn: (s: EventStore, root: string) => void) {
  const root = mkdtempSync(join(tmpdir(), 'pdl-test-'));
  try { fn(new EventStore(root), root); } finally { rmSync(root, { recursive: true, force: true }); }
}

test('appends and reads back events for a session', () => {
  withStore((store) => {
    store.append('sess-1', cmd('a'));
    store.append('sess-1', cmd('b'));

    const events = store.read('sess-1');
    assert.equal(events.length, 2);
    assert.deepEqual(events.map((e) => e.id), ['a', 'b']);
  });
});

test('sessions are isolated from each other', () => {
  withStore((store) => {
    store.append('sess-1', cmd('a'));
    store.append('sess-2', cmd('b'));

    assert.deepEqual(store.read('sess-1').map((e) => e.id), ['a']);
    assert.deepEqual(store.read('sess-2').map((e) => e.id), ['b']);
  });
});

test('reading an unknown session returns empty, not an error', () => {
  withStore((store) => {
    assert.deepEqual(store.read('never-seen'), []);
  });
});

test('the store directory is created private (0700)', () => {
  withStore((store, root) => {
    store.append('sess-1', cmd('a'));
    // Events can contain paths and command text; other users must not read them.
    assert.equal(statSync(join(root, 'events')).mode & 0o777, 0o700);
  });
});

test('a truncated trailing line is skipped rather than throwing', () => {
  withStore((store, root) => {
    store.append('sess-1', cmd('a'));
    const file = join(root, 'events', 'sess-1.jsonl');
    writeFileSync(file, readFileSync(file, 'utf8') + '{"kind":"comm');

    // A hook killed mid-write must not break every later read.
    assert.deepEqual(store.read('sess-1').map((e) => e.id), ['a']);
  });
});

test('a session id that looks like a path traversal cannot escape the store', () => {
  withStore((store, root) => {
    store.append('../../escape', cmd('a'));
    // The file must land inside the store, whatever the id looked like.
    assert.equal(store.read('../../escape').length, 1);
    assert.throws(() => statSync(join(root, '..', '..', 'escape.jsonl')));
  });
});
