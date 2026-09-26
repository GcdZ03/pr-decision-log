import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync, readFileSync, writeFileSync, utimesSync } from 'node:fs';
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

test('purge removes every recorded session', () => {
  withStore((store) => {
    store.append('sess-1', cmd('a'));
    store.append('sess-2', cmd('b'));

    const removed = store.purge();

    assert.equal(removed, 2);
    assert.deepEqual(store.read('sess-1'), []);
    assert.deepEqual(store.read('sess-2'), []);
  });
});

test('purge on an empty store reports nothing removed rather than failing', () => {
  withStore((store) => {
    assert.equal(store.purge(), 0);
  });
});

test('sessionCount reports how many sessions have been recorded', () => {
  withStore((store) => {
    assert.equal(store.sessionCount(), 0);
    store.append('sess-1', cmd('a'));
    store.append('sess-1', cmd('b'));
    store.append('sess-2', cmd('c'));

    assert.equal(store.sessionCount(), 2);
  });
});

// Registering pdl in both user and project settings fires every hook twice,
// so the same tool call is appended twice. Reading back collapses it.

test('an event appended twice under the same id is read back once', () => {
  withStore((store) => {
    store.append('sess-1', cmd('a'));
    store.append('sess-1', cmd('a'));
    store.append('sess-1', cmd('b'));

    assert.deepEqual(store.read('sess-1').map((e) => e.id), ['a', 'b']);
  });
});

test('events without an id are never collapsed into each other', () => {
  withStore((store) => {
    store.append('sess-1', cmd(''));
    store.append('sess-1', cmd(''));

    assert.equal(store.read('sess-1').length, 2);
  });
});

// Retention: sessions hold raw local command output, so they must not
// accumulate forever.

function age(root: string, sessionId: string, days: number) {
  const t = (Date.now() - days * 86_400_000) / 1000;
  utimesSync(join(root, 'events', `${sessionId}.jsonl`), t, t);
}

test('prune deletes sessions older than the retention window and keeps newer ones', () => {
  withStore((store, root) => {
    store.append('old', cmd('a'));
    store.append('new', cmd('b'));
    age(root, 'old', 40);
    age(root, 'new', 2);

    assert.equal(store.prune(30, Date.now()), 1);
    assert.deepEqual(store.read('old'), []);
    assert.equal(store.read('new').length, 1);
  });
});

test('a retention of zero keeps everything', () => {
  withStore((store, root) => {
    store.append('old', cmd('a'));
    age(root, 'old', 400);

    assert.equal(store.prune(0, Date.now()), 0);
    assert.equal(store.read('old').length, 1);
  });
});

test('pruneIfDue runs at most once a day, so the Stop hook is not scanning on every turn', () => {
  withStore((store, root) => {
    store.append('old', cmd('a'));
    age(root, 'old', 40);
    const now = Date.now();

    assert.equal(store.pruneIfDue(30, now), 1);
    store.append('old2', cmd('b'));
    age(root, 'old2', 40);
    assert.equal(store.pruneIfDue(30, now + 3_600_000), 0, 'pruned again within the day');
    assert.equal(store.pruneIfDue(30, now + 2 * 86_400_000), 1);
  });
});
