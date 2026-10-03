import { homedir } from 'node:os';
import { resolve } from 'node:path';

/** Leading `NAME=value` words, which set the environment rather than run anything. */
const ASSIGNMENT_RE = /^(?:[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|\S*)\s+)+/;

/** One path argument: quoted, or a run of characters with no shell meaning. */
const PATH_ARG = String.raw`("[^"$\`]*"|'[^']*'|[^\s;&|()"'\`$]+|\$HOME[^\s;&|()]*|\$\{HOME\}[^\s;&|()]*)`;
const CD_RE = new RegExp(String.raw`^(?:cd|pushd)\s+${PATH_ARG}\s*$`);
const GIT_C_RE = new RegExp(String.raw`^git\s+-C\s+${PATH_ARG}\s`);

function unquote(arg: string, home: string): string {
  if ((arg.startsWith('"') && arg.endsWith('"')) || (arg.startsWith("'") && arg.endsWith("'"))) arg = arg.slice(1, -1);
  if (arg === '~' || arg.startsWith('~/')) return home + arg.slice(1);
  return arg.replace(/^\$\{?HOME\}?/, home);
}

/**
 * The directory a Bash command actually ran in, read from the command itself.
 *
 * Hook processes run in the folder the session was started in, and so does
 * every git call pdl makes. A session started in one repository that works in
 * another, or in several worktrees through subagents, prefixes its commands
 * with `cd`; reading that prefix is the only record of where they ran. Only
 * the leading segments count, since a `cd` after the first real command does
 * not move what came before it. Anything not readable statically, such as
 * `cd "$(...)"`, leaves the session directory, which is the old behaviour.
 */
export function commandDir(command: string, cwd: string, home: string = homedir()): string {
  const firstLine = command.split('\n')[0] ?? '';
  let dir = cwd;

  for (let segment of firstLine.split(/&&|\|\||;/)) {
    segment = segment.trim().replace(/^\(+\s*/, '').replace(/\s*\)+$/, '');
    if (!segment) continue;
    if (/^(?:export|set)\s/.test(segment)) continue;
    segment = segment.replace(ASSIGNMENT_RE, '');

    const cd = CD_RE.exec(segment);
    if (cd?.[1]) {
      if (cd[1] === '-') return cwd;
      dir = resolve(dir, unquote(cd[1], home));
      continue;
    }
    if (/^(?:cd|pushd)\b/.test(segment)) return cwd; // A cd we cannot read: claim nothing.

    const gitC = GIT_C_RE.exec(`${segment} `);
    if (gitC?.[1]) return resolve(dir, unquote(gitC[1], home));
    break;
  }
  return dir;
}
