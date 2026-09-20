import { isDisabled } from '../events/handle-hook.ts';
import { publish, realGh, type GhRunner, type PublishResult } from './publish.ts';
import { publishComment } from './publish-comment.ts';
import type { PublishMode } from '../config/config.ts';

/**
 * Find the pull request for the checked-out branch.
 *
 * Re-deriving this beats persisting the number at `gh pr create` time: there
 * is no state file to go stale across `--resume`, a rebase, or a PR opened
 * from the web, and `gh pr view` with no argument already means "this branch".
 */
export async function resolvePrNumber(gh: GhRunner): Promise<number | null> {
  const view = await gh(['pr', 'view', '--json', 'number']);
  if (!view.ok) return null;

  try {
    const n = (JSON.parse(view.stdout || '{}') as { number?: unknown }).number;
    return typeof n === 'number' ? n : null;
  } catch {
    return null;
  }
}

/** `owner/name` for the checked-out repository, which the comments API needs by path. */
async function resolveRepo(gh: GhRunner): Promise<string | null> {
  const view = await gh(['repo', 'view', '--json', 'nameWithOwner']);
  if (!view.ok) return null;

  try {
    const n = (JSON.parse(view.stdout || '{}') as { nameWithOwner?: unknown }).nameWithOwner;
    return typeof n === 'string' && n !== '' ? n : null;
  } catch {
    return null;
  }
}

export type AutoPublishOptions = {
  section: string;
  gh?: GhRunner;
  dryRun?: boolean;
  env?: NodeJS.ProcessEnv;
  mode?: PublishMode;
};

export type AutoPublishResult = PublishResult | { status: 'skipped'; body: string; error?: string };

/**
 * Publish the log for the current branch, if there is a pull request to put it
 * on. Every failure is a skip: this runs inside a hook, and a logging tool has
 * no business failing someone's `gh pr create`.
 */
export async function autoPublish(options: AutoPublishOptions): Promise<AutoPublishResult> {
  if (isDisabled(options.env ?? process.env)) {
    return { status: 'skipped', body: '', error: 'PDL_DISABLE is set' };
  }

  const gh = options.gh ?? realGh;

  try {
    const prNumber = await resolvePrNumber(gh);
    if (prNumber === null) {
      return { status: 'skipped', body: '', error: 'no pull request for the current branch' };
    }

    const dryRun = options.dryRun ?? false;

    if (options.mode === 'comment') {
      const repo = await resolveRepo(gh);
      if (repo === null) {
        return { status: 'skipped', body: '', error: 'could not resolve the repository for the comments API' };
      }
      return await publishComment({ prNumber, section: options.section, repo, gh, dryRun });
    }

    return await publish({ prNumber, section: options.section, gh, dryRun });
  } catch (e) {
    return { status: 'skipped', body: '', error: e instanceof Error ? e.message : String(e) };
  }
}
