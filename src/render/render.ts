import type { DecisionLog } from './build-log.ts';

export const MARKER_START = '<!-- pdl:start';
export const MARKER_END = '<!-- pdl:end -->';

export type RenderOptions = {
  /** Budget out of GitHub's 65,536-character body limit. */
  maxChars?: number;
  toolUrl?: string;
};

const OUTCOME_LABEL: Record<string, string> = {
  pass: 'pass', fail: 'fail', interrupted: 'interrupted (cancelled)', unknown: 'unknown',
};

/**
 * Make a value safe for a markdown table cell.
 *
 * A pipe inside inline code still splits the row, so a command like
 * `npm test | tail -40` silently breaks the table on GitHub. Backticks do not
 * protect it; only the escape does. Lists are left alone, since escaping there
 * would render a literal backslash.
 */
function cell(value: string): string {
  return value.replace(/\|/g, '\\|');
}

function timeOnly(iso: string): string {
  const m = /T(\d{2}:\d{2})/.exec(iso);
  return m?.[1] ?? iso;
}

/**
 * Render the log as the PR section.
 *
 * Section order is load-bearing (DESIGN section 4): facts that are always
 * present come first, claims that are usually absent come last. Empty sections
 * are omitted entirely rather than rendered as "none recorded", which would
 * advertise a permanently blank slot.
 */
export function render(log: DecisionLog, options: RenderOptions = {}): string {
  const max = options.maxChars ?? 12_000;
  const tool = options.toolUrl ?? 'https://github.com/GcdZ03/pr-decision-log';

  const header = `${MARKER_START} v=1 sha=${log.repo.headSha ?? 'unknown'} -->\n## Decision log\n`;
  const blurb = `\n*Recorded automatically from the agent session on \`${log.branch}\`. Everything below is observed from tool events, not the model's self-report. [What this is](${tool}).*\n`;

  const sections: string[] = [];

  if (log.intent) sections.push(`\n**Intent**: ${log.intent}\n`);

  if (log.flags.length > 0) {
    const lines = log.flags.map((f) => {
      const where = f.file ? ` \`${f.file}\`` : '';
      return `- **${f.code}**${where} ${f.detail}`;
    });
    sections.push(`\n### Flags\n${lines.join('\n')}\n`);
  }

  if (log.verification.length > 0) {
    const rows = log.verification.map(
      (v) => `| ${timeOnly(v.at)} | \`${cell(v.command)}\` | ${OUTCOME_LABEL[v.outcome] ?? v.outcome} |`,
    );
    sections.push(`\n### Verification (recorded)\n\n| When | Command | Result |\n| --- | --- | --- |\n${rows.join('\n')}\n`);
  }

  if (log.changes.length > 0) {
    const rows = log.changes.map(
      (c) => `- \`${c.file}\` - ${c.edits} edit${c.edits === 1 ? '' : 's'}${c.role === 'test' ? ' (test)' : ''}`,
    );
    sections.push(`\n### Changes\n${rows.join('\n')}\n`);
  }

  // Claims last, per DESIGN principle 1: the facts above are always present,
  // these are usually absent, and a heading over nothing reads as a broken
  // tool rather than an honest one.
  const CLAIM_SECTIONS: { kind: string; heading: string }[] = [
    { kind: 'decision', heading: 'Decisions' },
    { kind: 'assumption', heading: 'Assumptions' },
    { kind: 'open_item', heading: 'Open items' },
  ];

  for (const { kind, heading } of CLAIM_SECTIONS) {
    const items = log.decisions.filter((d) => d.kind === kind);
    if (items.length === 0) continue;

    const lines = items.map((d) => {
      const label = d.confidence === 'confirmed_by_human' ? ' *(confirmed by a human)*' : ' *(stated)*';
      return `- ${d.text}${label}`;
    });
    sections.push(`\n### ${heading}\n${lines.join('\n')}\n`);
  }

  const footer = `\n<sub>Redaction: ${log.redaction.hits} rule(s) applied.</sub>\n${MARKER_END}\n`;

  let body = header + blurb + sections.join('') + footer;
  if (body.length <= max) return body;

  // Trim whole sections from the end (least load-bearing first) until it fits,
  // then hard-truncate the last one. Markers must always survive.
  const note = `\n*Log truncated to fit the PR body budget.*\n`;
  const kept: string[] = [];
  for (const s of sections) {
    const candidate = header + blurb + [...kept, s].join('') + note + footer;
    if (candidate.length > max) break;
    kept.push(s);
  }
  body = header + blurb + kept.join('') + note + footer;
  if (body.length <= max) return body;

  // Even the header plus note exceeds the budget: cut the blurb, then clamp.
  const minimal = header + note + footer;
  if (minimal.length <= max) return minimal;
  return `${header.slice(0, Math.max(0, max - MARKER_END.length - 1))}\n${MARKER_END}\n`;
}
