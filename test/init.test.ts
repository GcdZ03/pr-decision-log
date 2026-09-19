import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeHooks, pdlHookEvents, PDL_MARKER } from '../src/doctor/init.ts';
import { REQUIRED_HOOK_EVENTS } from '../src/doctor/diagnose.ts';

const CMD = 'node "$CLAUDE_PROJECT_DIR/dist/pdl.js" hook';

test('an empty settings file gains every required hook event', () => {
  const merged = mergeHooks({}, CMD);

  assert.deepEqual(pdlHookEvents(merged).sort(), [...REQUIRED_HOOK_EVENTS].sort());
});

test('pdl hook entries carry a marker so they can be found again', () => {
  const merged = mergeHooks({}, CMD);

  const entry = merged.hooks?.['Stop']?.[0]?.hooks?.[0];
  assert.equal(entry?.[PDL_MARKER], true);
});

test('Stop is synchronous, because it is the checkpoint that builds the log', () => {
  const merged = mergeHooks({}, CMD);

  assert.notEqual(merged.hooks?.['Stop']?.[0]?.hooks?.[0]?.async, true);
});

test('tool events are async, so recording never sits in the agent loop', () => {
  const merged = mergeHooks({}, CMD);

  assert.equal(merged.hooks?.['PostToolUse']?.[0]?.hooks?.[0]?.async, true);
});

test('running init twice adds no second copy', () => {
  const once = mergeHooks({}, CMD);
  const twice = mergeHooks(once, CMD);

  assert.deepEqual(twice, once);
});

test("another tool's hooks on the same event are preserved", () => {
  const existing = {
    hooks: {
      PostToolUse: [
        { matcher: '*', hooks: [{ type: 'command', command: 'prettier --write' }] },
      ],
    },
  };

  const merged = mergeHooks(existing, CMD);

  const commands = merged.hooks?.['PostToolUse']?.flatMap((g) => g.hooks ?? []).map((h) => h.command);
  assert.ok(commands?.includes('prettier --write'), 'existing hook was dropped');
  assert.ok(commands?.includes(CMD), 'pdl hook was not added');
});

test('unrelated settings keys survive untouched', () => {
  const merged = mergeHooks({ model: 'opus', permissions: { allow: ['Bash(ls:*)'] } }, CMD);

  assert.equal(merged['model'], 'opus');
  assert.deepEqual(merged['permissions'], { allow: ['Bash(ls:*)'] });
});

test('a pdl entry whose command moved is rewritten rather than duplicated', () => {
  const stale = mergeHooks({}, 'node /old/path/pdl.js hook');

  const merged = mergeHooks(stale, CMD);

  const pdlEntries = (merged.hooks?.['PostToolUse'] ?? [])
    .flatMap((g) => g.hooks ?? [])
    .filter((h) => h[PDL_MARKER] === true);
  assert.equal(pdlEntries.length, 1);
  assert.equal(pdlEntries[0]?.command, CMD);
});

test('a hand-written pdl hook is adopted rather than duplicated', () => {
  const handWritten = {
    hooks: {
      PostToolUse: [
        {
          matcher: '*',
          hooks: [{ type: 'command', command: 'node "$CLAUDE_PROJECT_DIR/src/pdl.ts" hook', async: true }],
        },
      ],
    },
  };

  const merged = mergeHooks(handWritten, CMD);

  const commands = (merged.hooks?.['PostToolUse'] ?? []).flatMap((g) => g.hooks ?? []);
  assert.equal(commands.length, 1, 'the hand-written hook was left alongside the managed one');
  assert.equal(commands[0]?.command, CMD);
});

test('a hand-written pdl hook invoked through the global bin is also adopted', () => {
  const handWritten = {
    hooks: { Stop: [{ hooks: [{ type: 'command', command: 'pdl hook' }] }] },
  };

  const merged = mergeHooks(handWritten, CMD);

  assert.equal((merged.hooks?.['Stop'] ?? []).flatMap((g) => g.hooks ?? []).length, 1);
});

test("a foreign hook that merely mentions pdl in a path is not adopted", () => {
  const foreign = {
    hooks: {
      PostToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: 'node /src/pdl-lint/run.js check' }] }],
    },
  };

  const merged = mergeHooks(foreign, CMD);

  const commands = (merged.hooks?.['PostToolUse'] ?? []).flatMap((g) => g.hooks ?? []).map((h) => h.command);
  assert.ok(commands.includes('node /src/pdl-lint/run.js check'), 'a foreign hook was removed');
  assert.equal(commands.length, 2);
});
