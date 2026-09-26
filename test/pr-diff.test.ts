import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { diffAgainst, defaultBase } from '../src/publish/pr-diff.ts';

/** main <- feat-a <- feat-b, pushed to a bare remote; feat-b is checked out. */
function withStack(fn: (work: string) => void) {
  const root = mkdtempSync(join(tmpdir(), 'pdl-stack-'));
  const g = (cwd: string, ...args: string[]) =>
    execFileSync('git', args, { cwd, stdio: 'pipe', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } });
  try {
    const remote = join(root, 'remote.git');
    const work = join(root, 'work');
    g(root, 'init', '-q', '--bare', remote);
    g(root, 'init', '-q', '-b', 'main', work);
    g(work, 'remote', 'add', 'origin', remote);
    const commit = (file: string) => { writeFileSync(join(work, file), `${file}\n`); g(work, 'add', file); g(work, 'commit', '-q', '-m', file); };
    commit('base.txt');
    g(work, 'push', '-q', 'origin', 'main');
    g(work, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main');
    g(work, 'checkout', '-q', '-b', 'feat-a');
    commit('a.txt');
    g(work, 'push', '-q', 'origin', 'feat-a');
    g(work, 'checkout', '-q', '-b', 'feat-b');
    commit('b.txt');
    fn(work);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const files = (diff: string) => [...diff.matchAll(/^diff --git a\/(\S+)/gm)].map((m) => m[1]);

test("a stacked PR diffed against its own base shows only its own changes", () => {
  withStack((work) => {
    assert.deepEqual(files(diffAgainst('feat-a', work)), ['b.txt']);
  });
});

test('the same branch diffed against the default branch includes its parent too', () => {
  withStack((work) => {
    assert.deepEqual(files(diffAgainst('main', work)), ['a.txt', 'b.txt']);
  });
});

test('a base that exists only locally still diffs', () => {
  withStack((work) => {
    execFileSync('git', ['branch', '-q', 'local-only', 'feat-a'], { cwd: work });
    assert.deepEqual(files(diffAgainst('local-only', work)), ['b.txt']);
  });
});

test('an unknown base yields an empty diff rather than an error', () => {
  withStack((work) => {
    assert.equal(diffAgainst('no-such-branch', work), '');
  });
});

test("the default base is the remote's default branch", () => {
  withStack((work) => {
    assert.equal(defaultBase(work), 'main');
  });
});
