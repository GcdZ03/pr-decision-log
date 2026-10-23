import { createHash } from 'node:crypto';
import type { DecisionLog } from './build-log.ts';
import type { Flag, FlagCode } from '../flags/types.ts';
import type { Outcome } from '../events/types.ts';
import type { Scope } from '../review/scope.ts';
import { toolStatuses, type Check } from '../review/checks.ts';

export const MARKER_START = '<!-- pdl:start';
export const MARKER_END = '<!-- pdl:end -->';

export type RenderOptions = {
  /** Budget out of GitHub's 65,536-character body limit. */
  maxChars?: number;
  toolUrl?: string;
};

/** Spec 5: non-empty lines between the heading and the details. */
export const VISIBLE_LINE_BUDGET = 15;
const VISIBLE_ITEMS = 3;
const LISTED_PATHS = 3;
const LISTED_STRAY = 10;

/** Visible blocks the budget may drop, named as the cut note names them. */
const SCOPE = 'Scope';
const CONFIRMED = 'Decisions you confirmed';
const LOOK = 'Look here';

const LABEL: Record<FlagCode, string> = {
  TEST_EDITED_AFTER_FAILURE: 'Test changed after it failed',
  NO_TEST_RUN: 'No test was run',
  TEST_ONLY_CHANGE: 'Only tests changed',
  ASSERTIONS_REMOVED: 'Assertions removed',
  TEST_SKIPPED: 'Test skipped',
  TEST_DELETED: 'Tests deleted',
  EXPECTATION_LOOSENED: 'Expected value changed',
};

/** Look-here order (spec 6.4): timeline first, then diff warnings, then no test at all. */
const WARNING_ORDER: FlagCode[] = [
  'TEST_EDITED_AFTER_FAILURE', 'TEST_SKIPPED', 'ASSERTIONS_REMOVED', 'TEST_DELETED',
  'EXPECTATION_LOOSENED', 'TEST_ONLY_CHANGE', 'NO_TEST_RUN',
];

const MARK: Record<Outcome, string> = { pass: '✓', fail: '✗ (failed, not re-run)', interrupted: '✗ (interrupted)', unknown: '?' };


/** Inline code that survives a backtick in the value. */
const code = (s: string): string => (s.includes('`') ? `\`\`${s}\`\`` : `\`${s}\``);
/** A table cell: a pipe splits the row even inside backticks, so it is escaped. */
const cell = (s: string): string => s.replace(/\|/g, '\\|');
const hhmm = (iso: string): string => /T(\d{2}:\d{2})/.exec(iso)?.[1] ?? iso;
const count = (n: number, one: string, many = `${one}s`): string => `${num(n)} ${n === 1 ? one : many}`;
const num = (n: number): string => n.toLocaleString('en-US');
const paths = (list: string[], max = LISTED_PATHS): string =>
  list.slice(0, max).map(code).join(', ') + (list.length > max ? ` +${list.length - max} more` : '');

/** Lower case mid-sentence, except the acronym. */
const category = (name: string): string => name.toLowerCase().replace(/\bci\b/, 'CI');

/**
 * A file, linked to its diff in the PR's Files tab when the PR is known.
 * GitHub anchors each file at `#diff-<sha256 of its path>`, so one click goes
 * from a flag to the change it is about.
 */
function fileRef(log: DecisionLog, path: string): string {
  if (!log.prUrl) return code(path);
  return `[${code(path)}](${log.prUrl}/files#diff-${createHash('sha256').update(path).digest('hex')})`;
}

const fileRefs = (log: DecisionLog, list: string[], max = LISTED_PATHS): string =>
  list.slice(0, max).map((p) => fileRef(log, p)).join(', ') + (list.length > max ? ` +${list.length - max} more` : '');

/** Whether the changed test was new, which decides the reviewer's question. */
const ORIGIN: Record<string, string> = { added: ' *(a test this PR added)*', existing: ' *(an existing test)*' };

/** Names which failing test is new and which existed, at most two of each. */
function mixedOrigin(f: Flag): string {
  const of = (o: 'added' | 'existing') => (f.testOrigins ?? []).filter((t) => t.origin === o).map((t) => t.name);
  const list = (names: string[]) => names.slice(0, 2).map(code).join(', ') + (names.length > 2 ? ` +${names.length - 2} more` : '');
  return ` *(${list(of('added'))} added by this PR; ${list(of('existing'))} existed)*`;
}

function flagLine(log: DecisionLog, f: Flag, note = false): string {
  const where = f.file ? ` ${fileRef(log, f.file)}` : '';
  const origin = f.origin === 'mixed' ? mixedOrigin(f) : f.origin ? ORIGIN[f.origin] ?? '' : '';
  const changes = f.assertionDiff ?? [];
  const diffNote = changes.length === 0 ? '' : ` Diff: ${changes.slice(0, 2).map((c) => (c.added !== undefined ? `${code(c.removed)} → ${code(c.added)}` : `${code(c.removed)} removed`)).join('; ')}${changes.length > 2 ? ` +${changes.length - 2} more` : ''}.`;
  return `- **${LABEL[f.code]}**${origin}${note ? ' *(note)*' : ''}${where}: ${f.detail}${diffNote}`;
}

function checksLine(log: DecisionLog): string {
  const tools = toolStatuses(log.checks);
  if (tools.length === 0) return '**Checks:** none were run.';
  return `**Checks (last run):** ${tools.map((t) => `${t.tool} ${MARK[t.status]}`).join(' · ')}`;
}

/** The second verdict line: what the session never checked. Empty when there is nothing to say. */
function contextLine(log: DecisionLog): string {
  const parts: string[] = [];
  const never = log.neverRun.map((x) => `${x.check} (${x.because})`).join(' · ');
  if (never) parts.push(`**Never run:** ${never}`);
  const stale = log.changedAfterTests;
  if (stale) {
    const later = gap(stale.lastTestAt, stale.lastEditAt);
    parts.push(`**Changed after the last test run:** ${paths(stale.files)}${later ? ` (${later} later)` : ''}`);
  }
  const outside = log.outsideCommits ?? [];
  if (outside.length > 0) {
    const ref = (c: { sha: string }) => (log.prUrl ? `[${code(c.sha.slice(0, 7))}](${log.prUrl}/commits/${c.sha})` : code(c.sha.slice(0, 7)));
    const list = outside.slice(0, LISTED_PATHS).map(ref).join(', ') + (outside.length > LISTED_PATHS ? ` +${outside.length - LISTED_PATHS} more` : '');
    parts.push(`**Not covered by this log:** ${count(outside.length, 'commit')} made outside the recorded sessions: ${list}`);
  }
  return parts.join(' · ');
}

/** A time gap in s, min or h. Empty for an unparseable or negative gap. */
function gap(from: string, to: string): string {
  const s = Math.round((Date.parse(to) - Date.parse(from)) / 1000);
  if (!Number.isFinite(s) || s < 0) return '';
  if (s < 60) return `${s} s`;
  if (s < 3600) return `${Math.round(s / 60)} min`;
  return `${Math.round(s / 3600)} h`;
}

function lookHere(log: DecisionLog): string[] {
  const warnings = log.flags.filter((f) => f.severity === 'warn');
  const items = WARNING_ORDER.flatMap((c) => warnings.filter((f) => f.code === c).map((f) => flagLine(log, f)));
  if (log.risky.length > 0) {
    items.push(`- **Privileged or risky files:** ${log.risky.map((g) => `${category(g.category)}: ${fileRefs(log, g.paths)}`).join(' · ')}`);
  }
  return items;
}

function scopeLines(log: DecisionLog, s: Scope): string[] {
  const statuses = [
    s.created ? `${s.created} added` : '', s.deleted ? `${s.deleted} deleted` : '', s.renamed ? `${s.renamed} renamed` : '',
  ].filter(Boolean);
  const areas = s.areas.join(' · ') + (s.moreAreas > 0 ? ` +${s.moreAreas} more` : '');
  const first = `+${num(s.added)} −${num(s.removed)} lines · ${count(s.files, 'file')}`
    + (statuses.length ? ` (${statuses.join(', ')})` : '') + (areas ? ` · ${areas}` : '');
  const second = [
    s.testsChanged > 0 ? `Tests: ${count(s.testsChanged, 'file')} changed${s.testsAdded ? ` (${s.testsAdded} added)` : ''}` : '',
    log.coverage && log.coverage.untested.length > 0 ? `no matching test change: ${count(log.coverage.untested.length, 'source file')}` : '',
  ].filter(Boolean).join(' · ');
  return second ? [first, second] : [first];
}

/**
 * The first few items, then a pointer to the rest: to the details when they
 * hold the rest, or a plain statement when the budget cut it.
 */
function capped(items: string[], restInDetails: boolean): string[] {
  if (items.length <= VISIBLE_ITEMS) return items;
  const rest = items.length - VISIBLE_ITEMS;
  return [...items.slice(0, VISIBLE_ITEMS), restInDetails ? `- *…and ${rest} more in the details below.*` : `- *…and ${rest} more, cut to fit the PR body.*`];
}

/**
 * How much of the details a body carries. Under budget pressure they shrink
 * a step at a time, least important first: the reading aids, then the
 * failed-checks table, then the blocks a visible pointer refers to.
 */
type DetailLevel = {
  /** The table of checks that failed at least once. */
  checks: boolean;
  /** Code and tests, notes and stray writes. */
  extras: boolean;
  moreLook: boolean;
  moreConfirmed: boolean;
};

const LEVELS: DetailLevel[] = [
  { checks: true, extras: true, moreLook: true, moreConfirmed: true },
  { checks: true, extras: false, moreLook: true, moreConfirmed: true },
  { checks: false, extras: false, moreLook: true, moreConfirmed: true },
  { checks: false, extras: false, moreLook: true, moreConfirmed: false },
  { checks: false, extras: false, moreLook: false, moreConfirmed: false },
];

/**
 * The collapsed details: only what a reviewer can act on and cannot see
 * elsewhere. The file list (GitHub's Files tab), passing checks (the
 * Checks line), auto-fixes, other commands and the agent's own stated
 * reasons were here once and are not: each repeated something or led to
 * nothing.
 */
function details(log: DecisionLog, moreLook: string[], moreConfirmed: string[], level: DetailLevel): string {
  const parts: string[] = [];
  const summary: string[] = [];

  // A check's story is its failures: one that only ever passed is a tick above.
  const failed = log.checks.filter((c) => !c.fixer && c.failures > 0);
  if (failed.length > 0 && level.checks) {
    const result = (c: Check) => (c.supersededBy ? `${c.last}, then ${code(c.supersededBy.command)} passed at ${hhmm(c.supersededBy.at)}` : c.last);
    const rows = failed.map((c) => `| ${cell(code(c.command))} | ${c.runs} | ${c.failures} | ${cell(result(c))} | ${hhmm(c.lastAt)} |`);
    parts.push(`#### Checks that failed\n\n| Check | Runs | Failures | Last result | Last run |\n| --- | --- | --- | --- | --- |\n${rows.join('\n')}`);
    summary.push(`checks that failed (${failed.length})`);
  }
  if (moreLook.length > 0 && level.moreLook) {
    parts.push(`#### More to look at\n${moreLook.join('\n')}`);
    summary.push(`more to look at (${moreLook.length})`);
  }
  if (moreConfirmed.length > 0 && level.moreConfirmed) {
    parts.push(`#### More decisions you confirmed\n${moreConfirmed.join('\n')}`);
    summary.push(`more decisions (${moreConfirmed.length})`);
  }

  const notes = log.flags.filter((f) => f.severity === 'info');
  if (notes.length > 0 && level.extras) {
    parts.push(`#### Notes\n${notes.map((f) => flagLine(log, f, true)).join('\n')}`);
    summary.push(`notes (${notes.length})`);
  }

  // A reading aid, not coverage: a file can be tested by a test this PR left alone.
  const cov = log.coverage;
  if (cov && (cov.pairs.length > 0 || cov.untested.length > 0) && level.extras) {
    const pairs = cov.pairs.map((p) => `- ${code(p.source)} ↔ ${p.tests.map(code).join(', ')}`);
    const untested = cov.untested.length > 0 ? `Changed with no matching test change: ${paths(cov.untested, LISTED_STRAY)}` : '';
    parts.push(`#### Code and tests${pairs.length ? `\n${pairs.join('\n')}` : ''}${untested ? `${pairs.length ? '\n\n' : '\n'}${untested}` : ''}`);
    summary.push('code and tests');
  }
  if (log.strayWrites.length > 0 && level.extras) {
    parts.push(`Written during the session but not in the diff: ${count(log.strayWrites.length, 'file')}: ${paths(log.strayWrites, LISTED_STRAY)}`);
    summary.push(`written but not in the diff (${log.strayWrites.length})`);
  }

  if (parts.length === 0) return '';
  return `\n<details><summary>${summary.join(' · ') || 'details'}</summary>\n\n${parts.join('\n\n')}\n\n</details>\n`;
}

const listed = (names: string[]): string =>
  names.length <= 1 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;

/** Says exactly what the budget cut; empty when nothing was. */
function cutNote(detailsCut: 'none' | 'some' | 'all', blocks: string[]): string {
  const named = blocks.length > 0 ? `the ${listed(blocks)} ${blocks.length > 1 ? 'blocks' : 'block'}` : '';
  if (detailsCut === 'none' && !named) return '';
  const subject = detailsCut === 'some' ? 'Some details' : detailsCut === 'all' ? (named ? `Details and ${named}` : 'Details') : named.replace(/^t/, 'T');
  const verb = detailsCut === 'none' && blocks.length === 1 ? 'was' : 'were';
  return `*${subject} ${verb} cut to fit the PR body.*`;
}

/**
 * Render the log for a reviewer (spec docs/superpowers/specs/2026-10-14-reviewer-first-log-design.md).
 *
 * The visible part answers, in order: did the checks pass, what was never
 * checked, what the human decided, where to look, and how big the change is.
 * Every block is left out when it has nothing to say, and everything else
 * is collapsed, since more bot output measurably slows review.
 */
export function render(log: DecisionLog, options: RenderOptions = {}): string {
  const max = options.maxChars ?? 12_000;
  const tool = options.toolUrl ?? 'https://github.com/GcdZ03/pr-decision-log';

  const header = `${MARKER_START} v=1 sha=${log.repo.headSha ?? 'unknown'} -->\n## Decision log\n`;
  const from = log.sessions.length > 1 ? `${log.sessions.length} agent sessions` : 'the agent session';
  const footer = `\n<sub>Recorded from ${from} on ${code(log.branch)}: observed from tool events, not the model's own account; times are UTC. [What this is](${tool})</sub>\n${MARKER_END}\n`;

  const look = lookHere(log);
  const confirmed = log.decisions.filter((d) => d.confidence === 'confirmed_by_human').map((d) => `- ${d.text}`);
  const moreLook = look.slice(VISIBLE_ITEMS);
  const moreConfirmed = confirmed.slice(VISIBLE_ITEMS);
  const anyDetails = details(log, moreLook, moreConfirmed, LEVELS[0]!) !== '';

  /**
   * One candidate body. The note joins the second verdict line rather than
   * adding a line, so the visible budget holds however much is cut.
   */
  const body = (level: DetailLevel, levelIndex: number, dropped: string[]): string => {
    const detailsText = details(log, moreLook, moreConfirmed, level);
    const detailsCut = levelIndex === 0 || !anyDetails ? 'none' : detailsText ? 'some' : 'all';
    const note = cutNote(detailsCut, dropped);
    // The note joins the second line, or is the second line when there is none.
    const second = [contextLine(log), note].filter(Boolean).join(' ');
    const blocks = [`\n${checksLine(log)}${second ? `\n${second}` : ''}\n`];
    if (confirmed.length > 0 && !dropped.includes(CONFIRMED)) {
      blocks.push(`\n### Decisions you confirmed\n${capped(confirmed, level.moreConfirmed).join('\n')}\n`);
    }
    if (look.length > 0 && !dropped.includes(LOOK)) blocks.push(`\n### Look here\n${capped(look, level.moreLook).join('\n')}\n`);
    if (log.scope && !dropped.includes(SCOPE)) blocks.push(`\n### Scope\n${scopeLines(log, log.scope).join('\n')}\n`);
    return header + blocks.join('') + detailsText + footer;
  };

  // Over budget: the details shrink, then go, then visible blocks go in the
  // order Scope, Decisions, Look here. The verdict lines and both markers
  // always survive.
  for (const [i, level] of LEVELS.entries()) {
    const md = body(level, i, []);
    if (md.length <= max) return md;
  }
  const none = LEVELS[LEVELS.length - 1]!;
  const droppable = [SCOPE, CONFIRMED, LOOK].filter((b) =>
    (b === SCOPE && log.scope) || (b === CONFIRMED && confirmed.length > 0) || (b === LOOK && look.length > 0));
  for (let n = 1; n <= droppable.length; n++) {
    const md = body(none, LEVELS.length - 1, droppable.slice(0, n));
    if (md.length <= max) return md;
  }
  const minimal = `${header}\n${checksLine(log)}\n*The log was cut to fit the PR body.*\n${MARKER_END}\n`;
  if (minimal.length <= max) return minimal;
  return `${header.slice(0, Math.max(0, max - MARKER_END.length - 1))}\n${MARKER_END}\n`;
}
