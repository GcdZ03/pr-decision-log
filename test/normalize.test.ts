import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { normalize } from '../src/events/normalize.ts';

import type { CommandEvent, EditEvent, TimelineEvent } from '../src/events/types.ts';

const payload = (o: Record<string, unknown>) => o;

/** Narrowing helpers: assert the shape, then read fields without casts. */
function asCommand(e: TimelineEvent | null): CommandEvent {
  assert.ok(e && e.kind === 'command', 'expected a command event');
  return e;
}
function asEdit(e: TimelineEvent | null): EditEvent {
  assert.ok(e && e.kind === 'edit', 'expected an edit event');
  return e;
}

test('a successful Bash PostToolUse becomes a command event with outcome pass', () => {
  const e = normalize(payload({
    hook_event_name: 'PostToolUse',
    session_id: 's1',
    tool_use_id: 'toolu_1',
    tool_name: 'Bash',
    tool_input: { command: 'npm test' },
    tool_response: { stdout: '12 passed', stderr: '', interrupted: false, isImage: false },
    duration_ms: 120,
  }), '2026-09-19T09:00:00Z');

  const c = asCommand(e);
  assert.equal(c.outcome, 'pass');
  assert.equal(c.classification, 'test');
  assert.equal(c.durationMs, 120);
  assert.equal(c.id, 'toolu_1');
});

test('interrupted is its own outcome, never fail', () => {
  const e = normalize(payload({
    hook_event_name: 'PostToolUse',
    session_id: 's1',
    tool_use_id: 'toolu_2',
    tool_name: 'Bash',
    tool_input: { command: 'npm test' },
    tool_response: { stdout: '', stderr: '', interrupted: true, isImage: false },
  }), '2026-09-19T09:01:00Z');

  assert.equal(asCommand(e).outcome, 'interrupted');
});

test('PostToolUseFailure yields outcome fail and parses the exit code', () => {
  const e = normalize(payload({
    hook_event_name: 'PostToolUseFailure',
    session_id: 's1',
    tool_use_id: 'toolu_3',
    tool_name: 'Bash',
    tool_input: { command: 'npm test' },
    error: 'Exit code 1\n2 failed, 10 passed',
    is_interrupt: false,
    duration_ms: 4187,
  }), '2026-09-19T09:02:00Z');

  const c = asCommand(e);
  assert.equal(c.outcome, 'fail');
  assert.equal(c.exitCode, 1);
  assert.equal(c.output, 'Exit code 1\n2 failed, 10 passed');
});

test('an Edit becomes an edit event carrying assertion counts', () => {
  const e = normalize(payload({
    hook_event_name: 'PostToolUse',
    session_id: 's1',
    tool_use_id: 'toolu_4',
    tool_name: 'Edit',
    tool_input: {
      file_path: '/repo/src/a.test.ts',
      old_string: 'expect(a).toBe(1); expect(b).toBe(2);',
      new_string: 'expect(a).toBe(1);',
    },
    tool_response: { filePath: '/repo/src/a.test.ts', type: 'update' },
  }), '2026-09-19T09:03:00Z');

  const ed = asEdit(e);
  assert.equal(ed.path, '/repo/src/a.test.ts');
  assert.equal(ed.assertionsBefore, 2);
  assert.equal(ed.assertionsAfter, 1);
});

test('a whole-file Write reports unknown assertion counts, not zero', () => {
  // A Write has no old_string, so "before" is unknowable. Reporting 0 would
  // make every Write look like an assertion removal.
  const e = normalize(payload({
    hook_event_name: 'PostToolUse',
    session_id: 's1',
    tool_use_id: 'toolu_5',
    tool_name: 'Write',
    tool_input: { file_path: '/repo/src/a.test.ts', content: 'expect(a).toBe(1);' },
    tool_response: { filePath: '/repo/src/a.test.ts', type: 'create' },
  }), '2026-09-19T09:04:00Z');

  const ed = asEdit(e);
  assert.equal(ed.assertionsBefore, undefined);
  assert.equal(ed.assertionsAfter, undefined);
});

test('PreToolUse and unrelated tools are ignored', () => {
  assert.equal(normalize(payload({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'ls' } }), 'now'), null);
  assert.equal(normalize(payload({ hook_event_name: 'PostToolUse', tool_name: 'Read', tool_input: { file_path: '/x' } }), 'now'), null);
});

test('normalizes the real captured payloads from the Phase 0 fixture', () => {
  const lines = readFileSync(new URL('./fixtures/hook-payloads-bash.jsonl', import.meta.url), 'utf8')
    .split('\n').filter(Boolean).map((l) => JSON.parse(l));

  const events = lines
    .map((row) => normalize(row.payload, row.recorded_at))
    .filter((e) => e !== null);

  // The fixture is one echo (success) and one failing ls.
  assert.equal(events.length, 2);
  const ok = asCommand(events[0] ?? null);
  const bad = asCommand(events[1] ?? null);
  assert.equal(ok.outcome, 'pass');
  assert.equal(ok.classification, 'other');
  assert.equal(bad.outcome, 'fail');
  assert.equal(bad.exitCode, 1);
});

// A pipeline's exit status is its last command's, so `npm test | tail` exits 0
// even when the tests fail. Found when a real agent session recorded a failing
// run as a pass, which silently disabled TEST_EDITED_AFTER_FAILURE.

const piped = (command: string, stdout: string) => ({
  session_id: 's', hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_use_id: 't',
  tool_input: { command }, tool_response: { stdout, stderr: '', interrupted: false },
});

test('a piped test run whose output shows a failure is recorded as a failure', () => {
  const e = normalize(piped('npm test 2>&1 | tail -30', 'ℹ pass 1\nℹ fail 1'), '2026-09-26T09:00:00Z');

  assert.equal(e?.kind === 'command' ? e.outcome : undefined, 'fail');
});

test('a piped test run whose output shows a pass stays a pass', () => {
  const e = normalize(piped('npm test 2>&1 | tail -30', 'ℹ pass 2\nℹ fail 0'), '2026-09-26T09:00:00Z');

  assert.equal(e?.kind === 'command' ? e.outcome : undefined, 'pass');
});

test('an unpiped passing run that prints an assertion error keeps trusting its exit code', () => {
  // e.g. a suite that asserts on error messages; the runner exited 0.
  const e = normalize(piped('npm test', 'expected AssertionError to be thrown\nℹ fail 0'), '2026-09-26T09:00:00Z');

  assert.equal(e?.kind === 'command' ? e.outcome : undefined, 'pass');
});

test('a piped non-test command is never reinterpreted from its output', () => {
  const e = normalize(piped('grep AssertionError app.log | head', 'AssertionError: boom'), '2026-09-26T09:00:00Z');

  assert.equal(e?.kind === 'command' ? e.outcome : undefined, 'pass');
});

test('a command records the directory it ran in, read from a leading cd', () => {
  const base = { session_id: 's', tool_use_id: 't', tool_name: 'Bash', cwd: '/home/dev/notch' };
  const moved = asCommand(normalize(payload({
    ...base, hook_event_name: 'PostToolUse',
    tool_input: { command: 'cd ../atlas-wt-02 && just test' }, tool_response: { stdout: '3 passed' },
  }), 'now'));
  const failed = asCommand(normalize(payload({
    ...base, hook_event_name: 'PostToolUseFailure',
    tool_input: { command: 'cd /home/dev/atlas && pytest' }, error: 'Exit code 1',
  }), 'now'));
  const stayed = asCommand(normalize(payload({
    ...base, hook_event_name: 'PostToolUse', tool_input: { command: 'npm test' }, tool_response: { stdout: '' },
  }), 'now'));

  assert.equal(moved.dir, '/home/dev/atlas-wt-02');
  assert.equal(failed.dir, '/home/dev/atlas');
  assert.equal(stayed.dir, '/home/dev/notch');
});

test('an edit records the directory of the file it changed', () => {
  const e = asEdit(normalize(payload({
    hook_event_name: 'PostToolUse', session_id: 's', tool_use_id: 't', tool_name: 'Edit', cwd: '/home/dev/notch',
    tool_input: { file_path: '/home/dev/atlas-wt-03/src/db.py', old_string: 'a', new_string: 'b' },
  }), 'now'));

  assert.equal(e.dir, '/home/dev/atlas-wt-03/src');
});

test('a command from a payload with no cwd records no directory rather than guessing', () => {
  const c = asCommand(normalize(payload({
    hook_event_name: 'PostToolUse', session_id: 's', tool_use_id: 't', tool_name: 'Bash',
    tool_input: { command: 'npm test' }, tool_response: { stdout: '' },
  }), 'now'));

  assert.equal(c.dir, undefined);
});
