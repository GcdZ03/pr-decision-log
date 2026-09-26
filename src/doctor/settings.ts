import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { spawnSync } from 'node:child_process';
import type { Settings } from './init.ts';
import type { TrustState } from './diagnose.ts';

export type Scope = 'project' | 'user';

export function settingsPathFor(scope: Scope, repoRoot: string): string {
  return scope === 'user'
    ? join(homedir(), '.claude', 'settings.json')
    : join(repoRoot, '.claude', 'settings.json');
}

export function readSettings(path: string): Settings {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as Settings;
  } catch {
    // A missing file is the common case on a fresh install. A malformed one is
    // not ours to repair, and overwriting it would destroy someone's config,
    // so the caller is told via `existed`.
    return {};
  }
}

export function settingsExist(path: string): boolean {
  try {
    readFileSync(path, 'utf8');
    return true;
  } catch {
    return false;
  }
}

export function writeSettings(path: string, settings: Settings): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(settings, null, 2)}\n`);
}

/**
 * The command string to register, resolved from however pdl is being run.
 *
 * A project settings file is usually committed, so an absolute path in it
 * would break on every other clone and publish the author's home directory.
 * When the entry point lives inside the repository it is rewritten against
 * `$CLAUDE_PROJECT_DIR`, which Claude Code expands per checkout. An entry
 * outside the repository keeps its absolute path, since the variable would
 * not resolve to it.
 */
export function hookCommand(
  entry: string = process.argv[1] ?? 'pdl',
  scope: Scope = 'project',
  root: string = repoRoot(),
): string {
  const abs = resolve(entry);
  const prefix = `${resolve(root)}/`;

  const path = scope === 'project' && abs.startsWith(prefix)
    ? `$CLAUDE_PROJECT_DIR/${abs.slice(prefix.length)}`
    : abs;

  return `node "${path}" hook`;
}

export function ghStatus(): 'ok' | 'missing' | 'unauthenticated' {
  const p = spawnSync('gh', ['auth', 'status'], { encoding: 'utf8' });
  if (p.error) return 'missing';
  return p.status === 0 ? 'ok' : 'unauthenticated';
}

export function repoRoot(): string {
  const p = spawnSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' });
  return p.status === 0 ? (p.stdout ?? '').trim() : process.cwd();
}

/**
 * This folder's trust record in Claude Code's state file.
 *
 * Only the exact folder is consulted. Whether trusting a parent directory
 * also covers its children is not something observed here, so a trusted
 * parent is reported as no record rather than assumed to count.
 */
export function trustState(
  root: string,
  statePath: string = join(homedir(), '.claude.json'),
): TrustState {
  let projects: unknown;
  try {
    projects = (JSON.parse(readFileSync(statePath, 'utf8')) as { projects?: unknown }).projects;
  } catch {
    return 'unreadable';
  }
  if (typeof projects !== 'object' || projects === null) return 'unknown-folder';

  const entry = (projects as Record<string, { hasTrustDialogAccepted?: unknown }>)[resolve(root)];
  if (!entry) return 'unknown-folder';
  return entry.hasTrustDialogAccepted === true ? 'accepted' : 'not-accepted';
}
