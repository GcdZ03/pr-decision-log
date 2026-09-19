#!/usr/bin/env node
/**
 * Phase 0 spike: measure "decision yield".
 *
 * Question this answers: when an agent edits a file, how often did it first
 * say WHY in visible assistant text? If the answer is "rarely", the premise
 * of pr-decision-log (extract rationale from the session) is wrong, and the
 * tool must instead elicit rationale via a SessionStart instruction.
 *
 * Method: walk each transcript in order. For every Edit/Write/MultiEdit
 * tool_use, look back at the nearest preceding assistant *text* block within
 * a lookback window and test it for rationale markers.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

// Markers that suggest the text explains a choice rather than narrating an action.
const RATIONALE = [
  /\bbecause\b/i, /\binstead of\b/i, /\brather than\b/i, /\bchose\b/i,
  /\bchoosing\b/i, /\btrade-?off\b/i, /\bassum/i, /\bso that\b/i,
  /\bthe reason\b/i, /\bwhy\b/i, /\bavoids?\b/i, /\bprefer(?:red|ring)?\b/i,
  /\bdecided\b/i, /\balternative\b/i,
];

// Narration that looks like explanation but is not a decision.
const NARRATION_ONLY = [/^(now|next|let me|i'?ll|okay|alright)\b/i];

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

const LOOKBACK = 6; // assistant/user entries to search backwards

function analyse(file) {
  const rows = parse(file);
  // Flatten to an ordered stream of {kind, text|tool}
  const stream = [];
  for (const r of rows) {
    if (r.type !== 'assistant') continue;
    const content = r?.message?.content;
    if (!Array.isArray(content)) continue;
    for (const b of content) {
      if (b.type === 'text' && b.text?.trim()) stream.push({ kind: 'text', text: b.text });
      else if (b.type === 'tool_use') stream.push({ kind: 'tool', name: b.name });
      else if (b.type === 'thinking') stream.push({ kind: 'thinking', len: (b.thinking ?? '').length });
    }
  }

  let edits = 0, withText = 0, withRationale = 0;
  const samples = [];

  for (let i = 0; i < stream.length; i++) {
    const cur = stream[i];
    if (cur.kind !== 'tool' || !EDIT_TOOLS.has(cur.name)) continue;
    edits++;
    // find nearest preceding text block
    let found = null;
    for (let j = i - 1; j >= 0 && i - j <= LOOKBACK; j--) {
      if (stream[j].kind === 'text') { found = stream[j].text; break; }
      if (stream[j].kind === 'tool' && EDIT_TOOLS.has(stream[j].name)) break; // previous edit: stop
    }
    if (!found) continue;
    withText++;
    const firstLine = found.trim().split('\n')[0] ?? '';
    const narrationOnly = NARRATION_ONLY.some((re) => re.test(firstLine)) && found.length < 120;
    const hit = RATIONALE.some((re) => re.test(found));
    if (hit && !narrationOnly) {
      withRationale++;
      if (samples.length < 3) samples.push(found.trim().slice(0, 220).replace(/\s+/g, ' '));
    }
  }

  const thinking = stream.filter((s) => s.kind === 'thinking');
  return {
    file,
    edits,
    withText,
    withRationale,
    thinkingTotal: thinking.length,
    thinkingNonEmpty: thinking.filter((t) => t.len > 0).length,
    samples,
  };
}

const root = join(homedir(), '.claude', 'projects');
const files = walk(root)
  .map((f) => ({ f, size: statSync(f).size }))
  .filter((x) => x.size > 20_000)          // skip trivial sessions
  .sort((a, b) => b.size - a.size)
  .map((x) => x.f);

const limit = Number(process.argv[2] ?? 60);
const results = files.slice(0, limit).map(analyse).filter((r) => r.edits > 0);

const sum = (k) => results.reduce((a, r) => a + r[k], 0);
const edits = sum('edits'), withText = sum('withText'), withRationale = sum('withRationale');
const pct = (n, d) => (d === 0 ? '  n/a' : `${((n / d) * 100).toFixed(1)}%`);

console.log(`\nDecision-yield spike — ${results.length} sessions with edits (of ${Math.min(limit, files.length)} scanned)\n`);
console.log(`  edit tool calls                 ${edits}`);
console.log(`  preceded by assistant text      ${withText}  (${pct(withText, edits)})`);
console.log(`  ...containing a rationale cue   ${withRationale}  (${pct(withRationale, edits)} of all edits)`);
console.log(`  thinking blocks non-empty       ${sum('thinkingNonEmpty')} / ${sum('thinkingTotal')}`);

const perSession = results
  .map((r) => ({ n: r.withRationale, e: r.edits }))
  .sort((a, b) => b.n - a.n);
const median = perSession[Math.floor(perSession.length / 2)];
console.log(`  median rationale hits/session   ${median ? median.n : 0}`);
console.log(`  sessions with >=3 hits          ${perSession.filter((p) => p.n >= 3).length} / ${perSession.length}`);

console.log('\nSample extracted rationale text:');
for (const r of results.filter((x) => x.samples.length).slice(0, 4)) {
  for (const s of r.samples.slice(0, 1)) console.log(`  - ${s}`);
}
console.log();
