import { appendFileSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { TimelineEvent } from './types.ts';
import type { Turn } from './branch.ts';

const DAY_MS = 86_400_000;

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
  readonly #root: string;

  constructor(root: string = join(homedir(), '.local', 'share', 'pdl')) {
    this.#root = root;
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

  #turnsFile(): string {
    return join(this.#root, 'turns.jsonl');
  }

  appendTurn(turn: Turn): void {
    mkdirSync(this.#root, { recursive: true, mode: 0o700 });
    appendFileSync(this.#turnsFile(), `${JSON.stringify(turn)}\n`);
  }

  turns(): Turn[] {
    let raw: string;
    try {
      raw = readFileSync(this.#turnsFile(), 'utf8');
    } catch {
      return [];
    }
    const out: Turn[] = [];
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try {
        out.push(JSON.parse(line) as Turn);
      } catch {
        // Torn trailing line from a hook killed mid-write.
      }
    }
    return out;
  }

  /**
   * Delete sessions not written to for `days` days. Zero keeps everything.
   * Age is the file's last write, so a resumed session stays alive.
   */
  prune(days: number, now: number): number {
    if (days <= 0) return 0;
    const cutoff = now - days * DAY_MS;
    let removed = 0;
    for (const f of this.#sessionFiles()) {
      const path = join(this.#dir, f);
      try {
        if (statSync(path).mtimeMs < cutoff) {
          rmSync(path, { force: true });
          removed++;
        }
      } catch {
        // Raced with another hook deleting it; nothing to do.
      }
    }

    // Turn records age out on the same clock, or the index would keep
    // pointing at sessions that no longer exist.
    const kept = this.turns().filter((t) => Date.parse(t.at) >= cutoff);
    if (kept.length !== this.turns().length) {
      writeFileSync(this.#turnsFile(), kept.map((t) => `${JSON.stringify(t)}\n`).join(''));
    }
    return removed;
  }

  /** `prune`, at most once a day, so the Stop hook is not scanning the store every turn. */
  pruneIfDue(days: number, now: number): number {
    const marker = join(this.#root, '.last-prune');
    try {
      if (now - Number(readFileSync(marker, 'utf8')) < DAY_MS) return 0;
    } catch {
      // Never pruned.
    }
    const removed = this.prune(days, now);
    try {
      mkdirSync(this.#root, { recursive: true, mode: 0o700 });
      writeFileSync(marker, String(now));
    } catch {
      // Failing to record the time only means pruning again next turn.
    }
    return removed;
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
    const seen = new Set<string>();
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try {
        const event = JSON.parse(line) as TimelineEvent;
        // pdl registered twice (user and project settings, or plugin and
        // init) fires every hook twice. Collapsing on read makes that
        // harmless without a read on the append hot path.
        if (event.id) {
          if (seen.has(event.id)) continue;
          seen.add(event.id);
        }
        events.push(event);
      } catch {
        // A hook killed mid-write leaves a partial trailing line. Skipping it
        // is correct: one torn record must not make the session unreadable.
      }
    }
    return events;
  }
}
