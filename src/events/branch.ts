import type { EventStore } from './store.ts';
import type { TimelineEvent } from './types.ts';

/** A repository working tree and the branch checked out in it. An empty branch is a detached HEAD. */
export type Place = { repo: string; branch: string };

const samePlace = (a: Place, b: Place): boolean => a.repo === b.repo && a.branch === b.branch;

/**
 * One agent turn's position: session S was on branch B in repo R at time T.
 *
 * Hook payloads carry no branch, and resolving one per event would put a git
 * call on the hot path. The Stop hook already runs git, so it records one of
 * these per turn, and every event is later assigned to the turn it happened
 * in. That is what lets one pull request's log span several sessions, a
 * `--resume`, or a session that switched branches part-way.
 *
 * `places` covers a turn that worked somewhere other than R: each directory
 * an event ran in that resolved to another repository or branch, such as a
 * `cd` into a sibling repo or a subagent's worktree. Events in those
 * directories belong there; everything else belongs to R and B.
 */
export type Turn = {
  session: string;
  repo: string;
  branch: string;
  at: string;
  transcript?: string;
  places?: Record<string, Place>;
};

/** The turn an item belongs to: the first that ended at or after it, or the last for an item after every turn. */
function ownerTurn(item: { at?: string }, turns: Turn[]): Turn | undefined {
  const last = turns[turns.length - 1];
  if (item.at === undefined) return last;
  return turns.find((t) => t.at >= item.at!) ?? last;
}

/** Where an item happened: a directory its turn mapped elsewhere, or the turn's own place. */
export function placeOf(item: { at?: string; dir?: string }, turns: Turn[]): Place | undefined {
  const owner = ownerTurn(item, turns);
  if (!owner) return undefined;
  return (item.dir !== undefined ? owner.places?.[item.dir] : undefined) ?? { repo: owner.repo, branch: owner.branch };
}

/**
 * Keep the items that happened in `target`. An item belongs to the first turn
 * that ended at or after it; one after the last recorded turn (a `pdl build`
 * between turns) belongs to that last turn. `turns` is one session's, in order.
 */
export function selectForBranch<T extends { at?: string; dir?: string }>(items: T[], turns: Turn[], target: Place): T[] {
  return items.filter((item) => {
    const place = placeOf(item, turns);
    return place !== undefined && samePlace(place, target);
  });
}

/** Sessions with at least one turn on this repo and branch, directly or through a mapped directory, in first-seen order. */
export function sessionsForBranch(turns: Turn[], repo: string, branch: string): string[] {
  const target = { repo, branch };
  const out: string[] = [];
  for (const t of turns) {
    const here = samePlace(t, target) || Object.values(t.places ?? {}).some((p) => samePlace(p, target));
    if (here && !out.includes(t.session)) out.push(t.session);
  }
  return out;
}

export type TurnPlan = {
  /** Where the turn is recorded, and where its items with no directory go. */
  primary: Place;
  /** Directories that resolved somewhere other than `primary`. */
  places: Record<string, Place>;
  /** Every place with a branch that this turn did something in: the ones to publish. */
  touched: Place[];
};

/**
 * Work out where a turn's events happened, from the directories they ran in.
 *
 * `home` is the folder the session was started in. A turn spent entirely in
 * one other place is recorded there, which also carries the turn's
 * transcript items (answered questions, stated reasons) with it; a turn
 * spread across several stays at home and maps the rest by directory. A
 * directory outside any repository counts as home, which is how every event
 * was attributed before directories were recorded.
 */
export function planTurn(events: { dir?: string }[], home: Place, resolve: (dir: string) => Place | undefined): TurnPlan {
  const resolved = new Map<string, Place>();
  for (const e of events) {
    if (e.dir === undefined || resolved.has(e.dir)) continue;
    const p = resolve(e.dir);
    if (p && !samePlace(p, home)) resolved.set(e.dir, p);
  }

  const touched: Place[] = [];
  for (const e of events) {
    const p = (e.dir !== undefined ? resolved.get(e.dir) : undefined) ?? home;
    if (!touched.some((t) => samePlace(t, p))) touched.push(p);
  }

  const primary = touched.length === 1 && touched[0] ? touched[0] : home;
  const places: Record<string, Place> = {};
  for (const [dir, p] of resolved) if (!samePlace(p, primary)) places[dir] = p;

  const publishable = (touched.length === 0 ? [home] : touched).filter((p) => p.branch !== '');
  return { primary, places, touched: publishable };
}

export type BranchEvents = {
  events: TimelineEvent[];
  sessions: string[];
  /** Transcript path per contributing session, where a turn recorded one. */
  transcripts: Map<string, string>;
  /** Each contributing session's turns, for assigning transcript items too. */
  turnsBySession: Map<string, Turn[]>;
};

/** Every event, from every session, that happened while on this branch, merged in time order. */
export function eventsForBranch(store: EventStore, repo: string, branch: string): BranchEvents {
  const all = store.turns();
  const sessions = sessionsForBranch(all, repo, branch);

  const events: TimelineEvent[] = [];
  const transcripts = new Map<string, string>();
  const turnsBySession = new Map<string, Turn[]>();

  for (const session of sessions) {
    const turns = all.filter((t) => t.session === session).sort((a, b) => a.at.localeCompare(b.at));
    turnsBySession.set(session, turns);
    const transcript = [...turns].reverse().find((t) => t.transcript)?.transcript;
    if (transcript) transcripts.set(session, transcript);
    events.push(...selectForBranch(store.read(session), turns, { repo, branch }));
  }

  events.sort((a, b) => a.at.localeCompare(b.at));
  return { events, sessions, transcripts, turnsBySession };
}

export type SessionSummary = {
  id: string;
  /** The repo its turns ran in; undefined for a session that has not finished a turn yet. */
  repo?: string;
  branches: string[];
  lastActivityMs: number;
  events: number;
};

/**
 * Recorded sessions, newest first, with where each one worked. Filtering by
 * repo drops sessions with no turn yet, since their repo is not known.
 */
export function summariseSessions(
  infos: { id: string; mtimeMs: number; events: number }[],
  turns: Turn[],
  repo?: string,
): SessionSummary[] {
  return infos
    .map((i) => {
      const own = turns.filter((t) => t.session === i.id);
      const places = own.flatMap((t) => [t, ...Object.values(t.places ?? {})]);
      const branches: string[] = [];
      for (const p of places) if (p.branch && !branches.includes(p.branch)) branches.push(p.branch);
      const repos = new Set(places.map((p) => p.repo));
      return { id: i.id, repo: own[own.length - 1]?.repo, repos, branches, lastActivityMs: i.mtimeMs, events: i.events };
    })
    .filter((s) => repo === undefined || s.repos.has(repo))
    .map(({ repos: _repos, ...s }) => s)
    .sort((a, b) => b.lastActivityMs - a.lastActivityMs);
}
