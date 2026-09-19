import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventStore } from '../src/events/store.ts';
import { handleHook } from '../src/events/handle-hook.ts';

const payload = {
  session_id: 'sess-1',
  hook_event_name: 'PostToolUse',
  tool_name: 'Bash',
  tool_use_id: 'tu-1',
  tool_input: { command: 'npm test' },
  tool_response: { stdout: '2 passing', stderr: '' },
};

function withStore(fn: (s: EventStore) => void) {
  const root = mkdtempSync(join(tmpdir(), 'pdl-test-'));
  try { fn(new EventStore(root)); } finally { rmSync(root, { recursive: true, force: true }); }
}

function withEnv(value: string | undefined, fn: () => void) {
  const had = Object.hasOwn(process.env, 'PDL_DISABLE');
  const previous = process.env['PDL_DISABLE'];
  if (value === undefined) delete process.env['PDL_DISABLE'];
  else process.env['PDL_DISABLE'] = value;
  try {
    fn();
  } finally {
    if (had) process.env['PDL_DISABLE'] = previous as string;
    else delete process.env['PDL_DISABLE'];
  }
}

test('PDL_DISABLE=1 records nothing', () => {
  withStore((store) => {
    withEnv('1', () => handleHook(store, payload));

    assert.deepEqual(store.read('sess-1'), []);
  });
});

test('an unset PDL_DISABLE records normally', () => {
  withStore((store) => {
    withEnv(undefined, () => handleHook(store, payload));

    assert.equal(store.read('sess-1').length, 1);
  });
});

test('PDL_DISABLE=0 does not disable, because it reads as off', () => {
  withStore((store) => {
    withEnv('0', () => handleHook(store, payload));

    assert.equal(store.read('sess-1').length, 1);
  });
});

test('PDL_DISABLE=false does not disable', () => {
  withStore((store) => {
    withEnv('false', () => handleHook(store, payload));

    assert.equal(store.read('sess-1').length, 1);
  });
});

test('an empty PDL_DISABLE does not disable, because exporting it blank is not a request', () => {
  withStore((store) => {
    withEnv('', () => handleHook(store, payload));

    assert.equal(store.read('sess-1').length, 1);
  });
});
