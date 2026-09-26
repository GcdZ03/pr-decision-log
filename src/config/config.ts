import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

export type PublishMode = 'body' | 'comment';

/**
 * Every setting here is read by the code; a test enforces it. Settings for
 * features that do not exist (on_push, model_summary) and switches that would
 * weaken the safety model (builtin_rules, publish_tool_output) were removed
 * rather than accepted and ignored, so a config file cannot promise behaviour
 * the tool does not have.
 */
export type Config = {
  publish: { mode: PublishMode; max_chars: number; on_pr_create: boolean };
  extract: { decision_markers: string[] };
  tests: { flag_edit_after_failure: boolean };
  redaction: { extra_patterns: string[] };
  store: { dir: string; retention_days: number };
  /** Anything rejected while loading. Surfaced by `pdl doctor`, never thrown. */
  problems: string[];
};

export const DEFAULT_CONFIG: Config = {
  publish: { mode: 'body', max_chars: 12000, on_pr_create: true },
  extract: { decision_markers: [] },
  tests: { flag_edit_after_failure: true },
  redaction: { extra_patterns: [] },
  store: { dir: join(homedir(), '.local', 'share', 'pdl'), retention_days: 30 },
  problems: [],
};

const PUBLISH_MODES: PublishMode[] = ['body', 'comment'];

type Raw = Record<string, unknown>;

const isObject = (v: unknown): v is Raw => typeof v === 'object' && v !== null && !Array.isArray(v);

function readJson(path: string, problems: string[]): Raw {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return {}; // Absent is the normal case, not a problem.
  }

  try {
    const parsed: unknown = JSON.parse(text);
    if (!isObject(parsed)) {
      problems.push(`${path}: expected a JSON object`);
      return {};
    }
    return parsed;
  } catch {
    problems.push(`${path}: not valid JSON, ignoring it`);
    return {};
  }
}

function expandHome(p: string): string {
  return p.startsWith('~/') ? join(homedir(), p.slice(2)) : p;
}

/**
 * Apply one raw section over a typed default.
 *
 * Every value is checked against the default's own type, so a config file can
 * never widen a field into something the rest of the code does not expect.
 * A rejected value is reported and the default kept: this runs inside a hook,
 * where refusing to start is worse than ignoring one bad key.
 */
function applySection<T extends Record<string, unknown>>(
  name: string,
  base: T,
  raw: unknown,
  problems: string[],
): T {
  if (raw === undefined) return base;
  if (!isObject(raw)) {
    problems.push(`${name}: expected an object`);
    return base;
  }

  const out: Record<string, unknown> = { ...base };

  for (const [key, value] of Object.entries(raw)) {
    if (!(key in base)) {
      problems.push(`${name}.${key}: unknown setting, ignored`);
      continue;
    }

    const expected = base[key];
    const ok = Array.isArray(expected)
      ? Array.isArray(value) && value.every((v) => typeof v === 'string')
      : typeof value === typeof expected;

    if (!ok) {
      problems.push(`${name}.${key}: expected ${Array.isArray(expected) ? 'string[]' : typeof expected}, ignored`);
      continue;
    }
    out[key] = value;
  }

  return out as T;
}

function merge(base: Config, raw: Raw, problems: string[]): Config {
  const known = new Set(['publish', 'extract', 'tests', 'redaction', 'store', '$schema']);
  for (const key of Object.keys(raw)) {
    if (!known.has(key)) problems.push(`${key}: unknown section, ignored`);
  }

  const merged: Config = {
    publish: applySection('publish', base.publish, raw['publish'], problems),
    extract: applySection('extract', base.extract, raw['extract'], problems),
    tests: applySection('tests', base.tests, raw['tests'], problems),
    redaction: applySection('redaction', base.redaction, raw['redaction'], problems),
    store: applySection('store', base.store, raw['store'], problems),
    problems,
  };

  if (!PUBLISH_MODES.includes(merged.publish.mode)) {
    problems.push(`publish.mode: expected one of ${PUBLISH_MODES.join(', ')}, using ${base.publish.mode}`);
    merged.publish = { ...merged.publish, mode: base.publish.mode };
  }

  const valid = merged.redaction.extra_patterns.filter((p) => {
    try {
      new RegExp(p);
      return true;
    } catch {
      problems.push(`redaction.extra_patterns: ${JSON.stringify(p)} is not a valid regular expression, ignored`);
      return false;
    }
  });
  merged.redaction = { ...merged.redaction, extra_patterns: valid };

  if (!Number.isFinite(merged.store.retention_days) || merged.store.retention_days < 0) {
    problems.push(`store.retention_days: expected 0 or more days, using ${base.store.retention_days}`);
    merged.store = { ...merged.store, retention_days: base.store.retention_days };
  }
  if (merged.publish.max_chars < 1000) {
    problems.push(`publish.max_chars: below 1000 leaves no room for the log, using ${base.publish.max_chars}`);
    merged.publish = { ...merged.publish, max_chars: base.publish.max_chars };
  }

  merged.store = { ...merged.store, dir: expandHome(merged.store.dir) };
  return merged;
}

/**
 * Load configuration: repo over user over defaults.
 *
 * The repo file wins because it is committed and therefore the team's shared
 * policy; a personal file should not quietly weaken what a repository asks
 * for, in particular around redaction.
 */
export function loadConfig(
  repoRoot: string,
  userDir: string = join(homedir(), '.config', 'pdl'),
): Config {
  const problems: string[] = [];
  const user = readJson(join(userDir, 'config.json'), problems);
  const repo = readJson(join(repoRoot, 'pdl.config.json'), problems);

  return merge(merge(DEFAULT_CONFIG, user, problems), repo, problems);
}
