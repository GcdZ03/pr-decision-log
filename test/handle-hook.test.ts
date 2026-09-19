import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventStore } from '../src/events/store.ts';
import { handleHook } from '../src/events/handle-hook.ts';

function withStore(fn: (s: EventStore) => void) {
  const root = mkdtempSync(join(tmpdir(), 'pdl-test-'));
  try { fn(new EventStore(root)); } finally { rmSync(root, { recursive: true, force: true }); }
}

const bash = (command: string) => ({
  session_id: 'sess-1',
  hook_event_name: 'PostToolUse',
  tool_name: 'Bash',
  tool_use_id: 'tu-1',
  tool_input: { command },
  tool_response: { stdout: 'ok', stderr: '' },
});

test('handleHook returns the event it recorded, so callers can react to it', () => {
  withStore((store) => {
    const event = handleHook(store, bash('npm test'));

    assert.equal(event?.kind, 'command');
    assert.equal(event?.kind === 'command' ? event.command : '', 'npm test');
  });
});

test('handleHook returns null for a payload it does not record', () => {
  withStore((store) => {
    assert.equal(handleHook(store, { hook_event_name: 'Stop' }), null);
  });
});

test('handleHook returns null when recording is disabled', () => {
  withStore((store) => {
    process.env['PDL_DISABLE'] = '1';
    try {
      assert.equal(handleHook(store, bash('npm test')), null);
    } finally {
      delete process.env['PDL_DISABLE'];
    }
  });
});
