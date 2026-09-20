import { splice } from './splice.ts';
import { realGh, type GhRunner, type PublishResult } from './publish.ts';

const MARKER_START = '<!-- pdl:start';

export type PublishCommentOptions = {
  prNumber: number;
  section: string;
  repo: string;
  gh?: GhRunner;
  dryRun?: boolean;
};

type Comment = { id: number; body: string };

function parseComments(stdout: string): Comment[] {
  try {
    const parsed: unknown = JSON.parse(stdout || '[]');
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((c): c is Record<string, unknown> => typeof c === 'object' && c !== null)
      .filter((c) => typeof c['id'] === 'number' && typeof c['body'] === 'string')
      .map((c) => ({ id: c['id'] as number, body: c['body'] as string }));
  } catch {
    return [];
  }
}

/**
 * Publish the log as a sticky pull request comment.
 *
 * The comment is located by the marker in its body and edited by id. `gh pr
 * comment --edit-last` is deliberately not used: it edits the most recent
 * comment by the authenticated user, which is whatever that person last
 * wrote, so a review note typed between two publishes would be overwritten.
 *
 * Reads before writes, and a failed read never falls through to a create:
 * that path would post a duplicate log on every transient API error.
 */
export async function publishComment(options: PublishCommentOptions): Promise<PublishResult> {
  const gh = options.gh ?? realGh;
  const base = `repos/${options.repo}/issues`;

  const list = await gh(['api', `${base}/${options.prNumber}/comments`, '--paginate']);
  if (!list.ok) {
    return { status: 'failed', body: '', error: list.stderr || 'could not list comments' };
  }

  const existing = parseComments(list.stdout).find((c) => c.body.includes(MARKER_START));
  const { body, changed } = splice(existing?.body ?? '', options.section);

  if (existing && !changed) return { status: 'unchanged', body };
  if (options.dryRun) return { status: 'dry-run', body };

  // `--input -` sends the JSON payload on stdin, so nothing in the log is ever
  // parsed by a shell or bounded by the argv length limit.
  const payload = JSON.stringify({ body });
  const write = existing
    ? await gh(['api', '-X', 'PATCH', `repos/${options.repo}/issues/comments/${existing.id}`, '--input', '-'], payload)
    : await gh(['api', '-X', 'POST', `${base}/${options.prNumber}/comments`, '--input', '-'], payload);

  if (!write.ok) {
    return { status: 'failed', body, error: write.stderr || 'could not write the comment' };
  }
  return { status: 'updated', body };
}
