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
/**
 * Top-level directories whose paths name a person, a machine or a client:
 * homes, temp and system dirs, mounted volumes, dev-container workspaces.
 * `/v1/customers` or `src/home/page.tsx` are not paths on a disk and are left alone.
 */
const PRIVATE_ROOTS = 'Users|home|tmp|private|var|Volumes|workspaces|root|mnt|opt|srv';
const PATH_CHARS = String.raw`[^\s` + '`' + String.raw`'"()<>[\]{}|,;]`;
/** `/Users/me/x`, and `//tmp/x` written with a doubled slash. */
const PRIVATE_PATH = new RegExp(String.raw`(?<![\w.~/-])\/+(?:${PRIVATE_ROOTS})(?:\/${PATH_CHARS}*)?`, 'g');
/** `C:\Users\me\x` or `C:/Users/me/x`. */
const WINDOWS_USER_PATH = new RegExp(String.raw`(?<![\w.-])[A-Za-z]:[\\/]Users(?:[\\/]${PATH_CHARS}*)?`, 'g');
/** A quoted or backticked private path, which may contain spaces: reduced whole. */
const QUOTED_PRIVATE_PATH = new RegExp(String.raw`(["'` + '`' + String.raw`])((?:\/+(?:${PRIVATE_ROOTS})|[A-Za-z]:[\\/]Users)(?:[\\/][^"'` + '`' + String.raw`\n]*)?)\1`, 'g');
/** The scheme of a file URL; the path after it is cleaned like any other. */
const FILE_SCHEME = /\bfile:\/\/(?=\/|[A-Za-z]:)/gi;

const nameOf = (path: string): string => path.split(/[\\/]/).filter(Boolean).pop() ?? path;

/** The file name, keeping sentence punctuation after the path outside it. */
function reduce(match: string): string {
  const trail = /[.:]+$/.exec(match)?.[0] ?? '';
  return nameOf(match.slice(0, match.length - trail.length)) + trail;
}

const escape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Make free text (a stated decision, a flag's sentence) safe to publish.
 *
 * A path inside the repository loses its root, in all three of the forms
 * `relativize` accepts, so it reads repo-relative. Any other path under a
 * private root (PRIVATE_ROOTS, or a Windows user folder) keeps only its
 * name, including when written as a `file://` URL, with a doubled slash, or
 * quoted with spaces in it. An unquoted path containing a space can only be
 * reduced up to the space.
 */
export function scrubPaths(text: string, repoRoot?: string): string {
  let out = text.replace(FILE_SCHEME, '');
  if (repoRoot) {
    const root = resolve(repoRoot);
    const forms = [...new Set([`/private${root}`, root, root.replace(/^\/private\//, '/')])].sort((a, b) => b.length - a.length);
    for (const form of forms) out = out.replace(new RegExp(`(?<![\\w.~/-])${escape(form)}/`, 'g'), '');
  }
  return out
    .replace(QUOTED_PRIVATE_PATH, (_m, quote: string, path: string) => `${quote}${nameOf(path)}${quote}`)
    // Windows first: `C:/Users/x` also contains a Unix-looking `/Users/x`.
    .replace(WINDOWS_USER_PATH, reduce)
    .replace(PRIVATE_PATH, reduce);
}
