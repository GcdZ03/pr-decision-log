#!/usr/bin/env node
/**
 * Phase 0 spike, part 3: measure rule 4, the yield the first spike never looked at.
 *
 * `spike-yield.mjs` measures rule 3 from DESIGN.md section 10: assistant text
 * in the few entries immediately BEFORE an edit. That scored 3% and the design
 * was rewritten around it. But rule 4 (`last_assistant_message` on `Stop`) was
 * never measured, and agents justify work in the wrap-up, not before each edit.
 *
 * Method: a turn-final assistant message is the last assistant entry carrying
 * text before the next real user prompt (a user entry that is not a tool_result
 * carrier), plus the last such entry in the file. Test each for the same
 * rationale cues rule 3 uses.
 *
 * Read the output as an UPPER BOUND, not a yield: a cue hit in 2 KB of prose is
 * far weaker evidence than a cue hit in the sentence before an edit. See the
 * caveats in docs/spike-notes.md.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

// Same cue set as spike-yield.mjs, minus the bare /\bwhy\b/, which fires on
// questions ("why is this failing?") far more often than on rationale.
const RATIONALE = [
  /\bbecause\b/i, /\binstead of\b/i, /\brather than\b/i, /\bchose\b/i,
  /\bchoosing\b/i, /\btrade-?off\b/i, /\bassum/i, /\bso that\b/i,
  /\bthe reason\b/i, /\bavoids?\b/i, /\bprefer(?:red|ring)?\b/i,
  /\bdecided\b/i, /\balternative\b/i,
];

const LONG_TEXT = 400; // chars; a block this size is a summary, not narration

function walk(dir) {
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else if (e.name.endsWith('.jsonl')) out.push(p);
  }
  return out;
}

function parse(file) {
  const rows = [];
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try { rows.push(JSON.parse(line)); } catch { /* partial write */ }
  }
  return rows;
}

const textOf = (r) => (r?.message?.content ?? [])
  .filter((b) => b.type === 'text' && b.text?.trim())
  .map((b) => b.text)
  .join('\n');

// A user entry that carries a tool_result is the transcript's way of returning
// output to the model, not a human turn. Only the others end a turn.
function isRealPrompt(r) {
  if (r?.type !== 'user') return false;
  const c = r?.message?.content;
  if (typeof c === 'string') return c.trim().length > 0;
  if (!Array.isArray(c)) return false;
  return !c.some((b) => b.type === 'tool_result');
}

function analyse(file) {
  const rows = parse(file);

  let edits = 0, plans = 0, longText = 0, longTextCue = 0;
  const finals = [];
  let pending = null; // last assistant entry with text since the last prompt

  for (const r of rows) {
    if (r.type === 'assistant') {
      for (const b of r?.message?.content ?? []) {
        if (b.type === 'tool_use' && EDIT_TOOLS.has(b.name)) edits++;
        if (b.type === 'tool_use' && b.name === 'ExitPlanMode') plans++;
        if (b.type === 'text' && (b.text ?? '').length >= LONG_TEXT) {
          longText++;
          if (RATIONALE.some((re) => re.test(b.text))) longTextCue++;
        }
      }
      const t = textOf(r);
      if (t.trim()) pending = t;
    } else if (isRealPrompt(r) && pending) {
      finals.push(pending);
      pending = null;
    }
  }
  if (pending) finals.push(pending); // end of transcript closes the last turn

  const withCue = finals.filter((t) => RATIONALE.some((re) => re.test(t)));

  return {
    edits,
    plans,
    longText,
    longTextCue,
    finals: finals.length,
    finalsWithCue: withCue.length,
    samples: withCue.slice(0, 1).map((t) => t.trim().slice(0, 200).replace(/\s+/g, ' ')),
  };
}

const root = join(homedir(), '.claude', 'projects');
const files = walk(root)
  .map((f) => ({ f, size: statSync(f).size }))
  .filter((x) => x.size > 20_000)
  .sort((a, b) => b.size - a.size)
  .map((x) => x.f);

const limit = Number(process.argv[2] ?? 80);
const all = files.slice(0, limit).map(analyse).filter((r) => r.edits > 0);

const sum = (k) => all.reduce((a, r) => a + r[k], 0);
const sessionsWith = (k) => all.filter((r) => r[k] > 0).length;
const pct = (n, d) => (d === 0 ? 'n/a' : `${((n / d) * 100).toFixed(1)}%`);

console.log(`\nSummary-yield spike (rule 4) — ${all.length} sessions with edits (of ${Math.min(limit, files.length)} scanned)\n`);
console.log(`  turn-final assistant messages     ${sum('finals')}`);
console.log(`  ...containing a rationale cue     ${sum('finalsWithCue')}  (${pct(sum('finalsWithCue'), sum('finals'))})`);
console.log(`  sessions with >=1 such message    ${sessionsWith('finalsWithCue')} / ${all.length}  (${pct(sessionsWith('finalsWithCue'), all.length)})`);
console.log();
console.log(`  assistant text blocks >=${LONG_TEXT} chars  ${sum('longText')}`);
console.log(`  ...containing a rationale cue     ${sum('longTextCue')}  (${pct(sum('longTextCue'), sum('longText'))})`);
console.log(`  ExitPlanMode calls (rule 2)       ${sum('plans')} across ${sessionsWith('plans')} / ${all.length} sessions`);

console.log('\nSample turn-final text with a cue:');
for (const r of all.filter((x) => x.samples.length).slice(0, 3)) {
  console.log(`  - ${r.samples[0]}`);
}
console.log('\nUpper bound, not a yield: a cue in long prose is weaker evidence than');
console.log('a cue in the sentence before an edit. Hand-label before trusting it.\n');
