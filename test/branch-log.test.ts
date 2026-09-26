import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventStore } from '../src/events/store.ts';
import { selectForBranch, sessionsForBranch, eventsForBranch, summariseSessions, type Turn } from '../src/events/branch.ts';
import type { TimelineEvent } from '../src/events/types.ts';

const at = (m: number) => `2026-09-26T10:${String(m).padStart(2, '0')}:00.000Z`;
const ev = (id: string, m: number): TimelineEvent => ({
  kind: 'command', id, at: at(m), command: 'npm test', classification: 'test', outcome: 'pass',
});
const turn = (session: string, branch: string, m: number, repo = '/r'): Turn => ({ session, repo, branch, at: at(m) });

function withStore(fn: (s: EventStore) => void) {
  const root = mkdtempSync(join(tmpdir(), 'pdl-branch-'));
  try { fn(new EventStore(root)); } finally { rmSync(root, { recursive: true, force: true }); }
}

test('an event belongs to the turn it happened in', () => {
  const turns = [turn('s', 'main', 5), turn('s', 'feat', 10)];

  assert.deepEqual(selectForBranch([ev('a', 3), ev('b', 7)], turns, 'feat').map((e) => e.id), ['b']);
  assert.deepEqual(selectForBranch([ev('a', 3), ev('b', 7)], turns, 'main').map((e) => e.id), ['a']);
});

test('events after the last recorded turn go with that turn', () => {
  // `pdl build` between turns: the in-progress turn has no record yet.
  assert.deepEqual(selectForBranch([ev('a', 12)], [turn('s', 'feat', 10)], 'feat').map((e) => e.id), ['a']);
});

test('a session with no recorded turns contributes nothing, because its branch is unknown', () => {
  assert.deepEqual(selectForBranch([ev('a', 1)], [], 'feat'), []);
});

test('sessions for a branch are every session that had a turn on it, in that repo', () => {
  const turns = [turn('s1', 'feat', 1), turn('s2', 'main', 2), turn('s3', 'feat', 3), turn('s4', 'feat', 4, '/other')];

  assert.deepEqual(sessionsForBranch(turns, '/r', 'feat'), ['s1', 's3']);
});

test('the store records turns and reads them back', () => {
  withStore((store) => {
    store.appendTurn(turn('s1', 'feat', 1));
    store.appendTurn(turn('s1', 'feat', 2));

    assert.equal(store.turns().length, 2);
  });
});

test('two sessions on one branch merge into one timeline, in time order', () => {
  withStore((store) => {
    store.append('s1', ev('first', 1));
    store.append('s1', ev('third', 5));
    store.appendTurn(turn('s1', 'feat', 6));
    store.append('s2', ev('second', 3));
    store.appendTurn(turn('s2', 'feat', 4));

    const merged = eventsForBranch(store, '/r', 'feat');

    assert.deepEqual(merged.events.map((e) => e.id), ['first', 'second', 'third']);
    assert.deepEqual(merged.sessions, ['s1', 's2']);
  });
});

test("another branch's session is left out of the merge", () => {
  withStore((store) => {
    store.append('s1', ev('mine', 1));
    store.appendTurn(turn('s1', 'feat', 2));
    store.append('s2', ev('theirs', 1));
    store.appendTurn(turn('s2', 'other', 2));

    assert.deepEqual(eventsForBranch(store, '/r', 'feat').events.map((e) => e.id), ['mine']);
  });
});

test('a session that switched branches mid-way splits between them', () => {
  withStore((store) => {
    store.append('s', ev('on-main', 1));
    store.appendTurn(turn('s', 'main', 2));
    store.append('s', ev('on-feat', 3));
    store.appendTurn(turn('s', 'feat', 4));

    assert.deepEqual(eventsForBranch(store, '/r', 'feat').events.map((e) => e.id), ['on-feat']);
    assert.deepEqual(eventsForBranch(store, '/r', 'main').events.map((e) => e.id), ['on-main']);
  });
});

test('turn records past retention are pruned with their sessions', () => {
  withStore((store) => {
    const old = new Date(Date.now() - 40 * 86_400_000).toISOString();
    store.appendTurn({ session: 'old', repo: '/r', branch: 'feat', at: old });
    store.appendTurn({ session: 'new', repo: '/r', branch: 'feat', at: new Date().toISOString() });

    store.prune(30, Date.now());

    assert.deepEqual(store.turns().map((t) => t.session), ['new']);
  });
});

// pdl sessions: session ids were needed by `show` and `publish` but nothing
// said how to find one.

const info = (id: string, lastMs: number, events = 1) => ({ id, mtimeMs: lastMs, events });

test('sessions are listed newest first, with the branches they worked on', () => {
  const list = summariseSessions(
    [info('old', 1000), info('new', 5000)],
    [turn('old', 'main', 1), turn('new', 'feat', 2), turn('new', 'feat', 3), turn('new', 'fix', 4)],
  );

  assert.deepEqual(list.map((s) => s.id), ['new', 'old']);
  assert.deepEqual(list[0]?.branches, ['feat', 'fix']);
});

test('filtered to a repo, sessions from other repos are left out', () => {
  const list = summariseSessions(
    [info('here', 1), info('there', 2)],
    [turn('here', 'feat', 1, '/r'), turn('there', 'feat', 1, '/other')],
    '/r',
  );

  assert.deepEqual(list.map((s) => s.id), ['here']);
});

test('a session with no turn yet is listed only when not filtering, since its repo is unknown', () => {
  const infos = [info('fresh', 1)];

  assert.deepEqual(summariseSessions(infos, [], '/r'), []);
  assert.equal(summariseSessions(infos, [])[0]?.repo, undefined);
});

test('the store reports each session with its event count', () => {
  withStore((store) => {
    store.append('s1', ev('a', 1));
    store.append('s1', ev('b', 2));

    const infos = store.sessionsInfo();
    assert.equal(infos.length, 1);
    assert.equal(infos[0]?.id, 's1');
    assert.equal(infos[0]?.events, 2);
  });
});
