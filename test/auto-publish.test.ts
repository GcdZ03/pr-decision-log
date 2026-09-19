import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolvePrNumber, autoPublish } from '../src/publish/auto-publish.ts';
import type { GhResult } from '../src/publish/publish.ts';

const ok = (stdout: string): GhResult => ({ ok: true, stdout });
const fail = (stderr: string): GhResult => ({ ok: false, stdout: '', stderr });

test('the pull request for the current branch is resolved from gh', async () => {
  const gh = async () => ok('{"number":42}');

  assert.equal(await resolvePrNumber(gh), 42);
});

test('a branch with no pull request resolves to null rather than failing', async () => {
  const gh = async () => fail('no pull requests found for branch "feat"');

  assert.equal(await resolvePrNumber(gh), null);
});

test('unparseable gh output resolves to null', async () => {
  const gh = async () => ok('not json');

  assert.equal(await resolvePrNumber(gh), null);
});

test('gh output without a number resolves to null', async () => {
  const gh = async () => ok('{}');

  assert.equal(await resolvePrNumber(gh), null);
});

test('auto-publish writes the section to the resolved pull request', async () => {
  const calls: string[][] = [];
  const gh = async (args: string[]): Promise<GhResult> => {
    calls.push(args);
    if (args[1] === 'view' && args.includes('number')) return ok('{"number":7}');
    if (args[1] === 'view') return ok('{"body":"Original description."}');
    return ok('');
  };

  const result = await autoPublish({ section: '## Decision log\n\nnothing to report', gh });

  assert.equal(result.status, 'updated');
  assert.match(result.body, /Original description\./);
  assert.match(result.body, /Decision log/);
  assert.ok(calls.some((a) => a[1] === 'edit'), 'never called gh pr edit');
});

test('auto-publish is a no-op when the branch has no pull request', async () => {
  const gh = async (args: string[]): Promise<GhResult> =>
    args[1] === 'view' && args.includes('number') ? fail('no pull requests found') : ok('');

  const result = await autoPublish({ section: '## Decision log', gh });

  assert.equal(result.status, 'skipped');
});

test('auto-publish never throws when gh is missing entirely', async () => {
  const gh = async (): Promise<GhResult> => {
    throw new Error('spawn gh ENOENT');
  };

  const result = await autoPublish({ section: '## Decision log', gh });

  assert.equal(result.status, 'skipped');
  assert.match(result.error ?? '', /ENOENT/);
});

test('auto-publish is skipped by the kill switch', async () => {
  let called = false;
  const gh = async (): Promise<GhResult> => {
    called = true;
    return ok('{"number":7}');
  };

  const result = await autoPublish({ section: '## Decision log', gh, env: { PDL_DISABLE: '1' } });

  assert.equal(result.status, 'skipped');
  assert.equal(called, false, 'gh was invoked while disabled');
});
