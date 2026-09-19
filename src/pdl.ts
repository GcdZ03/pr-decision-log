#!/usr/bin/env node
import { EventStore } from './events/store.ts';
import { handleHook } from './events/handle-hook.ts';
import { detectTestEditedAfterFailure } from './flags/test-edited-after-failure.ts';

function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    let buf = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => { buf += c; });
    process.stdin.on('end', () => resolve(buf));
    process.stdin.on('error', () => resolve(''));
  });
}

async function hook(store: EventStore): Promise<void> {
  const raw = await readStdin();
  try {
    handleHook(store, raw.trim() ? JSON.parse(raw) : {});
  } catch {
    // Fail open: a malformed payload must never break the agent loop.
  }
}

function show(store: EventStore, sessionId: string | undefined): void {
  if (!sessionId) {
    process.stderr.write('usage: pdl show <session-id>\n');
    process.exitCode = 2;
    return;
  }
  const events = store.read(sessionId);
  const commands = events.filter((e) => e.kind === 'command');
  const edits = events.filter((e) => e.kind === 'edit');
  const flags = detectTestEditedAfterFailure(events);

  process.stdout.write(`session ${sessionId}\n`);
  process.stdout.write(`  ${events.length} events: ${commands.length} commands, ${edits.length} edits\n`);
  for (const c of commands) {
    if (c.kind !== 'command') continue;
    process.stdout.write(`  [${c.classification}] ${c.outcome.padEnd(11)} ${c.command.split('\n')[0]?.slice(0, 60)}\n`);
  }
  if (flags.length === 0) {
    process.stdout.write('  no flags\n');
    return;
  }
  process.stdout.write(`\n  ${flags.length} flag(s):\n`);
  for (const f of flags) process.stdout.write(`  - ${f.code} ${f.file}\n      ${f.detail}\n`);
}

const store = new EventStore(process.env['PDL_HOME']);
const [command, arg] = process.argv.slice(2);

switch (command) {
  case 'hook':
    await hook(store);
    break;
  case 'show':
    show(store, arg);
    break;
  default:
    process.stderr.write('usage: pdl <hook|show>\n');
    process.exitCode = 2;
}
