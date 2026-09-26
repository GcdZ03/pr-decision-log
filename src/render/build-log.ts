import type { TimelineEvent, Outcome } from '../events/types.ts';
import type { CommandKind } from '../events/classify-command.ts';
import { detectTestEditedAfterFailure, summariseCommand } from '../flags/test-edited-after-failure.ts';
import type { Flag } from '../flags/types.ts';
import { redact, type RedactionRule } from './redact.ts';
import { relativize } from './relativize.ts';
import type { Decision } from '../extract/decisions.ts';
import { isTestFile } from '../flags/test-files.ts';
import { analyzeDiff } from '../flags/diff-signals.ts';

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
  sessions: string[];
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
  /** Unified diff of the pull request, for the diff-side test signals. Paths are already repo-relative. */
  diff?: string;
  /** Sessions the log was built from; more than one when a PR spans sessions. */
  sessions?: string[];
  /** `tests.flag_edit_after_failure`; on unless set to false. */
  flagEditAfterFailure?: boolean;
  /** From `redaction.extra_patterns`, applied on top of the built-in rules. */
  extraRedactions?: RedactionRule[];
};


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
    const { text, hits } = redact(s, meta.extraRedactions);
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

  const timeline = meta.flagEditAfterFailure === false ? [] : detectTestEditedAfterFailure(events);
  const flags: Flag[] = timeline.map((f) => ({
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

  // What changed in the tests, alongside the timeline's when. Details quote diff
  // lines, so they go through the redactor like any other text.
  if (meta.diff) {
    const corroborated = new Set(flags.filter((f) => f.code === 'TEST_EDITED_AFTER_FAILURE').map((f) => f.file));
    for (const f of analyzeDiff(meta.diff, { corroborated })) flags.push({ ...f, detail: clean(f.detail) });
  }

  const intent = meta.intent === undefined ? undefined : clean(meta.intent);

  return {
    schema: 'pdl/1',
    generatedAt: meta.generatedAt ?? new Date().toISOString(),
    repo: { remote: meta.repo, ...(meta.headSha ? { headSha: meta.headSha } : {}) },
    branch: meta.branch,
    sessions: meta.sessions ?? [],
    ...(intent !== undefined ? { intent } : {}),
    verification,
    changes: [...changeMap.values()],
    flags,
    // Model text, so it passes through the same redactor as everything else.
    decisions: decisions.map((d) => ({ ...d, text: clean(d.text) })),
    redaction: { hits: rules.size, rules: [...rules] },
  };
}
