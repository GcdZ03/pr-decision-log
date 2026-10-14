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
const LISTED_STRAY = 10;

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

/** The first few items, then a pointer to the rest in the details. */
function capped(items: string[]): string[] {
  if (items.length <= VISIBLE_ITEMS) return items;
  return [...items.slice(0, VISIBLE_ITEMS), `- *…and ${items.length - VISIBLE_ITEMS} more in the details below.*`];
}

function details(log: DecisionLog, moreLook: string[], moreConfirmed: string[]): string {
  const parts: string[] = [];
  const summary: string[] = [];
  const checks = log.checks.filter((c) => !c.fixer);
  const fixers = log.checks.filter((c) => c.fixer);

  if (checks.length > 0) {
    const rows = checks.map((c) => `| ${cell(code(c.command))} | ${c.runs} | ${c.failures} | ${c.last} | ${hhmm(c.lastAt)} |`);
    parts.push(`#### Checks\n\n| Check | Runs | Failures | Last result | Last run |\n| --- | --- | --- | --- | --- |\n${rows.join('\n')}`);
    summary.push(`every check (${checks.length} distinct, ${checks.reduce((n, c) => n + c.runs, 0)} runs)`);
  }
  if (fixers.length > 0) parts.push(`Auto-fixes: ${fixers.map((c) => `${code(c.command)}${c.runs > 1 ? ` (${c.runs})` : ''}`).join(', ')}`);
  if (moreLook.length > 0) {
    parts.push(`#### More to look at\n${moreLook.join('\n')}`);
    summary.push(`more to look at (${moreLook.length})`);
  }
  if (moreConfirmed.length > 0) parts.push(`#### More decisions you confirmed\n${moreConfirmed.join('\n')}`);

  const notes = log.flags.filter((f) => f.severity === 'info');
  if (notes.length > 0) {
    parts.push(`#### Notes\n${notes.map((f) => flagLine(f, true)).join('\n')}`);
    summary.push(`notes (${notes.length})`);
  }

  const stated = log.decisions.filter((d) => d.confidence !== 'confirmed_by_human');
  if (stated.length > 0) {
    parts.push(`#### Stated by the agent\n${stated.map((d) => `- ${KIND_PREFIX[d.kind] ?? ''}${d.text} *(stated)*`).join('\n')}`);
    summary.push(`stated by the agent (${stated.length})`);
  }

  const files = log.changes.filter((c) => c.status !== 'not in diff');
  if (files.length > 0) {
    const rows = files.slice(0, LISTED_FILES).map((c) => {
      const tags = [...(c.status && c.status !== 'modified' ? [c.status] : []), ...(c.role === 'test' ? ['test'] : [])];
      return `- ${code(cell(c.file))}${tags.length ? ` (${tags.join(', ')})` : ''}`;
    });
    const rest = files.length - LISTED_FILES;
    parts.push(`#### Files\n${rows.join('\n')}${rest > 0 ? `\n\n*and ${count(rest, 'more file')}.*` : ''}`);
    summary.push(`every file (${files.length})`);
  }
  if (log.strayWrites.length > 0) {
    parts.push(`Written during the session but not in the diff: ${count(log.strayWrites.length, 'file')}: ${paths(log.strayWrites, LISTED_STRAY)}`);
  }
  if (log.otherCommands > 0) {
    parts.push(`${count(log.otherCommands, 'other command')} (file writes, searches, git) not listed.`);
    summary.push(count(log.otherCommands, 'other command'));
  }

  if (parts.length === 0) return '';
  return `\n<details><summary>${summary.join(' · ') || 'details'}</summary>\n\n${parts.join('\n\n')}\n\n</details>\n`;
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

  const visible = [`\n${checksLine(log)}\n${contextLine(log)}\n`];
  if (confirmed.length > 0) visible.push(`\n### Decisions you confirmed\n${capped(confirmed).join('\n')}\n`);
  if (look.length > 0) visible.push(`\n### Look here\n${capped(look).join('\n')}\n`);
  if (log.scope) visible.push(`\n### Scope\n${scopeLines(log.scope).join('\n')}\n`);

  const full = header + visible.join('') + details(log, look.slice(VISIBLE_ITEMS), confirmed.slice(VISIBLE_ITEMS)) + footer;
  if (full.length <= max) return full;

  // Over budget: the details go first, then visible blocks from the end.
  // The verdict line and both markers always survive.
  const note = '\n*Log truncated to fit the PR body budget; details omitted.*\n';
  for (let keep = visible.length; keep >= 1; keep--) {
    const body = header + visible.slice(0, keep).join('') + note + footer;
    if (body.length <= max) return body;
  }
  const minimal = header + `\n${checksLine(log)}\n` + note + MARKER_END + '\n';
  if (minimal.length <= max) return minimal;
  return `${header.slice(0, Math.max(0, max - MARKER_END.length - 1))}\n${MARKER_END}\n`;
}
