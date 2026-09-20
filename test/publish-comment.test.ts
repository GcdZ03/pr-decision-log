import { test } from 'node:test';
import assert from 'node:assert/strict';
import { publishComment } from '../src/publish/publish-comment.ts';
import type { GhResult } from '../src/publish/publish.ts';

const SECTION = '<!-- pdl:start v=1 -->\n## Decision log\n\nbody\n<!-- pdl:end -->\n';
const ok = (stdout: string): GhResult => ({ ok: true, stdout });
const fail = (stderr: string): GhResult => ({ ok: false, stdout: '', stderr });

type Call = { args: string[]; stdin?: string };

function runner(handlers: (c: Call) => GhResult | undefined) {
  const calls: Call[] = [];
  const gh = async (args: string[], stdin?: string): Promise<GhResult> => {
    const call = { args, stdin };
    calls.push(call);
    return handlers(call) ?? ok('');
  };
  return { gh, calls };
}

const listPath = (c: Call) => c.args.includes('repos/o/r/issues/7/comments');

test('with no existing comment, one is created', async () => {
  const { gh, calls } = runner((c) => (listPath(c) ? ok('[]') : undefined));

  const result = await publishComment({ prNumber: 7, section: SECTION, gh, repo: 'o/r' });

  assert.equal(result.status, 'updated');
  const post = calls.find((c) => c.args.includes('-X') && c.args.includes('POST'));
  assert.ok(post, 'no comment was created');
  assert.match(post.stdin ?? '', /Decision log/);
});

test('an existing pdl comment is edited by id rather than duplicated', async () => {
  const existing = JSON.stringify([
    { id: 111, body: 'unrelated review note' },
    { id: 222, body: '<!-- pdl:start v=1 -->\nold\n<!-- pdl:hash=deadbeef -->\n<!-- pdl:end -->' },
  ]);
  const { gh, calls } = runner((c) => (listPath(c) ? ok(existing) : undefined));

  const result = await publishComment({ prNumber: 7, section: SECTION, gh, repo: 'o/r' });

  assert.equal(result.status, 'updated');
  assert.ok(calls.some((c) => c.args.some((a) => a.includes('issues/comments/222'))), 'did not patch by id');
  assert.ok(!calls.some((c) => c.args.includes('POST')), 'created a duplicate comment');
});

test("a comment written by someone else is never touched", async () => {
  const existing = JSON.stringify([{ id: 111, body: 'looks good to me' }]);
  const { gh, calls } = runner((c) => (listPath(c) ? ok(existing) : undefined));

  await publishComment({ prNumber: 7, section: SECTION, gh, repo: 'o/r' });

  assert.ok(!calls.some((c) => c.args.some((a) => a.includes('issues/comments/111'))), 'edited a foreign comment');
});

test('republishing identical content writes nothing', async () => {
  const first = runner((c) => (listPath(c) ? ok('[]') : undefined));
  const created = await publishComment({ prNumber: 7, section: SECTION, gh: first.gh, repo: 'o/r' });

  const existing = JSON.stringify([{ id: 222, body: created.body }]);
  const second = runner((c) => (listPath(c) ? ok(existing) : undefined));
  const result = await publishComment({ prNumber: 7, section: SECTION, gh: second.gh, repo: 'o/r' });

  assert.equal(result.status, 'unchanged');
  assert.equal(second.calls.length, 1, 'wrote despite unchanged content');
});

test('a failed listing reports failure instead of creating a second comment', async () => {
  const { gh, calls } = runner((c) => (listPath(c) ? fail('HTTP 403') : undefined));

  const result = await publishComment({ prNumber: 7, section: SECTION, gh, repo: 'o/r' });

  assert.equal(result.status, 'failed');
  assert.match(result.error ?? '', /403/);
  assert.equal(calls.length, 1, 'wrote after a failed read');
});

test('the body travels on stdin, never as a shell argument', async () => {
  const { gh, calls } = runner((c) => (listPath(c) ? ok('[]') : undefined));

  await publishComment({ prNumber: 7, section: '<!-- pdl:start v=1 -->\n$(whoami)\n<!-- pdl:end -->\n', gh, repo: 'o/r' });

  for (const c of calls) {
    assert.ok(!c.args.some((a) => a.includes('$(whoami)')), `payload reached argv: ${c.args.join(' ')}`);
  }
});

test('a dry run reports what it would do without writing', async () => {
  const { gh, calls } = runner((c) => (listPath(c) ? ok('[]') : undefined));

  const result = await publishComment({ prNumber: 7, section: SECTION, gh, repo: 'o/r', dryRun: true });

  assert.equal(result.status, 'dry-run');
  assert.equal(calls.length, 1);
});
