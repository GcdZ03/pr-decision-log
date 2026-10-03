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
