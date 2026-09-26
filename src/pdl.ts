#!/usr/bin/env node
import { EventStore } from './events/store.ts';
import { handleHook } from './events/handle-hook.ts';
import { detectTestEditedAfterFailure } from './flags/test-edited-after-failure.ts';
import { buildLog } from './render/build-log.ts';
import { render } from './render/render.ts';
import { publish } from './publish/publish.ts';
import { autoPublish, FilePublishState } from './publish/auto-publish.ts';
import { defaultBase, diffAgainst } from './publish/pr-diff.ts';
import { eventsForBranch, selectForBranch } from './events/branch.ts';
import { isDisabled } from './events/handle-hook.ts';
import { detectPrCreation } from './publish/detect-pr.ts';
import { diagnose, worstStatus, type Facts } from './doctor/diagnose.ts';
import { readTranscript } from './extract/transcript.ts';
import { extractDecisions, type Decision } from './extract/decisions.ts';
import { findTranscript } from './extract/find-transcript.ts';
import { mergeHooks, pdlHookEvents } from './doctor/init.ts';
import {
  ghStatus, hookCommand, readSettings, repoRoot, settingsExist, settingsPathFor, trustState, writeSettings,
  type Scope,
} from './doctor/settings.ts';
import { loadConfig } from './config/config.ts';
import { compileExtraPatterns, redact } from './render/redact.ts';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

function git(args: string[]): string {
  const p = spawnSync('git', args, { encoding: 'utf8' });
  return p.status === 0 ? (p.stdout ?? '').trim() : '';
}

function currentBranch(): string {
  const b = git(['rev-parse', '--abbrev-ref', 'HEAD']);
  return b === 'HEAD' ? '' : b;
}

function logMeta(branch: string, base: string) {
  return {
    repo: git(['remote', 'get-url', 'origin']) || 'unknown',
    branch: branch || 'detached',
    headSha: git(['rev-parse', '--short', 'HEAD']),
    repoRoot: repoRoot(),
    diff: diffAgainst(base),
    flagEditAfterFailure: config.tests.flag_edit_after_failure,
    extraRedactions: compileExtraPatterns(config.redaction.extra_patterns),
  };
}

function decisionsIn(transcript: string | undefined): Decision[] {
  return transcript ? extractDecisions(readTranscript(transcript), { extraMarkers: config.extract.decision_markers }) : [];
}

/** One session's log, for `pdl build <session>` and `pdl publish`. */
function renderSession(store: EventStore, sessionId: string): string {
  const log = buildLog(store.read(sessionId), logMeta(currentBranch(), defaultBase()), decisionsIn(findTranscript(sessionId)));
  return render(log, { maxChars: config.publish.max_chars });
}

/**
 * The branch's log: every session that worked on it, merged in time order, so
 * one PR carries one log however many sessions it took.
 */
function renderBranch(store: EventStore, root: string, branch: string, base: string): string {
  const merged = eventsForBranch(store, root, branch);

  const seen = new Set<string>();
  const decisions = merged.sessions.flatMap((session) =>
    selectForBranch(
      decisionsIn(merged.transcripts.get(session) ?? findTranscript(session)),
      merged.turnsBySession.get(session) ?? [],
      branch,
    ),
  ).filter((d) => {
    const key = `${d.kind}|${d.text}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  const log = buildLog(merged.events, { ...logMeta(branch, base), sessions: merged.sessions }, decisions);
  return render(log, { maxChars: config.publish.max_chars });
}

function build(store: EventStore, sessionId: string | undefined): void {
  if (sessionId) {
    process.stdout.write(renderSession(store, sessionId));
    return;
  }
  const branch = currentBranch();
  if (!branch) {
    process.stderr.write('pdl build: detached HEAD; pass a session id instead\n');
    process.exitCode = 2;
    return;
  }
  process.stdout.write(renderBranch(store, repoRoot(), branch, defaultBase()));
}

async function publishCmd(store: EventStore, sessionId: string | undefined, prNumber: string | undefined, dryRun: boolean): Promise<void> {
  if (!sessionId || !prNumber) {
    process.stderr.write('usage: pdl publish <session-id> <pr-number> [--dry-run]\n');
    process.exitCode = 2;
    return;
  }
  const result = await publish({
    prNumber: Number(prNumber),
    section: renderSession(store, sessionId),
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
    // Checked before any work: disabled means no recording, no git, no network.
    if (isDisabled()) return;

    const payload = raw.trim() ? (JSON.parse(raw) as Record<string, unknown>) : {};
    const event = handleHook(store, payload);
    const sessionId = typeof payload['session_id'] === 'string' ? payload['session_id'] : '';

    // Two triggers. `gh pr create` is when the pull request first exists, and
    // `Stop` catches everything that happened after it was opened.
    const created = config.publish.on_pr_create && event ? detectPrCreation(event) !== null : false;
    const stopped = payload['hook_event_name'] === 'Stop';
    if (!sessionId || !(created || stopped)) return;

    const branch = currentBranch();
    if (!branch) return; // Detached HEAD: there is no PR to publish to.
    const root = repoRoot();

    // Marks every event since the last turn as belonging to this branch; see
    // events/branch.ts for why this is recorded here and not per event.
    const transcript = typeof payload['transcript_path'] === 'string' ? payload['transcript_path'] : undefined;
    store.appendTurn({ session: sessionId, repo: root, branch, at: new Date().toISOString(), ...(transcript ? { transcript } : {}) });

    // Retention runs from the Stop hook because there is no other process;
    // pruneIfDue keeps it to one directory scan a day.
    if (stopped) store.pruneIfDue(config.store.retention_days, Date.now());

    await autoPublish({
      key: `${root}#${branch}`,
      created,
      mode: config.publish.mode,
      defaultBase: defaultBase(),
      state: publishState,
      build: (base) => renderBranch(store, root, branch, base),
    });
  } catch {
    // Fail open: a malformed payload must never break the agent loop.
  }
}

function init(scope: Scope): void {
  const path = settingsPathFor(scope, repoRoot());
  const existed = settingsExist(path);
  const root = repoRoot();
  const merged = mergeHooks(readSettings(path), hookCommand(process.argv[1], scope, root));
  writeSettings(path, merged);

  process.stdout.write(`${existed ? 'updated' : 'created'} ${path}\n`);
  process.stdout.write(`  registered ${pdlHookEvents(merged).length} hook events\n`);

  const other = scope === 'user' ? 'project' : 'user';
  if (pdlHookEvents(readSettings(settingsPathFor(other, root))).length > 0) {
    process.stdout.write(
      `  warning: pdl is also registered in ${other} settings (${settingsPathFor(other, root)}); every hook will fire twice. Remove one of them.\n`,
    );
  }
  if (scope === 'project') {
    process.stdout.write('  hooks stay dormant until you accept the trust dialog for this folder\n');
  }
}

const ICON: Record<string, string> = { ok: 'ok  ', warn: 'warn', fail: 'FAIL', skip: 'skip' };

function doctor(store: EventStore): void {
  const root = repoRoot();
  const projectPath = settingsPathFor('project', root);
  const userPath = settingsPathFor('user', root);
  const project = readSettings(projectPath);
  const user = readSettings(userPath);
  const events = [...new Set([...pdlHookEvents(project), ...pdlHookEvents(user)])];

  const facts: Facts = {
    nodeVersion: process.version,
    hookEvents: events,
    settingsPath: pdlHookEvents(project).length > 0 ? projectPath : pdlHookEvents(user).length > 0 ? userPath : undefined,
    recordedSessions: store.sessionCount(),
    gh: ghStatus(),
    env: process.env,
    configProblems: config.problems,
    trust: trustState(root),
    hookScopes: [
      ...(pdlHookEvents(project).length > 0 ? ['project' as const] : []),
      ...(pdlHookEvents(user).length > 0 ? ['user' as const] : []),
    ],
  };

  const checks = diagnose(facts);
  for (const c of checks) {
    process.stdout.write(`  [${ICON[c.status]}] ${c.name}: ${c.detail}\n`);
    if (c.remedy && c.status !== 'ok') process.stdout.write(`         -> ${c.remedy}\n`);
  }

  const worst = worstStatus(checks);
  process.stdout.write(`\n${worst === 'ok' ? 'all good' : `worst: ${worst}`}\n`);
  if (worst === 'fail') process.exitCode = 1;
}

/**
 * Run text through the redactor and report what it caught.
 *
 * The point is to make redaction inspectable before trusting it: paste a real
 * log line in and see whether the pattern set actually fires. A silent miss is
 * the failure mode that matters, and it is invisible without this.
 */
async function redactCheck(file: string | undefined): Promise<void> {
  const input = file ? readFileSync(file, 'utf8') : await readStdin();
  const { text, hits } = redact(input);

  process.stdout.write(text.endsWith('\n') ? text : `${text}\n`);
  process.stderr.write(
    hits.length === 0
      ? '\nno redaction rules matched\n'
      : `\n${hits.length} rule(s) matched: ${[...new Set(hits)].join(', ')}\n`,
  );
  if (hits.length > 0) process.exitCode = 1;
}

function purge(store: EventStore): void {
  const n = store.purge();
  process.stdout.write(`removed ${n} recorded session(s)\n`);
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

const config = loadConfig(repoRoot());
// PDL_HOME beats the config file: it is how a test or a one-off run isolates
// the store without editing anyone's settings.
const storeRoot = process.env['PDL_HOME'] ?? config.store.dir;
const store = new EventStore(storeRoot);
const publishState = new FilePublishState(join(storeRoot, 'publish-state.json'));
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
  case 'init':
    init(process.argv.includes('--user') ? 'user' : 'project');
    break;
  case 'doctor':
    doctor(store);
    break;
  case 'purge':
    purge(store);
    break;
  case 'redact-check':
    await redactCheck(arg);
    break;
  default:
    process.stderr.write('usage: pdl <hook|show|build|publish|init|doctor|purge|redact-check>\n');
    process.exitCode = 2;
}
