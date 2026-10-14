import { basename, isAbsolute, relative, resolve } from 'node:path';

/**
 * Strip an absolute path down to something safe to publish.
 *
 * Two reasons this is not cosmetic. An absolute path leaks the filesystem
 * layout (and usually the username) into a PR body that may be public, and a
 * reviewer needs a path they can actually click in the diff.
 *
 * On macOS, tool payloads report `/private/tmp/...` while git reports
 * `/tmp/...` for the same directory, so both forms are tried.
 */
/** Whether an absolute path lies inside the repository, with the same /private allowance as `relativize`. */
export function insideRepo(path: string, repoRoot: string): boolean {
  if (!isAbsolute(path)) return true;
  const root = resolve(repoRoot);
  return [root, root.replace(/^\/private\//, '/'), `/private${root}`].some((base) => {
    const rel = relative(base, path);
    return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
  });
}

export function relativize(path: string, repoRoot: string): string {
  if (!path) return path;
  if (!isAbsolute(path)) return path;

  const root = resolve(repoRoot);
  const candidates = [root, root.replace(/^\/private\//, '/'), `/private${root}`];

  for (const base of candidates) {
    const rel = relative(base, path);
    if (rel && !rel.startsWith('..') && !isAbsolute(rel)) return rel;
  }

  // Outside the repo: publish the name only, never the location.
  return basename(path);
}

/** An absolute path under a directory that names a person or a machine. */
const PRIVATE_PATH = /(?<![\w.~/-])\/(?:Users|home|tmp|private|var)(?:\/[^\s`'"()<>[\]{}|,;]*)?/g;

const escape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Make free text (a stated decision, a flag's sentence) safe to publish.
 *
 * A path inside the repository loses its root, in all three of the forms
 * `relativize` accepts, so it reads repo-relative. Any other absolute path
 * under a home or temporary directory keeps only its name.
 */
export function scrubPaths(text: string, repoRoot?: string): string {
  let out = text;
  if (repoRoot) {
    const root = resolve(repoRoot);
    const forms = [...new Set([`/private${root}`, root, root.replace(/^\/private\//, '/')])].sort((a, b) => b.length - a.length);
    for (const form of forms) out = out.replace(new RegExp(`(?<![\\w.~/-])${escape(form)}/`, 'g'), '');
  }
  return out.replace(PRIVATE_PATH, (match) => {
    // Sentence punctuation after a path is not part of it.
    const trail = /[.:]+$/.exec(match)?.[0] ?? '';
    return basename(match.slice(0, match.length - trail.length)) + trail;
  });
}
