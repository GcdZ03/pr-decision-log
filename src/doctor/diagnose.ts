import { isDisabled } from '../events/handle-hook.ts';

export type CheckStatus = 'ok' | 'warn' | 'fail' | 'skip';

export interface Check {
  name: string;
  status: CheckStatus;
  detail: string;
  remedy?: string;
}

export interface Facts {
  nodeVersion: string;
  /** Hook event names whose command points at pdl. */
  hookEvents: string[];
  settingsPath: string | undefined;
  recordedSessions: number;
  gh: 'ok' | 'missing' | 'unauthenticated';
  env: NodeJS.ProcessEnv;
  /** Settings the config loader refused. Empty on a clean config. */
  configProblems: string[];
  /** This folder's trust record in Claude Code's own state file. */
  trust: TrustState;
  /** Settings files that register pdl hooks. */
  hookScopes: ('project' | 'user')[];
}

export type TrustState = 'accepted' | 'not-accepted' | 'unknown-folder' | 'unreadable';

const MIN_NODE_MAJOR = 22;

/** Events the log needs to reconstruct a timeline. */
export const REQUIRED_HOOK_EVENTS = [
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure',
  'UserPromptSubmit',
  'Stop',
  'SubagentStop',
] as const;

const SEVERITY: Record<CheckStatus, number> = { skip: 0, ok: 1, warn: 2, fail: 3 };

export function worstStatus(checks: Check[]): CheckStatus {
  let worst: CheckStatus = 'ok';
  for (const c of checks) {
    if (SEVERITY[c.status] > SEVERITY[worst]) worst = c.status;
  }
  return worst === 'skip' ? 'ok' : worst;
}

function nodeCheck(facts: Facts): Check {
  const major = Number(/^v?(\d+)/.exec(facts.nodeVersion)?.[1] ?? 0);
  return major >= MIN_NODE_MAJOR
    ? { name: 'node', status: 'ok', detail: facts.nodeVersion }
    : {
        name: 'node',
        status: 'fail',
        detail: `${facts.nodeVersion}, below the required v${MIN_NODE_MAJOR}`,
        remedy: `Install Node ${MIN_NODE_MAJOR} or newer.`,
      };
}

function registeredCheck(facts: Facts): Check {
  const missing = REQUIRED_HOOK_EVENTS.filter((e) => !facts.hookEvents.includes(e));

  if (facts.hookEvents.length === 0) {
    return {
      name: 'hooks registered',
      status: 'fail',
      detail: 'no pdl hooks found in any settings file',
      remedy: 'Run `pdl init` in this repository.',
    };
  }
  if (facts.hookScopes.length > 1) {
    return {
      name: 'hooks registered',
      status: 'warn',
      detail: 'registered in both project and user settings, so every hook fires twice',
      remedy:
        'Events are de-duplicated when read, but each turn still runs two publishes. Remove one: delete the pdl entries from ~/.claude/settings.json, or from this repo\'s .claude/settings.json.',
    };
  }
  if (missing.length > 0) {
    return {
      name: 'hooks registered',
      status: 'warn',
      detail: `${facts.hookEvents.length} registered, missing ${missing.join(', ')}`,
      remedy: 'Run `pdl init` to add the missing events.',
    };
  }
  return {
    name: 'hooks registered',
    status: 'ok',
    detail: `${facts.hookEvents.length} events in ${facts.settingsPath ?? 'settings'}`,
  };
}

/**
 * The check this tool exists for.
 *
 * Claude Code holds back hooks from every settings file, including the user's
 * own, until the folder has been trusted interactively. Registered-but-dormant
 * therefore looks identical to a working install from the config alone, which
 * is exactly the trap that cost a day during the spike. Reporting a green
 * check here would be a lie, so an empty store with registered hooks warns.
 */
function firingCheck(facts: Facts): Check {
  if (facts.hookEvents.length === 0) {
    return { name: 'hooks firing', status: 'skip', detail: 'nothing registered to fire' };
  }
  if (facts.recordedSessions === 0) {
    return {
      name: 'hooks firing',
      status: 'warn',
      detail: 'hooks are registered but no session has ever been recorded',
      remedy:
        'Claude Code keeps hooks dormant until the folder is trusted. Open this repo interactively, accept the trust dialog, then run `/hooks` and confirm the events show a count.',
    };
  }
  return { name: 'hooks firing', status: 'ok', detail: `${facts.recordedSessions} session(s) recorded` };
}

function killSwitchCheck(facts: Facts): Check {
  return isDisabled(facts.env)
    ? {
        name: 'kill switch',
        status: 'warn',
        detail: `PDL_DISABLE=${facts.env['PDL_DISABLE']}, recording is off`,
        remedy: 'Unset PDL_DISABLE to resume recording.',
      }
    : { name: 'kill switch', status: 'ok', detail: 'PDL_DISABLE not in effect' };
}

/** Publishing needs gh; recording does not, so a missing gh is never fatal. */
function ghCheck(facts: Facts): Check {
  switch (facts.gh) {
    case 'ok':
      return { name: 'gh', status: 'ok', detail: 'installed and authenticated' };
    case 'missing':
      return {
        name: 'gh',
        status: 'warn',
        detail: 'gh not found, publishing will be skipped',
        remedy: 'Install the GitHub CLI: https://cli.github.com',
      };
    case 'unauthenticated':
      return {
        name: 'gh',
        status: 'warn',
        detail: 'gh is installed but not authenticated',
        remedy: 'Run `gh auth login`.',
      };
  }
}

/**
 * The config loader never throws, so a typo would otherwise apply silently as
 * a default and the tool would look like it ignored the setting.
 */
function configCheck(facts: Facts): Check {
  return facts.configProblems.length === 0
    ? { name: 'config', status: 'ok', detail: 'no problems' }
    : {
        name: 'config',
        status: 'warn',
        detail: facts.configProblems.join('; '),
        remedy: 'Fix or remove these settings; defaults are in use for them.',
      };
}

const TRUST_REMEDY =
  'Run `claude` in this folder, accept the trust dialog, then `/hooks` to confirm the events show a count.';

/**
 * Reads the trust flag directly instead of inferring it from an empty store.
 *
 * The inference was wrong in the case that matters: `claude -p` bypasses the
 * trust dialog, so headless runs record sessions and the firing check goes
 * green while every interactive session records nothing.
 */
function trustCheck(facts: Facts): Check {
  switch (facts.trust) {
    case 'accepted':
      return { name: 'folder trust', status: 'ok', detail: 'trust dialog accepted' };
    case 'not-accepted':
      return {
        name: 'folder trust',
        status: 'warn',
        detail: 'trust dialog not accepted; hooks fire only in headless `claude -p` runs',
        remedy: TRUST_REMEDY,
      };
    case 'unknown-folder':
      return {
        name: 'folder trust',
        status: 'warn',
        detail: 'folder never opened interactively; hooks fire only in headless `claude -p` runs',
        remedy: TRUST_REMEDY,
      };
    case 'unreadable':
      return { name: 'folder trust', status: 'skip', detail: 'could not read ~/.claude.json' };
  }
}

export function diagnose(facts: Facts): Check[] {
  return [
    nodeCheck(facts),
    registeredCheck(facts),
    trustCheck(facts),
    firingCheck(facts),
    configCheck(facts),
    killSwitchCheck(facts),
    ghCheck(facts),
  ];
}
