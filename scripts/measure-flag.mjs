#!/usr/bin/env node
/**
 * Re-measure TEST_EDITED_AFTER_FAILURE over the real transcript corpus using
 * the windowed detector, and compare against the naive latching heuristic the
 * Phase 0 spike used. The gap is the over-count that spike-notes.md warned about.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { detectTestEditedAfterFailure } from '../src/flags/test-edited-after-failure.ts';

const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const TEST_CMD = /\b(npm|pnpm|yarn|bun)\s+(run\s+)?test|vitest|jest|pytest|go\s+test|swift\s+test|xcodebuild.*test|cargo\s+test|node\s+--test\b/i;
const FAIL_RE = /\b(\d+\s+fail(ed|ing)|FAIL\b|✗|failed with|error:|Error:|Test Suite.*failed)/;
const ASSERT_RE = /\b(expect\(|assert[._(]|XCTAssert|require\.|t\.(Error|Fatal)|Assert\.)/g;

function walk(dir) {
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else if (e.name.endsWith('.jsonl')) out.push(p);
  }
  return out;
}

function countAsserts(s = '') { return (String(s).match(ASSERT_RE) || []).length; }

function toTimeline(file) {
  const rows = [];
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try { rows.push(JSON.parse(line)); } catch {}
  }

  const results = new Map();
  for (const r of rows) {
    const c = r?.message?.content;
    if (!Array.isArray(c)) continue;
    for (const b of c) {
      if (b.type === 'tool_result') {
        const txt = typeof b.content === 'string' ? b.content
          : Array.isArray(b.content) ? b.content.map((x) => x.text ?? '').join('\n') : '';
        results.set(b.tool_use_id, { text: txt, isError: b.is_error === true });
      }
    }
    if (r.toolUseResult && typeof r.toolUseResult === 'object') {
      const last = [...results.keys()].pop();
      if (last && results.get(last)) results.get(last).sidecar = r.toolUseResult;
    }
  }

  const events = [];
  for (const r of rows) {
    if (r.type !== 'assistant') continue;
    const c = r?.message?.content;
    if (!Array.isArray(c)) continue;
    for (const b of c) {
      if (b.type !== 'tool_use') continue;
      const at = r.timestamp ?? '';
      if (b.name === 'Bash') {
        const command = b.input?.command ?? '';
        if (!TEST_CMD.test(command)) continue;
        const res = results.get(b.id);
        const sc = res?.sidecar;
        let outcome = 'unknown';
        if (sc?.interrupted === true) outcome = 'interrupted';
        else if (res?.isError || FAIL_RE.test(res?.text ?? '')) outcome = 'fail';
        else if (res) outcome = 'pass';
        events.push({ kind: 'command', id: b.id, at, command, classification: 'test', outcome, output: res?.text ?? '' });
      } else if (EDIT_TOOLS.has(b.name)) {
        const path = b.input?.file_path ?? b.input?.notebook_path ?? '';
        const before = countAsserts(b.input?.old_string);
        const after = countAsserts(b.input?.new_string ?? b.input?.content);
        const known = b.input?.old_string !== undefined || b.input?.content !== undefined;
        events.push({
          kind: 'edit', id: b.id, at, path,
          ...(known ? { assertionsBefore: before, assertionsAfter: after } : {}),
        });
      }
    }
  }
  return events;
}

// The naive heuristic the spike used: latches on first failure, counts every edit.
function naive(events) {
  let saw = false, n = 0;
  const isTest = (p = '') => /(^|\/)(tests?|spec|__tests__)\//i.test(p) || /\.(test|spec)\.[tj]sx?$|_test\.(go|py)$|Tests?\.swift$|test_.*\.py$/i.test(p);
  for (const e of events) {
    if (e.kind === 'command' && e.outcome === 'fail') saw = true;
    else if (e.kind === 'edit' && isTest(e.path) && saw) n++;
  }
  return n;
}

const root = join(homedir(), '.claude', 'projects');
const files = walk(root).map((f) => ({ f, size: statSync(f).size }))
  .filter((x) => x.size > 20_000).sort((a, b) => b.size - a.size).map((x) => x.f);

let naiveTotal = 0, realTotal = 0, naiveSessions = 0, realSessions = 0, scanned = 0;
const examples = [];

for (const f of files.slice(0, Number(process.argv[2] ?? 80))) {
  const ev = toTimeline(f);
  if (!ev.some((e) => e.kind === 'edit')) continue;
  scanned++;
  const n = naive(ev);
  const flags = detectTestEditedAfterFailure(ev);
  naiveTotal += n; realTotal += flags.length;
  if (n > 0) naiveSessions++;
  if (flags.length > 0) { realSessions++; if (examples.length < 3) examples.push(flags[0]); }
}

const pct = (a, b) => (b === 0 ? 'n/a' : `${((a / b) * 100).toFixed(0)}%`);
console.log(`\nTEST_EDITED_AFTER_FAILURE — naive vs windowed, ${scanned} sessions\n`);
console.log(`                      naive    windowed   retained`);
console.log(`  occurrences        ${String(naiveTotal).padStart(5)}    ${String(realTotal).padStart(8)}   ${pct(realTotal, naiveTotal)}`);
console.log(`  sessions flagged   ${String(naiveSessions).padStart(5)}    ${String(realSessions).padStart(8)}   ${pct(realSessions, naiveSessions)}`);
console.log(`\nSample surviving flags:`);
for (const f of examples) console.log(`  - ${f.file}\n      ${f.detail}`);
console.log();
