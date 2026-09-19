import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventStore } from '../src/events/store.ts';
import { handleHook } from '../src/events/handle-hook.ts';
import { detectTestEditedAfterFailure } from '../src/flags/test-edited-after-failure.ts';

function withStore(fn: (s: EventStore) => void) {
  const root = mkdtempSync(join(tmpdir(), 'pdl-pipe-'));
  try { fn(new EventStore(root)); } finally { rmSync(root, { recursive: true, force: true }); }
}

test('hook payloads flow through the store into a flag', () => {
  withStore((store) => {
    const session = 'sess-x';

    handleHook(store, {
      hook_event_name: 'PostToolUseFailure', session_id: session, tool_use_id: 't1',
      tool_name: 'Bash', tool_input: { command: 'npm test -- sync' },
      error: 'Exit code 1\nFAIL src/sync.test.ts\n  expected 2 got 3',
    }, '09:30');

    handleHook(store, {
      hook_event_name: 'PostToolUse', session_id: session, tool_use_id: 't2',
      tool_name: 'Edit', tool_input: {
        file_path: 'src/sync.test.ts',
        old_string: 'expect(a).toBe(2); expect(b).toBe(3);',
        new_string: 'expect(a).toBe(3);',
      },
      tool_response: { filePath: 'src/sync.test.ts', type: 'update' },
    }, '09:35');

    const flags = detectTestEditedAfterFailure(store.read(session));

    assert.equal(flags.length, 1);
    assert.equal(flags[0]?.file, 'src/sync.test.ts');
    assert.match(flags[0]?.detail ?? '', /2 -> 1/);
  });
});

test('a clean session produces no flags', () => {
  withStore((store) => {
    handleHook(store, {
      hook_event_name: 'PostToolUse', session_id: 's', tool_use_id: 't1',
      tool_name: 'Bash', tool_input: { command: 'npm test' },
      tool_response: { stdout: '12 passed', stderr: '', interrupted: false },
    }, '09:30');

    assert.deepEqual(detectTestEditedAfterFailure(store.read('s')), []);
  });
});

test('handleHook ignores payloads it does not record and never throws', () => {
  withStore((store) => {
    assert.doesNotThrow(() => handleHook(store, { hook_event_name: 'PreToolUse' }, 'now'));
    assert.doesNotThrow(() => handleHook(store, {}, 'now'));
    assert.deepEqual(store.read('unknown'), []);
  });
});
