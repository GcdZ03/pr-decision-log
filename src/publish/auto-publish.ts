import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { isDisabled } from '../events/handle-hook.ts';
import { realGh, type GhRunner, type PublishResult } from './publish.ts';
import { publishComment } from './publish-comment.ts';
import { sectionHash, splice } from './splice.ts';
import type { PublishMode } from '../config/config.ts';

/** What the last publish learned about one repo and branch. */
export type BranchState = {
  pr?: number;
  base?: string;
  lastHash?: string;
  mode?: PublishMode;
  /** Epoch ms until which "no PR for this branch" is trusted without asking gh. */
  noPrUntil?: number;
};

export interface PublishStateStore {
  get(key: string): BranchState;
  set(key: string, value: BranchState): void;
}

/** Publish state in one JSON file. Unreadable or corrupt reads as empty: the worst case is one extra gh call. */
export class FilePublishState implements PublishStateStore {
  readonly path: string;

  constructor(path: string) {
    this.path = path;
  }

  #all(): Record<string, BranchState> {
    try {
      const v: unknown = JSON.parse(readFileSync(this.path, 'utf8'));
      return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, BranchState>) : {};
    } catch {
      return {};
    }
  }

  get(key: string): BranchState {
    return this.#all()[key] ?? {};
  }

  set(key: string, value: BranchState): void {
    const all = this.#all();
    all[key] = value;
    try {
      mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
      writeFileSync(this.path, JSON.stringify(all));
    } catch {
      // Losing the cache costs a network call next turn, nothing more.
    }
  }
}

/**
 * How long "this branch has no PR" is trusted. A PR opened on the web is
 * picked up within this window; one opened with `gh pr create` in-session
 * bypasses it and is published straight away.
 */
const NO_PR_TTL_MS = 5 * 60_000;

type PrView = { number: number; body: string; baseRefName?: string; repo?: string };

function parseView(stdout: string): PrView | null {
  try {
    const v = JSON.parse(stdout || '{}') as Record<string, unknown>;
    if (typeof v['number'] !== 'number') return null;
    const url = typeof v['url'] === 'string' ? v['url'] : '';
    return {
      number: v['number'],
      body: typeof v['body'] === 'string' ? v['body'] : '',
      baseRefName: typeof v['baseRefName'] === 'string' && v['baseRefName'] !== '' ? v['baseRefName'] : undefined,
      repo: /github\.com\/([^/\s]+\/[^/\s]+)\/pull\//.exec(url)?.[1],
    };
  } catch {
    return null;
  }
}

export type AutoPublishOptions = {
  /** `<repoRoot>#<branch>`: the unit the cache is kept for. */
  key: string;
  /** True when this run was triggered by `gh pr create`; skips the caches. */
  created: boolean;
  /** Renders the log with the PR diffed against `base`. Called only once a PR is known to exist. */
  build: (base: string) => string;
  defaultBase: string;
  state: PublishStateStore;
  now?: number;
  gh?: GhRunner;
  mode?: PublishMode;
  env?: NodeJS.ProcessEnv;
  dryRun?: boolean;
};

export type AutoPublishResult = PublishResult | { status: 'skipped'; body: string; error?: string };

const skipped = (error: string): AutoPublishResult => ({ status: 'skipped', body: '', error });

/**
 * Publish the branch's log from the Stop hook, spending as few network calls
 * as possible.
 *
 * Measured, the hook's local work is about 75 ms and each `gh` round-trip
 * about 500 ms, and the old flow made one call per turn with no PR and three
 * with one. Now: none while a branch is known to have no PR, none when the
 * log has not changed since it was last published, and otherwise one lookup
 * plus a write. The lookup also returns the PR's base branch, so a stacked
 * PR is diffed against its parent rather than the default branch, and its
 * URL, so comment mode needs no separate repository lookup.
 *
 * Every failure is a skip: this runs inside a hook, and a logging tool has no
 * business failing the turn it is logging.
 */
export async function autoPublish(o: AutoPublishOptions): Promise<AutoPublishResult> {
  if (isDisabled(o.env ?? process.env)) return skipped('PDL_DISABLE is set');

  const gh = o.gh ?? realGh;
  const now = o.now ?? Date.now();
  const mode = o.mode ?? 'body';

  try {
    const st = o.state.get(o.key);
    if (!o.created && st.noPrUntil !== undefined && now < st.noPrUntil) {
      return skipped('no pull request for this branch (checked recently)');
    }

    let built: { base: string; section: string } | undefined;
    const sectionFor = (base: string): string => {
      if (built?.base !== base) built = { base, section: o.build(base) };
      return built.section;
    };

    if (!o.created && st.pr !== undefined && st.lastHash !== undefined && st.mode === mode) {
      if (sectionHash(sectionFor(st.base ?? o.defaultBase)) === st.lastHash) return { status: 'unchanged', body: '' };
    }

    const view = await gh(['pr', 'view', '--json', 'number,body,baseRefName,url']);
    const pr = view.ok ? parseView(view.stdout) : null;
    if (!pr) {
      o.state.set(o.key, { noPrUntil: now + NO_PR_TTL_MS });
      return skipped(view.ok ? 'could not parse gh pr view output' : view.stderr || 'no pull request for the current branch');
    }

    const base = pr.baseRefName ?? st.base ?? o.defaultBase;
    const section = sectionFor(base);
    const dryRun = o.dryRun ?? false;

    let result: PublishResult;
    if (mode === 'comment') {
      if (!pr.repo) return skipped('could not read the repository from the PR url');
      result = await publishComment({ prNumber: pr.number, section, repo: pr.repo, gh, dryRun });
    } else {
      const { body, changed } = splice(pr.body, section);
      if (!changed) result = { status: 'unchanged', body };
      else if (dryRun) result = { status: 'dry-run', body };
      else {
        // `--body-file -` reads stdin: the body never becomes a shell token.
        const edit = await gh(['pr', 'edit', String(pr.number), '--body-file', '-'], body);
        result = edit.ok ? { status: 'updated', body } : { status: 'failed', body, error: edit.stderr || 'gh pr edit failed' };
      }
    }

    // A failed write records no hash, so the next turn tries again.
    const published = result.status === 'updated' || result.status === 'unchanged';
    o.state.set(o.key, { pr: pr.number, base, mode, ...(published ? { lastHash: sectionHash(section) } : {}) });
    return result;
  } catch (e) {
    return skipped(e instanceof Error ? e.message : String(e));
  }
}
