import { isDisabled } from '../events/handle-hook.ts';
import { publish, realGh, type GhRunner, type PublishResult } from './publish.ts';

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

export type AutoPublishOptions = {
  section: string;
  gh?: GhRunner;
  dryRun?: boolean;
  env?: NodeJS.ProcessEnv;
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

    return await publish({ prNumber, section: options.section, gh, dryRun: options.dryRun ?? false });
  } catch (e) {
    return { status: 'skipped', body: '', error: e instanceof Error ? e.message : String(e) };
  }
}
