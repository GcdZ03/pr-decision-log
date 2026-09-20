import { readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const DEFAULT_ROOT = join(homedir(), '.claude', 'projects');

/**
 * Locate a session's transcript by id.
 *
 * Claude Code files transcripts under a directory derived from the working
 * directory, but the exact escaping is an internal detail. Searching for the
 * file by its session id avoids depending on that rule, and session ids are
 * unique, so the first match is the right one.
 *
 * The id comes from a hook payload and is therefore untrusted: anything that
 * is not a plain id is refused rather than joined into a path.
 */
export function findTranscript(sessionId: string, root: string = DEFAULT_ROOT): string | undefined {
  if (!/^[A-Za-z0-9._-]{1,128}$/.test(sessionId) || sessionId.startsWith('.')) return undefined;

  let dirs: string[];
  try {
    dirs = readdirSync(root);
  } catch {
    return undefined;
  }

  for (const dir of dirs) {
    const candidate = join(root, dir, `${sessionId}.jsonl`);
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}
