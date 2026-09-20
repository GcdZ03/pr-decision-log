import type { TimelineEvent, Outcome } from '../events/types.ts';
import type { CommandKind } from '../events/classify-command.ts';
import { detectTestEditedAfterFailure, summariseCommand } from '../flags/test-edited-after-failure.ts';
import type { Flag } from '../flags/types.ts';
import { redact } from './redact.ts';
import { relativize } from './relativize.ts';
import type { Decision } from '../extract/decisions.ts';

export type Verification = {
  at: string;
  kind: CommandKind;
  command: string;
  outcome: Outcome;
  exitCode?: number;
  durationMs?: number;
};

export type Change = { file: string; edits: number; role: 'test' | 'source' };

export type DecisionLog = {
  schema: 'pdl/1';
  generatedAt: string;
  repo: { remote: string; headSha?: string };
  branch: string;
  intent?: string;
  verification: Verification[];
  changes: Change[];
  flags: Flag[];
  /** Claims, kept in one list with a `kind` and split at render time. */
  decisions: Decision[];
  redaction: { hits: number; rules: string[] };
};

export type LogMeta = {
  repo: string;
  branch: string;
  headSha?: string;
  intent?: string;
  generatedAt?: string;
  /** Absolute paths are made relative to this before anything is published. */
  repoRoot?: string;
};

const TEST_DIR = /(^|\/)(tests?|spec|__tests__)\//i;
const TEST_FILE = /\.(test|spec)\.[cm]?[tj]sx?$|_test\.(go|py|rb)$|(^|\/)test_[^/]+\.py$|Tests?\.swift$|Test\.java$/;
const isTestFile = (p: string) => TEST_DIR.test(p) || TEST_FILE.test(p);

/**
 * Turn a session timeline into the renderable document.
 *
 * This function is the structural allowlist from DESIGN section 9: it reads
 * `output` to derive flags, but never copies it into the result. Anything the
 * renderer can see has passed through here first.
 */
export function buildLog(
  events: TimelineEvent[],
  meta: LogMeta,
  decisions: Decision[] = [],
): DecisionLog {
  const rules = new Set<string>();
  const clean = (s: string): string => {
    const { text, hits } = redact(s);
    for (const h of hits) rules.add(h);
    return text;
  };

  const rel = (p: string): string => (meta.repoRoot ? relativize(p, meta.repoRoot) : p);

  const verification: Verification[] = [];
  const changeMap = new Map<string, Change>();

  for (const e of events) {
    if (e.kind === 'command') {
      // `summariseCommand` also strips multi-line scripts and absolute paths.
      verification.push({
        at: e.at,
        kind: e.classification,
        command: clean(summariseCommand(e.command)),
        outcome: e.outcome,
        ...(e.exitCode !== undefined ? { exitCode: e.exitCode } : {}),
        ...(e.durationMs !== undefined ? { durationMs: e.durationMs } : {}),
      });
    } else {
      const file = rel(e.path);
      const existing = changeMap.get(file);
      if (existing) existing.edits += 1;
      else changeMap.set(file, { file, edits: 1, role: isTestFile(file) ? 'test' : 'source' });
    }
  }

  const flags: Flag[] = detectTestEditedAfterFailure(events).map((f) => ({
    ...f,
    file: rel(f.file),
    detail: clean(meta.repoRoot ? f.detail.replaceAll(f.file, rel(f.file)) : f.detail),
  }));

  // Code changed but nothing verified it.
  const ranATest = events.some((e) => e.kind === 'command' && e.classification === 'test');
  if (changeMap.size > 0 && !ranATest) {
    flags.push({
      code: 'NO_TEST_RUN',
      severity: 'warn',
      file: '',
      detail: `${changeMap.size} file(s) changed and no test command was recorded in this session.`,
      evidence: [],
    });
  }

  const intent = meta.intent === undefined ? undefined : clean(meta.intent);

  return {
    schema: 'pdl/1',
    generatedAt: meta.generatedAt ?? new Date().toISOString(),
    repo: { remote: meta.repo, ...(meta.headSha ? { headSha: meta.headSha } : {}) },
    branch: meta.branch,
    ...(intent !== undefined ? { intent } : {}),
    verification,
    changes: [...changeMap.values()],
    flags,
    // Model text, so it passes through the same redactor as everything else.
    decisions: decisions.map((d) => ({ ...d, text: clean(d.text) })),
    redaction: { hits: rules.size, rules: [...rules] },
  };
}
