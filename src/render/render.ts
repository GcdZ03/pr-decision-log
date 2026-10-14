import type { DecisionLog } from './build-log.ts';
import type { Flag, FlagCode } from '../flags/types.ts';
import type { Outcome } from '../events/types.ts';
import type { Scope } from '../review/scope.ts';
import { toolStatuses } from '../review/checks.ts';

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
const LISTED_FILES = 100;
/** The Files list once the budget is tight. */
const SHORT_FILES = 30;
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

const KIND_PREFIX: Record<string, string> = { decision: '', assumption: 'Assumption: ', open_item: 'Open item: ' };

/** Inline code that survives a backtick in the value. */
const code = (s: string): string => (s.includes('`') ? `\`\`${s}\`\`` : `\`${s}\``);
/** A table cell: a pipe splits the row even inside backticks, so it is escaped. */
const cell = (s: string): string => s.replace(/\|/g, '\\|');
const hhmm = (iso: string): string => /T(\d{2}:\d{2})/.exec(iso)?.[1] ?? iso;
const count = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;
const num = (n: number): string => n.toLocaleString('en-US');
const paths = (list: string[], max = LISTED_PATHS): string =>
  list.slice(0, max).map(code).join(', ') + (list.length > max ? ` +${list.length - max} more` : '');

function flagLine(f: Flag, note = false): string {
  const where = f.file ? ` ${code(f.file)}` : '';
  return `- **${LABEL[f.code]}**${note ? ' *(note)*' : ''}${where}: ${f.detail}`;
}

function checksLine(log: DecisionLog): string {
  const tools = toolStatuses(log.checks);
  if (tools.length === 0) return '**Checks:** none were run.';
  return `**Checks (last run):** ${tools.map((t) => `${t.tool} ${MARK[t.status]}`).join(' · ')}`;
}

function contextLine(log: DecisionLog): string {
  const never = log.neverRun.map((x) => `${x.check} (${x.because})`).join(' · ');
  return `${never ? `**Never run:** ${never} · ` : ''}Intent: see the PR description.`;
}

function lookHere(log: DecisionLog): string[] {
  const warnings = log.flags.filter((f) => f.severity === 'warn');
  const items = WARNING_ORDER.flatMap((c) => warnings.filter((f) => f.code === c).map((f) => flagLine(f)));
  if (log.risky.length > 0) {
    items.push(`- **Privileged or risky files:** ${log.risky.map((g) => `${g.category.toLowerCase()}: ${paths(g.paths)}`).join(' · ')}`);
  }
  return items;
}

function scopeLines(s: Scope): string[] {
  const statuses = [
    s.created ? `${s.created} added` : '', s.deleted ? `${s.deleted} deleted` : '', s.renamed ? `${s.renamed} renamed` : '',
  ].filter(Boolean);
  const areas = s.areas.join(' · ') + (s.moreAreas > 0 ? ` +${s.moreAreas} more` : '');
  const first = `+${num(s.added)} −${num(s.removed)} lines · ${count(s.files, 'file')}`
    + (statuses.length ? ` (${statuses.join(', ')})` : '') + (areas ? ` · ${areas}` : '');
  const second = [
    s.testsChanged > 0 ? `Tests: ${count(s.testsChanged, 'file')} changed${s.testsAdded ? ` (${s.testsAdded} added)` : ''}` : '',
    s.largest.length > 0 ? `Largest: ${s.largest.map((l) => `${code(l.path)} (${num(l.lines)} lines)`).join(', ')}` : '',
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
 * a step at a time (spec 7: least important first): the Files list, then the
 * passing checks, then the stated block, then everything but what a visible
 * pointer refers to.
 */
type DetailLevel = {
  /** Files listed by name; 0 gives the count only; undefined drops the block. */
  files?: number;
  /** `failing`: only checks whose last run did not pass, with a count of the rest. */
  checks?: 'all' | 'failing';
  stated: boolean;
  /** Notes, auto-fixes, stray writes and the other-command count. */
  extras: boolean;
  moreLook: boolean;
  moreConfirmed: boolean;
};

const LEVELS: DetailLevel[] = [
  { files: LISTED_FILES, checks: 'all', stated: true, extras: true, moreLook: true, moreConfirmed: true },
  { files: SHORT_FILES, checks: 'all', stated: true, extras: true, moreLook: true, moreConfirmed: true },
  { files: 0, checks: 'all', stated: true, extras: true, moreLook: true, moreConfirmed: true },
  { files: 0, checks: 'failing', stated: true, extras: true, moreLook: true, moreConfirmed: true },
  { files: 0, checks: 'failing', stated: false, extras: true, moreLook: true, moreConfirmed: true },
  { stated: false, extras: false, moreLook: true, moreConfirmed: true },
  { stated: false, extras: false, moreLook: true, moreConfirmed: false },
  { stated: false, extras: false, moreLook: false, moreConfirmed: false },
];

function details(log: DecisionLog, moreLook: string[], moreConfirmed: string[], level: DetailLevel): string {
  const parts: string[] = [];
  const summary: string[] = [];
  const checks = log.checks.filter((c) => !c.fixer);
  const fixers = log.checks.filter((c) => c.fixer);

  if (checks.length > 0 && level.checks) {
    const shown = level.checks === 'all' ? checks : checks.filter((c) => c.last !== 'pass');
    const rows = shown.map((c) => `| ${cell(code(c.command))} | ${c.runs} | ${c.failures} | ${c.last} | ${hhmm(c.lastAt)} |`);
    const table = rows.length > 0 ? `\n\n| Check | Runs | Failures | Last result | Last run |\n| --- | --- | --- | --- | --- |\n${rows.join('\n')}` : '';
    const passed = checks.length - shown.length;
    parts.push(`#### Checks${table}${passed > 0 ? `\n\n*${count(passed, rows.length > 0 ? 'more check' : 'check')} passed on ${passed === 1 ? 'its' : 'their'} last run.*` : ''}`);
    const runs = count(checks.reduce((n, c) => n + c.runs, 0), 'run');
    summary.push(`${level.checks === 'all' ? 'every check' : 'checks'} (${checks.length} distinct, ${runs})`);
  }
  if (fixers.length > 0 && level.extras) parts.push(`Auto-fixes: ${fixers.map((c) => `${code(c.command)}${c.runs > 1 ? ` (${c.runs})` : ''}`).join(', ')}`);
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
    parts.push(`#### Notes\n${notes.map((f) => flagLine(f, true)).join('\n')}`);
    summary.push(`notes (${notes.length})`);
  }

  const stated = log.decisions.filter((d) => d.confidence !== 'confirmed_by_human');
  if (stated.length > 0 && level.stated) {
    parts.push(`#### Stated by the agent\n${stated.map((d) => `- ${KIND_PREFIX[d.kind] ?? ''}${d.text} *(stated)*`).join('\n')}`);
    summary.push(`stated by the agent (${stated.length})`);
  }

  const files = log.changes.filter((c) => c.status !== 'not in diff');
  if (files.length > 0 && level.files !== undefined) {
    const listed = Math.min(files.length, level.files);
    const rows = files.slice(0, listed).map((c) => {
      const tags = [...(c.status && c.status !== 'modified' ? [c.status] : []), ...(c.role === 'test' ? ['test'] : [])];
      return `- ${code(c.file)}${tags.length ? ` (${tags.join(', ')})` : ''}`;
    });
    const rest = files.length - listed;
    // The full list ends with a plain count; a list cut for the budget says where the rest is.
    const tail = listed === 0
      ? `*${count(files.length, 'file')}; see the Files changed tab.*`
      : rest > 0 ? `*and ${count(rest, 'more file')}${level.files === LISTED_FILES ? '' : '; see the Files changed tab'}.*` : '';
    parts.push(`#### Files${rows.length ? `\n${rows.join('\n')}` : ''}${tail ? `${rows.length ? '\n\n' : '\n'}${tail}` : ''}`);
    summary.push(`${rest === 0 ? 'every file' : 'files'} (${files.length})`);
  }
  if (log.strayWrites.length > 0 && level.extras) {
    parts.push(`Written during the session but not in the diff: ${count(log.strayWrites.length, 'file')}: ${paths(log.strayWrites, LISTED_STRAY)}`);
  }
  if (log.otherCommands > 0 && level.extras) {
    parts.push(`${count(log.otherCommands, 'other command')} (file writes, searches, git) not listed.`);
    summary.push(count(log.otherCommands, 'other command'));
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
  const footer = `\n<sub>Recorded from ${from} on ${code(log.branch)}: observed from tool events, not the model's own account; times are UTC. [What this is](${tool}) · Redaction: ${count(log.redaction.hits, 'rule')} applied.</sub>\n${MARKER_END}\n`;

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
    const blocks = [`\n${checksLine(log)}\n${contextLine(log)}${note ? ` ${note}` : ''}\n`];
    if (confirmed.length > 0 && !dropped.includes(CONFIRMED)) {
      blocks.push(`\n### Decisions you confirmed\n${capped(confirmed, level.moreConfirmed).join('\n')}\n`);
    }
    if (look.length > 0 && !dropped.includes(LOOK)) blocks.push(`\n### Look here\n${capped(look, level.moreLook).join('\n')}\n`);
    if (log.scope && !dropped.includes(SCOPE)) blocks.push(`\n### Scope\n${scopeLines(log.scope).join('\n')}\n`);
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
