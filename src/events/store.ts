import { appendFileSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { TimelineEvent } from './types.ts';

/**
 * Append-only JSONL event log, one file per session.
 *
 * Keyed by session rather than branch: hook payloads carry no branch, and
 * resolving one would mean a `git` subprocess on the hot path. The branch is
 * attached later, at build time, from the transcript's `gitBranch`.
 *
 * Lives outside the repository so events are never committed by accident.
 */
export class EventStore {
  readonly #dir: string;

  constructor(root: string = join(homedir(), '.local', 'share', 'pdl')) {
    this.#dir = join(root, 'events');
  }

  /**
   * Session ids come from a hook payload, so they are untrusted input. Anything
   * that is not a plain id is hashed rather than rejected: the store must never
   * lose events, and must never write outside its own directory.
   */
  #fileFor(sessionId: string): string {
    const safe = /^[A-Za-z0-9._-]{1,128}$/.test(sessionId) && !sessionId.startsWith('.')
      ? sessionId
      : createHash('sha256').update(sessionId).digest('hex').slice(0, 32);
    return join(this.#dir, `${safe}.jsonl`);
  }

  append(sessionId: string, event: TimelineEvent): void {
    mkdirSync(this.#dir, { recursive: true, mode: 0o700 });
    appendFileSync(this.#fileFor(sessionId), `${JSON.stringify(event)}\n`);
  }

  /** Recorded sessions. `pdl doctor` reads this to tell dormant hooks from working ones. */
  sessionCount(): number {
    return this.#sessionFiles().length;
  }

  /** Delete every recorded session. The store holds command output, so this has to be one command. */
  purge(): number {
    const files = this.#sessionFiles();
    for (const f of files) rmSync(join(this.#dir, f), { force: true });
    return files.length;
  }

  #sessionFiles(): string[] {
    try {
      return readdirSync(this.#dir).filter((f) => f.endsWith('.jsonl'));
    } catch {
      return [];
    }
  }

  read(sessionId: string): TimelineEvent[] {
    let raw: string;
    try {
      raw = readFileSync(this.#fileFor(sessionId), 'utf8');
    } catch {
      return [];
    }

    const events: TimelineEvent[] = [];
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try {
        events.push(JSON.parse(line) as TimelineEvent);
      } catch {
        // A hook killed mid-write leaves a partial trailing line. Skipping it
        // is correct: one torn record must not make the session unreadable.
      }
    }
    return events;
  }
}
