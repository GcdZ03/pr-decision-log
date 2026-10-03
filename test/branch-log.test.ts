import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventStore } from '../src/events/store.ts';
import { selectForBranch, sessionsForBranch, eventsForBranch, summariseSessions, planTurn, type Place, type Turn } from '../src/events/branch.ts';
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

  assert.deepEqual(selectForBranch([ev('a', 3), ev('b', 7)], turns, { repo: '/r', branch: 'feat' }).map((e) => e.id), ['b']);
  assert.deepEqual(selectForBranch([ev('a', 3), ev('b', 7)], turns, { repo: '/r', branch: 'main' }).map((e) => e.id), ['a']);
});

test('events after the last recorded turn go with that turn', () => {
  // `pdl build` between turns: the in-progress turn has no record yet.
  assert.deepEqual(selectForBranch([ev('a', 12)], [turn('s', 'feat', 10)], { repo: '/r', branch: 'feat' }).map((e) => e.id), ['a']);
});

test('a session with no recorded turns contributes nothing, because its branch is unknown', () => {
  assert.deepEqual(selectForBranch([ev('a', 1)], [], { repo: '/r', branch: 'feat' }), []);
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

// One session, started in one repository, opened six pull requests in
// another through subagents in six worktrees. Every turn was recorded against
// the folder the session started in, so none of the six got a log.

const evAt = (id: string, m: number, dir: string): TimelineEvent => ({ ...ev(id, m), dir });
const NOTCH: Place = { repo: '/notch', branch: 'main' };
const WT1: Place = { repo: '/atlas-wt-01', branch: 'm0/01' };
const WT2: Place = { repo: '/atlas-wt-02', branch: 'm0/02' };

test('an event whose directory the turn mapped elsewhere belongs to that repo and branch', () => {
  const turns: Turn[] = [{ session: 's', ...NOTCH, at: at(10), places: { '/atlas-wt-01': WT1, '/atlas-wt-02/src': WT2 } }];
  const items = [evAt('home', 1, '/notch'), evAt('one', 2, '/atlas-wt-01'), evAt('two', 3, '/atlas-wt-02/src'), ev('nodir', 4)];

  assert.deepEqual(selectForBranch(items, turns, WT1).map((e) => e.id), ['one']);
  assert.deepEqual(selectForBranch(items, turns, WT2).map((e) => e.id), ['two']);
  assert.deepEqual(selectForBranch(items, turns, NOTCH).map((e) => e.id), ['home', 'nodir']);
});

test('the same branch name in another repository is a different place', () => {
  const turns: Turn[] = [{ session: 's', ...NOTCH, at: at(10), places: { '/other': { repo: '/other', branch: 'main' } } }];

  assert.deepEqual(selectForBranch([evAt('x', 1, '/other')], turns, NOTCH), []);
});

test('a session counts toward a branch it only reached through a mapped directory', () => {
  const turns: Turn[] = [{ session: 's', ...NOTCH, at: at(10), places: { '/atlas-wt-01': WT1 } }];

  assert.deepEqual(sessionsForBranch(turns, '/atlas-wt-01', 'm0/01'), ['s']);
});

test("a worktree's log is built from the session that worked in it, wherever that session started", () => {
  withStore((store) => {
    store.append('s', evAt('setup', 1, '/notch'));
    store.append('s', evAt('wt1-test', 2, '/atlas-wt-01'));
    store.append('s', evAt('wt2-test', 3, '/atlas-wt-02/src'));
    store.appendTurn({ session: 's', ...NOTCH, at: at(5), places: { '/atlas-wt-01': WT1, '/atlas-wt-02/src': WT2 } });

    assert.deepEqual(eventsForBranch(store, '/atlas-wt-01', 'm0/01').events.map((e) => e.id), ['wt1-test']);
    assert.deepEqual(eventsForBranch(store, '/atlas-wt-02', 'm0/02').events.map((e) => e.id), ['wt2-test']);
    assert.deepEqual(eventsForBranch(store, '/notch', 'main').events.map((e) => e.id), ['setup']);
  });
});

test('pdl sessions lists a session under the repositories and branches it reached', () => {
  const turns: Turn[] = [{ session: 's', ...NOTCH, at: at(10), places: { '/atlas-wt-01': WT1 } }];

  const list = summariseSessions([info('s', 1)], turns, '/atlas-wt-01');
  assert.deepEqual(list.map((x) => x.id), ['s']);
  assert.deepEqual(list[0]?.branches, ['main', 'm0/01']);
});

const resolver = (map: Record<string, Place | undefined>) => (dir: string) => map[dir];

test('a turn spent entirely in another repository is recorded there', () => {
  const plan = planTurn([evAt('a', 1, '/atlas-wt-01'), evAt('b', 2, '/atlas-wt-01/src')], NOTCH,
    resolver({ '/atlas-wt-01': WT1, '/atlas-wt-01/src': WT1 }));

  assert.deepEqual(plan.primary, WT1);
  assert.deepEqual(plan.touched, [WT1]);
});

test('a turn that worked at home and elsewhere stays at home and publishes both', () => {
  const plan = planTurn([evAt('a', 1, '/notch'), evAt('b', 2, '/atlas-wt-01')], NOTCH,
    resolver({ '/notch': NOTCH, '/atlas-wt-01': WT1 }));

  assert.deepEqual(plan.primary, NOTCH);
  assert.deepEqual(plan.places, { '/atlas-wt-01': WT1 });
  assert.deepEqual(plan.touched, [NOTCH, WT1]);
});

test('a turn across two other repositories stays at home and publishes each', () => {
  const plan = planTurn([evAt('a', 1, '/atlas-wt-01'), evAt('b', 2, '/atlas-wt-02')], NOTCH,
    resolver({ '/atlas-wt-01': WT1, '/atlas-wt-02': WT2 }));

  assert.deepEqual(plan.primary, NOTCH);
  assert.deepEqual(plan.touched, [WT1, WT2]);
});

test('a directory outside any repository counts as home, as before', () => {
  const plan = planTurn([evAt('a', 1, '/tmp')], NOTCH, resolver({}));

  assert.deepEqual(plan.primary, NOTCH);
  assert.deepEqual(plan.places, {});
  assert.deepEqual(plan.touched, [NOTCH]);
});

test('a turn with no events publishes home, so a PR opened on the web is still found', () => {
  assert.deepEqual(planTurn([], NOTCH, resolver({})).touched, [NOTCH]);
});

test('a detached checkout elsewhere is kept out of home but never published', () => {
  const detached: Place = { repo: '/atlas-wt-09', branch: '' };
  const plan = planTurn([evAt('a', 1, '/notch'), evAt('b', 2, '/atlas-wt-09')], NOTCH,
    resolver({ '/notch': NOTCH, '/atlas-wt-09': detached }));

  assert.deepEqual(plan.places, { '/atlas-wt-09': detached });
  assert.deepEqual(plan.touched, [NOTCH]);
});

test('a session started outside any repository publishes only where it worked', () => {
  const nowhere: Place = { repo: '/home/dev', branch: '' };
  const plan = planTurn([evAt('a', 1, '/atlas-wt-01')], nowhere, resolver({ '/atlas-wt-01': WT1 }));

  assert.deepEqual(plan.primary, WT1);
  assert.deepEqual(plan.touched, [WT1]);
});
