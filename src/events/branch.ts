import type { EventStore } from './store.ts';
import type { TimelineEvent } from './types.ts';

/**
 * One agent turn's position: session S was on branch B in repo R at time T.
 *
 * Hook payloads carry no branch, and resolving one per event would put a git
 * call on the hot path. The Stop hook already runs git, so it records one of
 * these per turn, and every event is later assigned to the turn it happened
 * in. That is what lets one pull request's log span several sessions, a
 * `--resume`, or a session that switched branches part-way.
 */
export type Turn = { session: string; repo: string; branch: string; at: string; transcript?: string };

/**
 * Keep the items whose turn was on `branch`. An item belongs to the first turn
 * that ended at or after it; one after the last recorded turn (a `pdl build`
 * between turns) belongs to that last turn. `turns` is one session's, in order.
 */
export function selectForBranch<T extends { at?: string }>(items: T[], turns: Turn[], branch: string): T[] {
  const last = turns[turns.length - 1];
  if (!last) return [];

  return items.filter((item) => {
    const owner = item.at === undefined ? last : (turns.find((t) => t.at >= item.at!) ?? last);
    return owner.branch === branch;
  });
}

/** Sessions with at least one turn on this repo and branch, in first-seen order. */
export function sessionsForBranch(turns: Turn[], repo: string, branch: string): string[] {
  const out: string[] = [];
  for (const t of turns) {
    if (t.repo === repo && t.branch === branch && !out.includes(t.session)) out.push(t.session);
  }
  return out;
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
  const all = store.turns().filter((t) => t.repo === repo);
  const sessions = sessionsForBranch(all, repo, branch);

  const events: TimelineEvent[] = [];
  const transcripts = new Map<string, string>();
  const turnsBySession = new Map<string, Turn[]>();

  for (const session of sessions) {
    const turns = all.filter((t) => t.session === session).sort((a, b) => a.at.localeCompare(b.at));
    turnsBySession.set(session, turns);
    const transcript = [...turns].reverse().find((t) => t.transcript)?.transcript;
    if (transcript) transcripts.set(session, transcript);
    events.push(...selectForBranch(store.read(session), turns, branch));
  }

  events.sort((a, b) => a.at.localeCompare(b.at));
  return { events, sessions, transcripts, turnsBySession };
}
