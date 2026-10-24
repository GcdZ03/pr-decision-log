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
export function diffAgainst(base: string, cwd: string = process.cwd(), head = 'HEAD'): string {
  for (const ref of [`origin/${base}`, base]) {
    const d = git(['diff', '--no-color', `${ref}...${head}`], cwd);
    if (d.ok) return d.out;
  }
  return '';
}

/** The remote's default branch name, for when no PR has told us its base yet. */
export function defaultBase(cwd: string = process.cwd()): string {
  const r = git(['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], cwd);
  return r.ok ? r.out.trim().replace(/^origin\//, '') || 'main' : 'main';
}

/**
 * The paths git does not ignore, for listing files the session wrote that the
 * diff lacks: logs and build output are ignored, so they never make the list.
 * Exit 1 means none are ignored; anything else (not a repository) keeps them all.
 */
export function notIgnoredIn(cwd: string, paths: string[]): string[] {
  if (paths.length === 0) return [];
  const p = spawnSync('git', ['check-ignore', '--stdin'], { cwd, input: paths.join('\n'), encoding: 'utf8' });
  if (p.status !== 0 && p.status !== 1) return paths;
  const ignored = new Set((p.stdout ?? '').split('\n').filter(Boolean));
  return paths.filter((x) => !ignored.has(x));
}

/**
 * The branch's own commits since `base`, with their committer times, so the
 * log can tell which ones no recorded session made. Committer time is when
 * a commit last took its form: a rebase or amend moves it to then. Empty on
 * any failure.
 */
export function commitsSince(base: string, cwd: string = process.cwd(), head = 'HEAD'): { sha: string; at: string }[] {
  for (const ref of [`origin/${base}`, base]) {
    const r = git(['log', '--format=%H%x09%cI', `${ref}..${head}`], cwd);
    if (!r.ok) continue;
    return r.out.trim().split('\n').filter(Boolean).map((line) => {
      const [sha = '', at = ''] = line.split('\t');
      return { sha, at };
    });
  }
  return [];
}
