import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { autoPublish, FilePublishState, type PublishStateStore } from '../src/publish/auto-publish.ts';
import type { GhResult } from '../src/publish/publish.ts';

const ok = (stdout: string): GhResult => ({ ok: true, stdout });
const fail = (stderr: string): GhResult => ({ ok: false, stdout: '', stderr });

const memoryState = (): PublishStateStore => {
  const m = new Map<string, unknown>();
  return { get: (k) => (m.get(k) as never) ?? {}, set: (k, v) => void m.set(k, v) };
};

const PR = (over: Record<string, unknown> = {}) => ok(JSON.stringify({
  number: 7, body: 'Original description.', baseRefName: 'main', url: 'https://github.com/o/r/pull/7', ...over,
}));

/** A gh stand-in that records calls; `view` answers the single PR lookup. */
function fakeGh(view: () => GhResult) {
  const calls: string[][] = [];
  const gh = async (args: string[]): Promise<GhResult> => {
    calls.push(args);
    if (args[0] === 'pr' && args[1] === 'view') return view();
    if (args[0] === 'api' && args.includes('--paginate')) return ok('[]');
    return ok('');
  };
  return { gh, calls };
}

const section = (text = 'body') => `<!-- pdl:start v=1 -->\n## Decision log\n\n${text}\n<!-- pdl:end -->\n`;
const base = { key: '/r#feat', created: false, defaultBase: 'main' };
const T0 = 1_000_000_000_000;

test('a PR is resolved, read and based in one gh call, then edited', async () => {
  const { gh, calls } = fakeGh(() => PR());

  const result = await autoPublish({ ...base, gh, state: memoryState(), now: T0, build: () => section() });

  assert.equal(result.status, 'updated');
  assert.match(result.body, /Original description\./);
  assert.equal(calls.filter((c) => c[1] === 'view').length, 1, 'more than one PR lookup');
  assert.equal(calls.length, 2, 'expected exactly one view and one edit');
});

test('with no PR the log is never built and one call is made', async () => {
  const { gh, calls } = fakeGh(() => fail('no pull requests found for branch "feat"'));
  let built = 0;

  const result = await autoPublish({ ...base, gh, state: memoryState(), now: T0, build: () => (built++, section()) });

  assert.equal(result.status, 'skipped');
  assert.equal(built, 0, 'built a log with nowhere to publish it');
  assert.equal(calls.length, 1);
});

test('a branch known to have no PR makes no network call for the next few minutes', async () => {
  const state = memoryState();
  const first = fakeGh(() => fail('no pull requests found'));
  await autoPublish({ ...base, gh: first.gh, state, now: T0, build: () => section() });

  const second = fakeGh(() => fail('no pull requests found'));
  const result = await autoPublish({ ...base, gh: second.gh, state, now: T0 + 60_000, build: () => section() });

  assert.equal(result.status, 'skipped');
  assert.equal(second.calls.length, 0, 'asked gh again within the no-PR window');
});

test('after the no-PR window it checks again, so a PR opened on the web is picked up', async () => {
  const state = memoryState();
  await autoPublish({ ...base, gh: fakeGh(() => fail('none')).gh, state, now: T0, build: () => section() });

  const later = fakeGh(() => PR());
  const result = await autoPublish({ ...base, gh: later.gh, state, now: T0 + 10 * 60_000, build: () => section() });

  assert.equal(result.status, 'updated');
});

test('gh pr create bypasses the no-PR window, because the PR exists now', async () => {
  const state = memoryState();
  await autoPublish({ ...base, gh: fakeGh(() => fail('none')).gh, state, now: T0, build: () => section() });

  const created = fakeGh(() => PR());
  const result = await autoPublish({ ...base, created: true, gh: created.gh, state, now: T0 + 1000, build: () => section() });

  assert.equal(result.status, 'updated');
});

test('an unchanged log since the last publish makes no network call at all', async () => {
  const state = memoryState();
  await autoPublish({ ...base, gh: fakeGh(() => PR()).gh, state, now: T0, build: () => section('same') });

  const again = fakeGh(() => PR());
  const result = await autoPublish({ ...base, gh: again.gh, state, now: T0 + 1000, build: () => section('same') });

  assert.equal(result.status, 'unchanged');
  assert.equal(again.calls.length, 0, 'called gh for a log that had not changed');
});

test('a changed log is published again', async () => {
  const state = memoryState();
  await autoPublish({ ...base, gh: fakeGh(() => PR()).gh, state, now: T0, build: () => section('one') });

  const again = fakeGh(() => PR());
  const result = await autoPublish({ ...base, gh: again.gh, state, now: T0 + 1000, build: () => section('two') });

  assert.equal(result.status, 'updated');
});

test("a stacked PR's log is built against the PR's own base, not the default branch", async () => {
  const bases: string[] = [];
  const { gh } = fakeGh(() => PR({ baseRefName: 'feat-a' }));

  const result = await autoPublish({ ...base, gh, state: memoryState(), now: T0, build: (b) => (bases.push(b), section(`diff vs ${b}`)) });

  assert.equal(bases.at(-1), 'feat-a');
  assert.match(result.body, /diff vs feat-a/);
});

test('the PR base is remembered, so the next turn builds against it first time', async () => {
  const state = memoryState();
  await autoPublish({ ...base, gh: fakeGh(() => PR({ baseRefName: 'feat-a' })).gh, state, now: T0, build: (b) => section(b) });

  const bases: string[] = [];
  await autoPublish({ ...base, gh: fakeGh(() => PR({ baseRefName: 'feat-a' })).gh, state, now: T0 + 1000, build: (b) => (bases.push(b), section(`${b}!`)) });

  assert.deepEqual(bases, ['feat-a']);
});

test('the kill switch skips before any work', async () => {
  const { gh, calls } = fakeGh(() => PR());
  let built = 0;

  const result = await autoPublish({ ...base, gh, state: memoryState(), now: T0, env: { PDL_DISABLE: '1' }, build: () => (built++, section()) });

  assert.equal(result.status, 'skipped');
  assert.equal(built + calls.length, 0);
});

test('a missing gh never throws', async () => {
  const gh = async (): Promise<GhResult> => { throw new Error('spawn gh ENOENT'); };

  const result = await autoPublish({ ...base, gh, state: memoryState(), now: T0, build: () => section() });

  assert.equal(result.status, 'skipped');
  assert.match(result.error ?? '', /ENOENT/);
});

test('comment mode takes owner/repo from the PR url instead of a second gh call', async () => {
  const { gh, calls } = fakeGh(() => PR());

  const result = await autoPublish({ ...base, mode: 'comment', gh, state: memoryState(), now: T0, build: () => section() });

  assert.equal(result.status, 'updated');
  assert.ok(calls.some((c) => c.some((a) => a.startsWith('repos/o/r/issues/7'))), 'did not use owner/repo from the url');
  assert.ok(!calls.some((c) => c[0] === 'repo'), 'made a separate gh repo view call');
  assert.ok(!calls.some((c) => c[1] === 'edit'), 'edited the PR body in comment mode');
});

test('the file-backed state survives a restart and tolerates a corrupt file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pdl-state-'));
  try {
    const path = join(dir, 'publish-state.json');
    new FilePublishState(path).set('/r#feat', { pr: 7, lastHash: 'abc' });
    assert.deepEqual(new FilePublishState(path).get('/r#feat'), { pr: 7, lastHash: 'abc' });

    writeFileSync(path, '{ torn');
    assert.deepEqual(new FilePublishState(path).get('/r#feat'), {});
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
