import { spawnSync } from 'node:child_process';
import { splice } from './splice.ts';

export type GhResult = { ok: boolean; stdout: string; stderr?: string };
export type GhRunner = (args: string[], stdin?: string) => GhResult | Promise<GhResult>;

export type PublishOptions = {
  prNumber: number;
  section: string;
  gh?: GhRunner;
  dryRun?: boolean;
  repo?: string;
};

export type PublishResult = {
  status: 'updated' | 'unchanged' | 'dry-run' | 'failed';
  body: string;
  error?: string;
};

/**
 * Invoke `gh` without a shell.
 *
 * `spawnSync` with an argument array means nothing in the payload is ever
 * parsed by a shell, and the body travels on stdin rather than in argv, which
 * also avoids the ~256 KB argument-length limit.
 */
export const realGh: GhRunner = (args, stdin) => ghIn(undefined)(args, stdin);

/**
 * `gh` run from `cwd`, which decides the repository and branch it acts on. A
 * session can work in a repository other than the one it was started in, so
 * the publisher runs it from the place the log belongs to.
 */
export const ghIn = (cwd: string | undefined): GhRunner => (args, stdin) => {
  const proc = spawnSync('gh', args, { input: stdin, encoding: 'utf8', ...(cwd ? { cwd } : {}) });
  return {
    ok: proc.status === 0,
    stdout: proc.stdout ?? '',
    stderr: proc.stderr ?? (proc.error ? String(proc.error.message) : ''),
  };
};

/**
 * Read-modify-write the PR body.
 *
 * Fail-soft by contract: publishing is a side effect of someone's real work,
 * so a network or auth problem is reported and never thrown (DESIGN principle 2).
 */
export async function publish(options: PublishOptions): Promise<PublishResult> {
  const gh = options.gh ?? realGh;
  const repoArgs = options.repo ? ['--repo', options.repo] : [];
  const pr = String(options.prNumber);

  const view = await gh(['pr', 'view', pr, ...repoArgs, '--json', 'body']);
  if (!view.ok) {
    return { status: 'failed', body: '', error: view.stderr || 'gh pr view failed' };
  }

  let current = '';
  try {
    current = (JSON.parse(view.stdout || '{}') as { body?: string }).body ?? '';
  } catch {
    return { status: 'failed', body: '', error: 'could not parse gh pr view output' };
  }

  const { body, changed } = splice(current, options.section);
  if (!changed) return { status: 'unchanged', body };
  if (options.dryRun) return { status: 'dry-run', body };

  // `--body-file -` reads stdin: the body never becomes a shell token.
  const edit = await gh(['pr', 'edit', pr, ...repoArgs, '--body-file', '-'], body);
  if (!edit.ok) {
    return { status: 'failed', body, error: edit.stderr || 'gh pr edit failed' };
  }

  return { status: 'updated', body };
}
