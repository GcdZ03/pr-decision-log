#!/usr/bin/env node
import { EventStore } from './events/store.ts';
import { handleHook } from './events/handle-hook.ts';
import { detectTestEditedAfterFailure } from './flags/test-edited-after-failure.ts';
import { buildLog } from './render/build-log.ts';
import { render } from './render/render.ts';
import { publish } from './publish/publish.ts';
import { spawnSync } from 'node:child_process';

function git(args: string[]): string {
  const p = spawnSync('git', args, { encoding: 'utf8' });
  return p.status === 0 ? (p.stdout ?? '').trim() : '';
}

function logFor(store: EventStore, sessionId: string) {
  const branch = git(['rev-parse', '--abbrev-ref', 'HEAD']);
  return buildLog(store.read(sessionId), {
    repo: git(['remote', 'get-url', 'origin']) || 'unknown',
    branch: branch === 'HEAD' ? 'detached' : branch,
    headSha: git(['rev-parse', '--short', 'HEAD']),
    repoRoot: git(['rev-parse', '--show-toplevel']) || process.cwd(),
  });
}

function build(store: EventStore, sessionId: string | undefined): void {
  if (!sessionId) {
    process.stderr.write('usage: pdl build <session-id>\n');
    process.exitCode = 2;
    return;
  }
  process.stdout.write(render(logFor(store, sessionId)));
}

async function publishCmd(store: EventStore, sessionId: string | undefined, prNumber: string | undefined, dryRun: boolean): Promise<void> {
  if (!sessionId || !prNumber) {
    process.stderr.write('usage: pdl publish <session-id> <pr-number> [--dry-run]\n');
    process.exitCode = 2;
    return;
  }
  const result = await publish({
    prNumber: Number(prNumber),
    section: render(logFor(store, sessionId)),
    dryRun,
  });
  process.stdout.write(`${result.status}${result.error ? `: ${result.error}` : ''}\n`);
  // Publishing is a side effect of someone's real work; never fail their command.
}

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
  case 'build':
    build(store, arg);
    break;
  case 'publish':
    await publishCmd(store, arg, process.argv[4], process.argv.includes('--dry-run'));
    break;
  default:
    process.stderr.write('usage: pdl <hook|show|build|publish>\n');
    process.exitCode = 2;
}
