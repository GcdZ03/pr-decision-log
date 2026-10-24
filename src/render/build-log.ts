import type { EditEvent, TimelineEvent, Outcome } from '../events/types.ts';
import type { CommandKind } from '../events/classify-command.ts';
import { detectTestEditedAfterFailure, summariseCommand } from '../flags/test-edited-after-failure.ts';
import type { Flag } from '../flags/types.ts';
import { redact, type RedactionRule } from './redact.ts';
import { basename, isAbsolute } from 'node:path';
import { insideRepo, relativize, scrubPaths } from './relativize.ts';
import type { Decision } from '../extract/decisions.ts';
import { isTestFile } from '../flags/test-files.ts';
import { classifyCommand } from '../events/classify-command.ts';
import { expandWrites } from '../events/expand-writes.ts';
import { scriptSkeleton } from '../events/command-text.ts';
import { summariseChecks, type Check } from '../review/checks.ts';
import { neverRun, type NeverRun } from '../review/never-run.ts';
import { riskyFiles, type RiskyGroup } from '../review/risky.ts';
import { summariseScope, type Scope } from '../review/scope.ts';
import { analyzeDiff, assertionChanges, changedFiles, testOrigin, type FileStatus } from '../flags/diff-signals.ts';
import { isSourceCode, pairTests, type Coverage } from '../review/coverage.ts';

export type Verification = {
  at: string;
  kind: CommandKind;
  command: string;
  outcome: Outcome;
  exitCode?: number;
  durationMs?: number;
};

export type Change = {
  file: string;
  /** Times the agent wrote the file: edit-tool edits and shell writes (`cat >`, `sed -i`, a script). */
  edits: number;
  role: 'test' | 'source';
  /** From the PR diff. `not in diff`: the agent edited it but the diff does not contain it (uncommitted, or reverted). Absent with no diff. */
  status?: FileStatus | 'not in diff';
};

export type DecisionLog = {
  schema: 'pdl/1';
  generatedAt: string;
  repo: { remote: string; headSha?: string };
  branch: string;
  sessions: string[];
  intent?: string;
  /** Test, build and lint runs. Every other command is only counted, never listed. */
  verification: Verification[];
  otherCommands: number;
  changes: Change[];
  flags: Flag[];
  /** One entry per distinct test, build or lint fragment; `verification` keeps every run. */
  checks: Check[];
  neverRun: NeverRun[];
  risky: RiskyGroup[];
  /** Absent when there is no diff to measure. */
  scope?: Scope;
  /** In-repo files written in the session that the diff lacks and git does not ignore. */
  strayWrites: string[];
  /** Changed code paired with its changed tests, and the code without one. Absent with no diff. */
  coverage?: Coverage;
  /** Code edited after the last test run, which no test run covered. Absent when none was, or no test ran. */
  changedAfterTests?: { files: string[]; lastTestAt: string; lastEditAt: string };
  /** Branch commits no recorded git command made: the log's checks and flags do not cover them. */
  outsideCommits?: { sha: string; at: string }[];
  /** The pull request, for links to its files; only ever a github.com pull request URL. */
  prUrl?: string;
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
  /** Filters out paths git ignores; omitted, every path is kept. */
  notIgnored?: (paths: string[]) => string[];
  /** The branch's commits since its base, with committer times. */
  commits?: { sha: string; at: string }[];
  /** The pull request the log is published to, when known. */
  prUrl?: string;
};


/**
 * Turn a session timeline into the renderable document.
 *
 * This function is the structural allowlist from DESIGN section 9: it reads
 * `output` to derive flags, but never copies it into the result. Anything the
 * renderer can see has passed through here first.
 */
export function buildLog(
  recorded: TimelineEvent[],
  meta: LogMeta,
  decisions: Decision[] = [],
): DecisionLog {
  // Files written from the shell join the timeline as edits, so the flags and
  // the change list see them like any edit-tool edit.
  const events = expandWrites(recorded);
  const rules = new Set<string>();
  const clean = (s: string): string => {
    const { text, hits } = redact(s, meta.extraRedactions);
    for (const h of hits) rules.add(h);
    return text;
  };

  /**
   * A subagent's worktree inside the repository (`.claude/worktrees/<name>/`,
   * `.worktrees/<name>/`). Its branch is merged into this one, so a file
   * edited there is published under its path in the repository.
   */
  const NESTED_WORKTREE = /^(?:\.claude\/worktrees|\.?worktrees)\/[^/]+\//;
  const fromDiff = meta.diff ? changedFiles(meta.diff) : [];
  // Longest first, so `src/a/b.ts` wins over `b.ts` when matching a path's end.
  const diffPaths = fromDiff.map((f) => f.path).sort((a, b) => b.length - a.length);
  /**
   * A path as published. Without a repository root there is nothing to make
   * an absolute path relative to: it becomes its diff path when it ends with
   * one, and otherwise its name, never its location.
   */
  const rel = (p: string): string => {
    if (meta.repoRoot) return relativize(p, meta.repoRoot).replace(NESTED_WORKTREE, '');
    if (!isAbsolute(p)) return p;
    return diffPaths.find((d) => p.endsWith(`/${d}`)) ?? basename(p);
  };

  const verification: Verification[] = [];
  let otherCommands = 0;
  const edits = new Map<string, number>();
  const viaShellOnly = new Set<string>();

  for (const e of events) {
    if (e.kind === 'command') {
      // A reviewer acts on test, build and lint results. Everything else an
      // agent runs (file writes, searches, git) is noise in this table, and
      // its text is the most likely to hold file contents or private paths.
      // Classified now, not when recorded: the rules improve, and a stored
      // kind from an older version once listed a heredoc as a test run.
      const kind = classifyCommand(e.command);
      if (kind !== 'test' && kind !== 'build' && kind !== 'lint') {
        otherCommands += 1;
        continue;
      }
      // `summariseCommand` publishes the runner fragment only.
      verification.push({
        at: e.at,
        kind,
        command: clean(summariseCommand(e.command)),
        outcome: e.outcome,
        ...(e.exitCode !== undefined ? { exitCode: e.exitCode } : {}),
        ...(e.durationMs !== undefined ? { durationMs: e.durationMs } : {}),
      });
    } else {
      // An edit outside the repository is not part of the pull request.
      if (meta.repoRoot && !insideRepo(e.path, meta.repoRoot)) continue;
      const file = rel(e.path);
      if (e.via === 'shell' && !edits.has(file)) viaShellOnly.add(file);
      if (e.via !== 'shell') viaShellOnly.delete(file);
      edits.set(file, (edits.get(file) ?? 0) + 1);
    }
  }

  // The PR diff is the list of what changed, however it was written: agents
  // often write files from the shell, which no edit event records. The edit
  // tools' counts are added where they exist.
  const role = (file: string): Change['role'] => (isTestFile(file) ? 'test' : 'source');
  const changes: Change[] = fromDiff.length > 0
    ? [
        ...fromDiff.map((f) => ({ file: f.path, edits: edits.get(f.path) ?? 0, role: role(f.path), status: f.status })),
        // A file only ever written from the shell and absent from the diff is
        // a log, a scratch file or build output, not part of the change.
        ...[...edits].filter(([file]) => !fromDiff.some((f) => f.path === file) && !viaShellOnly.has(file))
          .map(([file, n]) => ({ file, edits: n, role: role(file), status: 'not in diff' as const })),
      ]
    : [...edits].map(([file, n]) => ({ file, edits: n, role: role(file) }));

  // Code the agent edited after its last test run was never tested by it. Any
  // test run counts: a later `npm test` re-verifies what `node --test` did.
  const testRuns = events.filter((e) => e.kind === 'command' && classifyCommand(e.command) === 'test');
  const lastTest = testRuns[testRuns.length - 1];
  const after = lastTest
    ? events.filter((e): e is EditEvent => e.kind === 'edit' && e.at > lastTest.at
        && (!meta.repoRoot || insideRepo(e.path, meta.repoRoot)) && isSourceCode(rel(e.path)))
    : [];
  const changedAfterTests = lastTest && after.length > 0
    ? { files: [...new Set(after.map((e) => rel(e.path)))], lastTestAt: lastTest.at, lastEditAt: after.map((e) => e.at).sort().at(-1)! }
    : undefined;

  // A commit is covered when a recorded command that makes commits ran at
  // that time (its duration, plus slack for clocks and hooks). Anything else
  // was made outside every recorded session, so nothing here speaks for it.
  const committing = events.filter((e) => e.kind === 'command'
    && /(?:^|[\s;&|(])(?:git\s+(?:-C\s+\S+\s+)?(?:commit|merge|rebase|cherry-pick|am|revert|pull)|gh\s+pr\s+merge)\b/.test(scriptSkeleton(e.command)));
  const covered = (at: string): boolean => committing.some((e) => {
    const t = Date.parse(at);
    const end = Date.parse(e.at);
    const start = end - (e.kind === 'command' ? e.durationMs ?? 0 : 0) - 120_000;
    return t >= start && t <= end + 60_000;
  });
  const outsideCommits = events.length > 0 && meta.commits ? meta.commits.filter((c) => !covered(c.at)) : [];

  const checks = summariseChecks(events).map((c) => ({ ...c, command: clean(c.command), tool: clean(c.tool) }));
  const present = fromDiff.filter((f) => f.status !== 'deleted').map((f) => f.path);
  const commandTexts = events.flatMap((e) => (e.kind === 'command' ? [e.command] : []));
  const missing = fromDiff.length > 0 ? neverRun(present, commandTexts) : [];
  const risky = riskyFiles(fromDiff.map((f) => f.path));
  const scope = fromDiff.length > 0 ? summariseScope(fromDiff) : undefined;
  const unlisted = [...edits.keys()].filter((file) => !fromDiff.some((f) => f.path === file));
  // Without a root, "inside the repository" cannot be decided, so nothing is listed.
  const strayWrites = fromDiff.length > 0 && meta.repoRoot ? (meta.notIgnored ? meta.notIgnored(unlisted) : unlisted) : [];

  const timeline = meta.flagEditAfterFailure === false ? [] : detectTestEditedAfterFailure(events);
  const flags: Flag[] = timeline.map((f) => {
    const file = rel(f.file);
    // Added or existing, from the failing test's own name; a file the PR
    // creates holds only added tests even when no test was named.
    const named = meta.diff ? (f.tests?.length ? f.tests : ['']).map((name) => ({ name, origin: testOrigin(meta.diff!, file, name) })) : [];
    const known = named.filter((n): n is { name: string; origin: 'added' | 'existing' } => n.origin !== undefined);
    const kinds = new Set(known.map((n) => n.origin));
    const origin = known.length === 0 ? undefined : kinds.size === 2 ? 'mixed' as const : known[0]!.origin;
    return {
      ...f,
      file,
      detail: clean(scrubPaths(f.file ? f.detail.replaceAll(f.file, file) : f.detail, meta.repoRoot)),
      ...(f.tests ? { tests: f.tests.map((t) => clean(scrubPaths(t, meta.repoRoot))) } : {}),
      ...(origin ? { origin } : {}),
      ...(() => {
        const changes = meta.diff && f.code === 'TEST_EDITED_AFTER_FAILURE' ? assertionChanges(meta.diff, file) : [];
        const safe = (t: string) => clean(scrubPaths(t, meta.repoRoot));
        return changes.length > 0 ? { assertionDiff: changes.map((c) => ({ removed: safe(c.removed), ...(c.added !== undefined ? { added: safe(c.added) } : {}) })) } : {};
      })(),
      ...(origin === 'mixed' ? { testOrigins: known.map((n) => ({ ...n, name: clean(scrubPaths(n.name, meta.repoRoot)) })) } : {}),
    };
  });

  // Code changed but nothing verified it.
  const ranATest = verification.some((v) => v.kind === 'test');
  if (changes.length > 0 && !ranATest) {
    flags.push({
      code: 'NO_TEST_RUN',
      severity: 'warn',
      file: '',
      detail: `${changes.length} ${changes.length === 1 ? 'file' : 'files'} changed and no test command was recorded in this session.`,
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
    otherCommands,
    changes,
    flags,
    checks,
    neverRun: missing,
    risky,
    ...(scope ? { scope } : {}),
    strayWrites,
    ...(fromDiff.length > 0 ? { coverage: pairTests(fromDiff) } : {}),
    ...(changedAfterTests ? { changedAfterTests } : {}),
    ...(outsideCommits.length > 0 ? { outsideCommits } : {}),
    // Links go into the PR body, so only a plain github.com pull request URL is kept.
    ...(meta.prUrl && /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+$/.test(meta.prUrl) ? { prUrl: meta.prUrl } : {}),
    // Model text, so it passes through the same redactor as everything else.
    decisions: decisions.map((d) => ({ ...d, text: clean(scrubPaths(d.text, meta.repoRoot)) })),
    redaction: { hits: rules.size, rules: [...rules] },
  };
}
