import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
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

export type PluginHooks = { active: boolean; events: string[] };

const PLUGIN_ID_PREFIX = 'pr-decision-log@';

const readJson = (path: string): Record<string, unknown> => {
  try {
    const v: unknown = JSON.parse(readFileSync(path, 'utf8'));
    return typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
};

const real = (p: string): string => {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
};

/**
 * Whether the pr-decision-log plugin applies to this folder, and which events it hooks.
 *
 * Read from the same files a real install writes: `installed_plugins.json`
 * records each install's scope, plus a `projectPath` for project and local
 * installs; the matching settings file's `enabledPlugins` switches it on; and
 * the install's own `hooks/hooks.json` says which events it hooks. Without
 * this, doctor told plugin users to run `pdl init`, which would have
 * registered every hook a second time.
 */
export function pluginHooks(
  root: string,
  installedPath: string = join(homedir(), '.claude', 'plugins', 'installed_plugins.json'),
  userSettingsPath: string = join(homedir(), '.claude', 'settings.json'),
): PluginHooks {
  const plugins = readJson(installedPath)['plugins'];
  if (typeof plugins !== 'object' || plugins === null) return { active: false, events: [] };

  const settings = [
    userSettingsPath,
    join(root, '.claude', 'settings.json'),
    join(root, '.claude', 'settings.local.json'),
  ].map(readJson);
  const enabled = (id: string) =>
    settings.some((st) => (st['enabledPlugins'] as Record<string, unknown> | undefined)?.[id] === true);

  for (const [id, entries] of Object.entries(plugins as Record<string, unknown>)) {
    if (!id.startsWith(PLUGIN_ID_PREFIX) || !enabled(id) || !Array.isArray(entries)) continue;

    const entry = (entries as { scope?: string; projectPath?: string; installPath?: string }[]).find(
      (e) => e.scope === 'user' || (typeof e.projectPath === 'string' && real(e.projectPath) === real(root)),
    );
    if (!entry?.installPath) continue;

    const hooks = readJson(join(entry.installPath, 'hooks', 'hooks.json'))['hooks'];
    return { active: true, events: typeof hooks === 'object' && hooks !== null ? Object.keys(hooks) : [] };
  }
  return { active: false, events: [] };
}
