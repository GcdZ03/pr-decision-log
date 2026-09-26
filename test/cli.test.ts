import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PDL = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'pdl.ts');

/** A throwaway git repo on branch `feat`, and a pdl store holding one session's events and turn there. */
function withRepo(fn: (a: { repo: string; run: (...args: string[]) => { out: string; err: string; code: number } }) => void) {
  const dir = mkdtempSync(join(tmpdir(), 'pdl-cli-'));
  try {
    const repo = join(dir, 'repo');
    const store = join(dir, 'store');
    mkdirSync(repo);
    const g = (...args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
    g('init', '-q', '-b', 'feat');
    const root = g('rev-parse', '--show-toplevel');

    mkdirSync(join(store, 'events'), { recursive: true });
    writeFileSync(join(store, 'events', 'sess-cli-1.jsonl'),
      `${JSON.stringify({ kind: 'command', id: 't1', at: '2026-09-26T10:00:00.000Z', command: 'npm test', classification: 'test', outcome: 'fail' })}\n`);
    writeFileSync(join(store, 'turns.jsonl'),
      `${JSON.stringify({ session: 'sess-cli-1', repo: root, branch: 'feat', at: '2026-09-26T10:01:00.000Z' })}\n`);

    const run = (...args: string[]) => {
      const p = spawnSync('node', [PDL, ...args], { cwd: repo, encoding: 'utf8', env: { ...process.env, PDL_HOME: store } });
      return { out: p.stdout, err: p.stderr, code: p.status ?? -1 };
    };
    fn({ repo, run });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('pdl show with no session shows the current branch', () => {
  withRepo(({ run }) => {
    const r = run('show');

    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /npm test/);
    assert.match(r.out, /feat/);
  });
});

test('pdl sessions lists recorded sessions for this repo, with their branch', () => {
  withRepo(({ run }) => {
    const r = run('sessions');

    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /sess-cli-1/);
    assert.match(r.out, /feat/);
  });
});

test('pdl remove takes out what pdl init added, at project scope', () => {
  withRepo(({ repo, run }) => {
    run('init');
    const r = run('remove');

    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /removed 6/);
    const settings = JSON.parse(readFileSync(join(repo, '.claude', 'settings.json'), 'utf8')) as Record<string, unknown>;
    assert.equal(settings['hooks'], undefined);
  });
});

test('pdl remove with nothing registered says so and succeeds', () => {
  withRepo(({ run }) => {
    const r = run('remove');

    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /no pdl hooks/i);
  });
});

// A reader that stops early, like `pdl build | head`, closes the pipe while
// pdl is still writing. Node raised that as an unhandled EPIPE and crashed
// with a stack trace; `git log | head` just stops. Seen during the npm checks.

test('output piped into a reader that stops early ends quietly, not with a stack trace', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pdl-epipe-'));
  try {
    const big = join(dir, 'big.txt');
    writeFileSync(big, 'ordinary text, nothing to redact\n'.repeat(200_000));

    const p = spawnSync('bash', ['-c', `set -o pipefail; node "${PDL}" redact-check "${big}" | head -1 >/dev/null`], {
      encoding: 'utf8',
    });

    assert.ok(!/EPIPE|Unhandled 'error' event/.test(p.stderr), `crashed on a closed pipe:\n${p.stderr.slice(0, 400)}`);
    assert.equal(p.status, 0, 'a reader stopping early is not a failure');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
