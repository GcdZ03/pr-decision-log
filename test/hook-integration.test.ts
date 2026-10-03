import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PDL = join(HERE, '..', 'src', 'pdl.ts');

/**
 * One payload for each of the nine hook events, recorded from real Claude Code
 * sessions with only paths rewritten. The failed Bash call comes from the
 * Phase 0 capture, since a headless run did not reproduce one; its session id
 * was changed to match the rest.
 */
const PAYLOADS = readFileSync(join(HERE, 'fixtures', 'hook-payloads-nine.jsonl'), 'utf8')
  .trim().split('\n').map((l) => (JSON.parse(l) as { payload: Record<string, unknown> }).payload);
const SESSION = 'e7566cae-fbd3-4bfb-8f54-6a19b877ab8c';

type Run = { out: string; err: string; code: number };

/**
 * Feeds every payload to `pdl hook` as its own process, the way Claude Code
 * runs it, in a throwaway repo on branch `feat`. `gh` is a stub that records
 * its arguments and reports no pull request, so nothing reaches the network.
 */
function replay(env: Record<string, string> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'pdl-hook-int-'));
  const repo = join(dir, 'repo');
  const store = join(dir, 'store');
  const bin = join(dir, 'bin');
  const ghLog = join(dir, 'gh-calls.txt');
  mkdirSync(repo);
  mkdirSync(bin);
  execFileSync('git', ['init', '-q', '-b', 'feat'], { cwd: repo });
  writeFileSync(join(bin, 'gh'), `#!/bin/sh\necho "$*" >> "${ghLog}"\necho "no pull requests found for branch \\"feat\\"" >&2\nexit 1\n`);
  chmodSync(join(bin, 'gh'), 0o755);

  const runs: Run[] = PAYLOADS.map((payload) => {
    const p = spawnSync('node', [PDL, 'hook'], {
      cwd: repo,
      input: JSON.stringify(payload),
      encoding: 'utf8',
      env: { ...process.env, PDL_DISABLE: '', ...env, PDL_HOME: store, PATH: `${bin}:${process.env['PATH'] ?? ''}` },
    });
    return { out: p.stdout, err: p.stderr, code: p.status ?? -1 };
  });

  const lines = (f: string) => (existsSync(f) ? readFileSync(f, 'utf8').trim().split('\n').filter(Boolean) : []);
  const result = {
    runs,
    root: execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: repo, encoding: 'utf8' }).trim(),
    events: lines(join(store, 'events', `${SESSION}.jsonl`)).map((l) => JSON.parse(l) as Record<string, unknown>),
    turns: lines(join(store, 'turns.jsonl')).map((l) => JSON.parse(l) as Record<string, unknown>),
    ghCalls: lines(ghLog),
  };
  rmSync(dir, { recursive: true, force: true });
  return result;
}

test('the fixture holds one real payload for each of the nine hook events', () => {
  assert.deepEqual(PAYLOADS.map((p) => p['hook_event_name']).sort(), [
    'PostToolUse', 'PostToolUseFailure', 'PreCompact', 'PreToolUse', 'SessionEnd',
    'SessionStart', 'Stop', 'SubagentStop', 'UserPromptSubmit',
  ]);
  assert.ok(PAYLOADS.every((p) => p['session_id'] === SESSION));
});

test('pdl hook replays all nine payloads into the store', () => {
  const r = replay();

  // A hook that prints or fails shows up in the agent's loop. None may.
  for (const [i, run] of r.runs.entries()) {
    assert.equal(run.code, 0, `${String(PAYLOADS[i]?.['hook_event_name'])} exited ${run.code}: ${run.err}`);
    assert.equal(run.out, '', `${String(PAYLOADS[i]?.['hook_event_name'])} printed to stdout`);
  }

  // Only settled tool calls become events: the failed command and the edit.
  // PreToolUse has no outcome yet, and the other six carry no tool call.
  assert.equal(r.events.length, 2, JSON.stringify(r.events));
  const [command, edit] = r.events;
  assert.equal(command?.['kind'], 'command');
  assert.equal(command?.['command'], 'ls /nonexistent-xyz');
  assert.equal(command?.['outcome'], 'fail');
  assert.equal(command?.['exitCode'], 1);
  assert.equal(edit?.['kind'], 'edit');
  assert.equal(edit?.['path'], '/home/dev/demo/add.js');

  // Stop is the only event that ends a turn, so it alone records the branch.
  assert.equal(r.turns.length, 1, JSON.stringify(r.turns));
  assert.equal(r.turns[0]?.['session'], SESSION);
  assert.equal(r.turns[0]?.['branch'], 'feat');
  assert.equal(r.turns[0]?.['repo'], r.root);
  assert.equal(r.turns[0]?.['transcript'], PAYLOADS.find((p) => p['hook_event_name'] === 'Stop')?.['transcript_path']);

  // ...and it alone asks GitHub for the branch's pull request, once.
  assert.equal(r.ghCalls.length, 1, r.ghCalls.join('\n'));
  assert.match(r.ghCalls[0] ?? '', /^pr view/);
});

test('with PDL_DISABLE set, the nine payloads record nothing and call nothing', () => {
  const r = replay({ PDL_DISABLE: '1' });

  assert.ok(r.runs.every((run) => run.code === 0 && run.out === ''));
  assert.deepEqual(r.events, []);
  assert.deepEqual(r.turns, []);
  assert.deepEqual(r.ghCalls, []);
});

// The case that motivated per-event directories: a session started in one
// repository opened a pull request in a worktree of another, every command
// prefixed with `cd`. All six such PRs went without a log, because pdl looked
// for a PR on the starting folder's branch.
test('a PR opened from a worktree of another repository gets its log there', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pdl-elsewhere-'));
  try {
    const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
    const commit = (cwd: string) => git(cwd, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init');

    const notch = join(dir, 'notch');
    const atlas = join(dir, 'atlas');
    const wt = join(dir, 'atlas-wt-01');
    for (const r of [notch, atlas]) { mkdirSync(r); git(r, 'init', '-q', '-b', 'main'); commit(r); }
    git(atlas, 'worktree', 'add', '-q', '-b', 'm0/01', wt);
    mkdirSync(join(wt, 'src'));
    const wtRoot = git(wt, 'rev-parse', '--show-toplevel');

    // gh answers `pr view` with a PR only on the worktree's branch, and keeps
    // what `pr edit` was given.
    const bin = join(dir, 'bin');
    const calls = join(dir, 'gh-calls.txt');
    const body = join(dir, 'pr-body.md');
    mkdirSync(bin);
    writeFileSync(join(bin, 'gh'), [
      '#!/bin/sh',
      `echo "$(git rev-parse --show-toplevel 2>/dev/null)|$(git symbolic-ref --short -q HEAD 2>/dev/null)|$*" >> "${calls}"`,
      'case "$1 $2" in',
      `  "pr view") [ "$(git symbolic-ref --short -q HEAD)" = "m0/01" ] || { echo "no pull requests found" >&2; exit 1; }`,
      `    echo '{"number":18,"body":"Adds the API.","baseRefName":"main","url":"https://github.com/o/atlas/pull/18"}' ;;`,
      `  "pr edit") cat > "${body}" ;;`,
      '  *) exit 1 ;;',
      'esac',
    ].join('\n'));
    chmodSync(join(bin, 'gh'), 0o755);

    const session = 'sess-elsewhere';
    const base = { session_id: session, cwd: notch, transcript_path: join(dir, 'none.jsonl') };
    const payloads = [
      { ...base, hook_event_name: 'PostToolUseFailure', tool_name: 'Bash', tool_use_id: 't1',
        tool_input: { command: 'cd ../atlas-wt-01 && pytest' }, error: 'Exit code 1\nFAILED src/test_api.py::test_get' },
      { ...base, hook_event_name: 'PostToolUse', tool_name: 'Edit', tool_use_id: 't2',
        tool_input: { file_path: join(wt, 'src', 'api.py'), old_string: 'a', new_string: 'b' }, tool_response: {} },
      { ...base, hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_use_id: 't3',
        tool_input: { command: `cd ${wt} && gh pr create --fill` },
        tool_response: { stdout: 'https://github.com/o/atlas/pull/18\n', stderr: '' } },
      { ...base, hook_event_name: 'Stop' },
    ];

    const store = join(dir, 'store');
    for (const payload of payloads) {
      const p = spawnSync('node', [PDL, 'hook'], {
        cwd: notch, input: JSON.stringify(payload), encoding: 'utf8',
        env: { ...process.env, PDL_DISABLE: '', PDL_HOME: store, PATH: `${bin}:${process.env['PATH'] ?? ''}` },
      });
      assert.equal(p.status, 0, p.stderr);
    }

    const ghCalls = readFileSync(calls, 'utf8').trim().split('\n');
    assert.ok(ghCalls.some((c) => c.startsWith(`${wtRoot}|m0/01|pr edit 18`)), ghCalls.join('\n'));
    assert.ok(!ghCalls.some((c) => c.includes('|main|pr edit')), 'nothing was published to the starting repository');

    const published = readFileSync(body, 'utf8');
    assert.match(published, /Adds the API\./, 'the author text is kept');
    assert.match(published, /pytest/);
    assert.match(published, /`src\/api\.py`/, 'paths are relative to the worktree');
    assert.doesNotMatch(published, new RegExp(dir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), 'no absolute path is published');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
