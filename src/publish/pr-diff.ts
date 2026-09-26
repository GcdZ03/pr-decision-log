import { spawnSync } from 'node:child_process';

function git(args: string[], cwd: string): { ok: boolean; out: string } {
  const p = spawnSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return { ok: p.status === 0, out: p.stdout ?? '' };
}

/**
 * The branch's diff against `base`, as the PR shows it.
 *
 * The remote-tracking ref is preferred because that is what the PR is against;
 * a base that only exists locally is the fallback. `...` diffs from the merge
 * base, so a stale local copy of the base does not pull its newer commits into
 * this branch's diff. Empty on any failure: the diff flags are an addition to
 * the log, never a reason for it not to publish.
 */
export function diffAgainst(base: string, cwd: string = process.cwd()): string {
  for (const ref of [`origin/${base}`, base]) {
    const d = git(['diff', '--no-color', `${ref}...HEAD`], cwd);
    if (d.ok) return d.out;
  }
  return '';
}

/** The remote's default branch name, for when no PR has told us its base yet. */
export function defaultBase(cwd: string = process.cwd()): string {
  const r = git(['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], cwd);
  return r.ok ? r.out.trim().replace(/^origin\//, '') || 'main' : 'main';
}
