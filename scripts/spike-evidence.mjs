#!/usr/bin/env node
/**
 * Phase 0 spike, part 2: measure "evidence yield".
 *
 * The rationale extraction scored 3%. This asks whether the DETERMINISTIC
 * timeline is rich enough to be worth publishing on its own: commands run,
 * test runs and their outcome, and the key signal for reviewers —
 * a test file edited AFTER a failing test run in the same session.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const TEST_CMD = /\b(npm|pnpm|yarn|bun)\s+(run\s+)?test|vitest|jest|pytest|go\s+test|swift\s+test|xcodebuild.*test|cargo\s+test|node\s+--test\b/i;
const BUILD_CMD = /\b(npm|pnpm|yarn|bun)\s+(run\s+)?build|tsc\b|cargo\s+build|go\s+build|xcodebuild(?!.*test)|swift\s+build/i;
const LINT_CMD = /\b(eslint|prettier|ruff|black|clippy|swiftlint|golangci-lint)\b|\blint\b/i;
const FAIL_RE = /\b(\d+\s+fail(ed|ing)|FAIL\b|✗|failed with|error:|Error:|exit code [1-9]|Test Suite.*failed|assertion.*fail)/;
const TEST_PATH = /(^|\/)(tests?|spec|__tests__)\//i;
const TEST_FILE = /\.(test|spec)\.[tj]sx?$|_test\.(go|py)$|Tests?\.swift$|test_.*\.py$/i;

function walk(dir) {
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else if (e.name.endsWith('.jsonl')) out.push(p);
  }
  return out;
}

function isTestFile(p = '') { return TEST_PATH.test(p) || TEST_FILE.test(p); }

function analyse(file) {
  const rows = [];
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try { rows.push(JSON.parse(line)); } catch { /* ignore */ }
  }

  // Map tool_use_id -> result text, from user messages carrying tool_result
  const results = new Map();
  for (const r of rows) {
    const content = r?.message?.content;
    if (!Array.isArray(content)) continue;
    for (const b of content) {
      if (b.type === 'tool_result') {
        const txt = typeof b.content === 'string'
          ? b.content
          : Array.isArray(b.content) ? b.content.map((c) => c.text ?? '').join('\n') : '';
        results.set(b.tool_use_id, { text: txt.slice(0, 4000), isError: b.is_error === true });
      }
    }
  }

  const events = [];
  for (const r of rows) {
    if (r.type !== 'assistant') continue;
    const content = r?.message?.content;
    if (!Array.isArray(content)) continue;
    for (const b of content) {
      if (b.type !== 'tool_use') continue;
      if (b.name === 'Bash') {
        const cmd = b.input?.command ?? '';
        const res = results.get(b.id);
        const kind = TEST_CMD.test(cmd) ? 'test' : BUILD_CMD.test(cmd) ? 'build' : LINT_CMD.test(cmd) ? 'lint' : 'other';
        const failed = res ? (res.isError || FAIL_RE.test(res.text)) : null;
        events.push({ kind, cmd, failed });
      } else if (EDIT_TOOLS.has(b.name)) {
        const p = b.input?.file_path ?? b.input?.notebook_path ?? '';
        events.push({ kind: 'edit', path: p, test: isTestFile(p) });
      }
    }
  }

  const testRuns = events.filter((e) => e.kind === 'test');
  const failedTests = testRuns.filter((e) => e.failed === true);
  const edits = events.filter((e) => e.kind === 'edit');

  // Key reviewer signal: test file edited after a failing test run.
  let testEditedAfterFailure = 0;
  let sawFailingTest = false;
  for (const e of events) {
    if (e.kind === 'test' && e.failed === true) sawFailingTest = true;
    else if (e.kind === 'edit' && e.test && sawFailingTest) testEditedAfterFailure++;
  }

  return {
    commands: events.filter((e) => ['test', 'build', 'lint', 'other'].includes(e.kind)).length,
    testRuns: testRuns.length,
    failedTests: failedTests.length,
    builds: events.filter((e) => e.kind === 'build').length,
    edits: edits.length,
    testEdits: edits.filter((e) => e.test).length,
    testEditedAfterFailure,
    filesTouched: new Set(edits.map((e) => e.path)).size,
  };
}

const root = join(homedir(), '.claude', 'projects');
const files = walk(root).map((f) => ({ f, size: statSync(f).size }))
  .filter((x) => x.size > 20_000).sort((a, b) => b.size - a.size).map((x) => x.f);

const limit = Number(process.argv[2] ?? 80);
const all = files.slice(0, limit).map(analyse).filter((r) => r.edits > 0);
const sum = (k) => all.reduce((a, r) => a + r[k], 0);
const withSignal = (k) => all.filter((r) => r[k] > 0).length;

console.log(`\nEvidence-yield spike — ${all.length} sessions with edits\n`);
const rows = [
  ['commands run', sum('commands'), withSignal('commands')],
  ['test runs', sum('testRuns'), withSignal('testRuns')],
  ['failing test runs', sum('failedTests'), withSignal('failedTests')],
  ['build runs', sum('builds'), withSignal('builds')],
  ['file edits', sum('edits'), withSignal('edits')],
  ['test-file edits', sum('testEdits'), withSignal('testEdits')],
  ['TEST_EDITED_AFTER_FAILURE', sum('testEditedAfterFailure'), withSignal('testEditedAfterFailure')],
];
console.log('  signal                        total   sessions having it');
for (const [name, total, sess] of rows) {
  console.log(`  ${name.padEnd(28)} ${String(total).padStart(5)}   ${sess}/${all.length}`);
}
const noTest = all.filter((r) => r.testRuns === 0).length;
console.log(`\n  sessions that edited code but never ran a test: ${noTest}/${all.length}`);
console.log();
