import type { Outcome, TimelineEvent } from '../events/types.ts';
import { classifyCommand } from '../events/classify-command.ts';
import { runnerFragment, withoutWrapper } from '../events/command-text.ts';

/** One distinct runner fragment and what happened each time it ran. */
export type Check = {
  /** The runner fragment, which is all that is published. */
  command: string;
  kind: 'test' | 'build' | 'lint';
  /** What the Checks line groups by: `pytest`, `pnpm test`, `docker build`. */
  tool: string;
  runs: number;
  failures: number;
  last: Outcome;
  lastAt: string;
  /** Rewrites files (`--fix`, `--write`, `format`): an auto-fix, never a check. */
  fixer: boolean;
};

const PACKAGE_MANAGERS = new Set(['npm', 'pnpm', 'yarn', 'bun']);
/** Package-manager options that take a value, so the value is not mistaken for the script. */
const OPTION_WITH_VALUE = new Set(['--filter', '-F', '--dir', '-C', '--prefix', '--workspace', '--cwd']);
const TASK_RUNNERS = new Set(['just', 'make', 'task']);
const SUBCOMMAND_TOOLS = new Set(['go', 'cargo', 'swift', 'dotnet', 'playwright']);

/** Check if an option takes a value for the given package manager. */
function takesValue(word: string, packageManager: string): boolean {
  if (OPTION_WITH_VALUE.has(word)) return true;
  // -w takes a value only for npm (workspace), not for pnpm/yarn/bun (flags)
  if (word === '-w' && packageManager === 'npm') return true;
  return false;
}

export function toolOf(fragment: string): string {
  let words = withoutWrapper(fragment).split(/\s+/).filter(Boolean);
  let first = words[0] ?? '';

  // Handle docker-compose as docker compose
  if (first === 'docker-compose') {
    first = 'docker';
    words = ['docker', 'compose', ...words.slice(1)];
  }

  // Handle yarn workspace <name> <command> (before general package manager check)
  if (first === 'yarn' && words[1] === 'workspace' && words[2]) {
    for (let i = 3; i < words.length; i++) {
      const w = words[i]!;
      if (takesValue(w, 'yarn')) { i++; continue; }
      if (w.startsWith('-') || w === 'run') continue;
      return `yarn ${w}`;
    }
    return 'yarn';
  }

  if (PACKAGE_MANAGERS.has(first)) {
    for (let i = 1; i < words.length; i++) {
      const w = words[i]!;
      if (takesValue(w, first)) { i++; continue; }
      if (w.startsWith('-') || w === 'run') continue;
      return `${first} ${w}`;
    }
    return first;
  }

  if (TASK_RUNNERS.has(first)) return words[1] && !words[1].startsWith('-') ? `${first} ${words[1]}` : first;
  if (first === 'node' && words[1] === '--test') return 'node --test';

  // Handle cargo +toolchain
  if (first === 'cargo' && words[1]?.startsWith('+')) {
    for (let i = 2; i < words.length; i++) {
      const w = words[i]!;
      if (takesValue(w, 'cargo')) { i++; continue; }
      if (w.startsWith('-') || w === 'run') continue;
      return `cargo ${w}`;
    }
    return 'cargo';
  }

  if (first === 'docker') {
    const optionsWithValue = new Set(['-f', '--file', '-p', '--project-name']);
    const filtered: string[] = [];
    for (let i = 1; i < words.length; i++) {
      const w = words[i]!;
      if (optionsWithValue.has(w)) { i++; continue; }
      if (w.startsWith('-')) continue;
      filtered.push(w);
    }
    return ['docker', ...filtered.slice(0, filtered[0] === 'build' ? 1 : 2)].join(' ');
  }

  if (SUBCOMMAND_TOOLS.has(first) && words[1] && !words[1].startsWith('-')) return `${first} ${words[1]}`;
  return first;
}

export function isFixer(fragment: string): boolean {
  const words = fragment.split(/\s+/);

  // --check and --diff mean "not a fixer"
  if (words.includes('--check') || words.includes('--diff')) return false;

  // --write, --fix, --fix=* are always fixers
  if (words.some((w) => w === '--write' || w === '--fix' || w.startsWith('--fix='))) return true;

  // -w is only a fixer for gofmt, otherwise it's workspace/watch
  const tool = toolOf(fragment);
  if (words.includes('-w') && tool === 'gofmt') return true;

  // Check if tool is a formatter
  if (tool === 'cargo fmt' || tool === 'black' || tool === 'rustfmt' || tool === 'swiftformat' || tool === 'gofmt') return true;
  if (tool === 'ruff' && withoutWrapper(fragment).startsWith('ruff format')) return true;

  return false;
}

/**
 * Every test, build and lint run, folded into one entry per distinct runner
 * fragment in first-seen order. Classification happens here, from the text,
 * so events recorded by older versions are read with today's rules.
 */
export function summariseChecks(events: TimelineEvent[]): Check[] {
  const byCommand = new Map<string, Check>();
  for (const e of events) {
    if (e.kind !== 'command') continue;
    const kind = classifyCommand(e.command);
    if (kind !== 'test' && kind !== 'build' && kind !== 'lint') continue;
    const command = runnerFragment(e.command);
    if (!command) continue;

    const failed = e.outcome === 'fail' ? 1 : 0;
    const seen = byCommand.get(command);
    if (seen) {
      seen.runs += 1;
      seen.failures += failed;
      seen.last = e.outcome;
      seen.lastAt = e.at;
    } else {
      byCommand.set(command, {
        command, kind, tool: toolOf(command), runs: 1, failures: failed,
        last: e.outcome, lastAt: e.at, fixer: isFixer(command),
      });
    }
  }
  return [...byCommand.values()];
}

export type ToolStatus = { tool: string; status: Outcome };

const RANK: Record<Outcome, number> = { pass: 0, unknown: 1, interrupted: 2, fail: 3 };

/**
 * One status per tool: the worst last result among its checks. A tool reads
 * as passing only when every check under it last passed, so a green full
 * suite cannot hide a single file still failing. Fixers are left out.
 */
export function toolStatuses(checks: Check[]): ToolStatus[] {
  const out: ToolStatus[] = [];
  for (const c of checks) {
    if (c.fixer) continue;
    const t = out.find((x) => x.tool === c.tool);
    if (!t) out.push({ tool: c.tool, status: c.last });
    else if (RANK[c.last] > RANK[t.status]) t.status = c.last;
  }
  return out;
}
