import { REQUIRED_HOOK_EVENTS } from './diagnose.ts';

/**
 * Marks entries this tool owns.
 *
 * Without it, init would have to identify its own hooks by command string, and
 * would then either duplicate them whenever the install path moves or clobber
 * a hook that merely looked similar. Claude Code ignores unknown keys.
 */
export const PDL_MARKER = 'pdlManaged';

export interface HookEntry {
  type: string;
  command: string;
  async?: boolean;
  [PDL_MARKER]?: boolean;
  [key: string]: unknown;
}

export interface HookGroup {
  matcher?: string;
  hooks?: HookEntry[];
}

export interface Settings {
  hooks?: Record<string, HookGroup[]>;
  [key: string]: unknown;
}

/**
 * Recognises a pdl hook that predates the marker, or was written by hand.
 *
 * Without this, `init` on an existing setup leaves the old entry in place and
 * adds a marked one beside it, so every event is recorded twice and the log
 * double-counts. The pattern requires `hook` to be the final argument of
 * something invoked as `pdl`, so a foreign tool with `pdl` in its path is
 * left alone.
 */
const LEGACY_PDL_RE = /(?:^|[\s"'/])pdl(?:\.[jt]s)?["']?\s+hook\s*$/;

const isPdlEntry = (h: HookEntry): boolean =>
  h[PDL_MARKER] === true || LEGACY_PDL_RE.test(h.command ?? '');

/** Events that fire per tool call and therefore need a matcher. */
const TOOL_EVENTS = new Set(['PreToolUse', 'PostToolUse', 'PostToolUseFailure']);

/**
 * `Stop` is the checkpoint that builds and publishes the log, so it must run
 * to completion. Everything else is recording and runs async, off the agent's
 * critical path.
 */
const isAsync = (event: string) => event !== 'Stop';

function entryFor(event: string, command: string): HookEntry {
  const entry: HookEntry = { type: 'command', command, [PDL_MARKER]: true };
  if (isAsync(event)) entry.async = true;
  return entry;
}

/** Hook events with a pdl-managed entry registered. */
export function pdlHookEvents(settings: Settings): string[] {
  return Object.entries(settings.hooks ?? {})
    .filter(([, groups]) => groups.some((g) => (g.hooks ?? []).some((h) => h[PDL_MARKER] === true)))
    .map(([event]) => event);
}

/**
 * Add or refresh pdl's hooks in a settings object, leaving everything else as
 * it was found. Pure, so `pdl init` can show a diff before touching the file.
 */
export function mergeHooks(settings: Settings, command: string): Settings {
  const hooks: Record<string, HookGroup[]> = { ...(settings.hooks ?? {}) };

  for (const event of REQUIRED_HOOK_EVENTS) {
    const groups = (hooks[event] ?? []).map((g) => ({ ...g, hooks: [...(g.hooks ?? [])] }));

    // Drop entries this tool owns, marked or legacy; foreign hooks are kept
    // exactly as found.
    for (const group of groups) {
      group.hooks = (group.hooks ?? []).filter((h) => !isPdlEntry(h));
    }

    const target = groups.find((g) => (TOOL_EVENTS.has(event) ? g.matcher === '*' : g.matcher === undefined));
    const entry = entryFor(event, command);

    if (target) {
      target.hooks = [...(target.hooks ?? []), entry];
    } else {
      groups.push(TOOL_EVENTS.has(event) ? { matcher: '*', hooks: [entry] } : { hooks: [entry] });
    }

    hooks[event] = groups.filter((g) => (g.hooks ?? []).length > 0);
  }

  return { ...settings, hooks };
}
