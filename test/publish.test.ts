import { test } from 'node:test';
import assert from 'node:assert/strict';
import { publish, type GhRunner } from '../src/publish/publish.ts';

/** Records calls and replays canned responses; no network, no real `gh`. */
function fakeGh(responses: Record<string, string>) {
  const calls: { args: string[]; stdin?: string }[] = [];
  const run: GhRunner = (args, stdin) => {
    calls.push({ args, stdin });
    const key = args.slice(0, 3).join(' ');
    if (key in responses) return { ok: true, stdout: responses[key] ?? '' };
    return { ok: true, stdout: '' };
  };
  return { run, calls };
}

const SECTION = '<!-- pdl:start v=1 -->\n## Decision log\n<!-- pdl:end -->';

test('reads the current body then writes the spliced one via stdin', async () => {
  const gh = fakeGh({ 'pr view 7': JSON.stringify({ body: 'Original text.' }) });

  const result = await publish({ prNumber: 7, section: SECTION, gh: gh.run });

  assert.equal(result.status, 'updated');
  const edit = gh.calls.find((c) => c.args[0] === 'pr' && c.args[1] === 'edit');
  assert.ok(edit, 'expected a pr edit call');
  assert.ok(edit?.args.includes('--body-file'), 'body must travel as a file/stdin, never in argv');
  assert.ok(edit?.args.includes('-'));
  assert.ok(edit?.stdin?.includes('Original text.'), 'author text must be preserved');
  assert.ok(edit?.stdin?.includes('## Decision log'));
});

test('is a no-op when the body already carries identical content', async () => {
  const gh1 = fakeGh({ 'pr view 7': JSON.stringify({ body: '' }) });
  const first = await publish({ prNumber: 7, section: SECTION, gh: gh1.run });

  const gh2 = fakeGh({ 'pr view 7': JSON.stringify({ body: first.body }) });
  const second = await publish({ prNumber: 7, section: SECTION, gh: gh2.run });

  assert.equal(second.status, 'unchanged');
  assert.ok(!gh2.calls.some((c) => c.args[1] === 'edit'), 'must not call pr edit when nothing changed');
});

test('dry run never calls pr edit', async () => {
  const gh = fakeGh({ 'pr view 7': JSON.stringify({ body: 'x' }) });
  const result = await publish({ prNumber: 7, section: SECTION, gh: gh.run, dryRun: true });

  assert.equal(result.status, 'dry-run');
  assert.ok(!gh.calls.some((c) => c.args[1] === 'edit'));
  assert.ok(result.body.includes('## Decision log'));
});

test('a gh failure is reported, never thrown', async () => {
  const run: GhRunner = () => ({ ok: false, stdout: '', stderr: 'gh: not authenticated' });
  const result = await publish({ prNumber: 7, section: SECTION, gh: run });

  assert.equal(result.status, 'failed');
  assert.match(result.error ?? '', /not authenticated/);
});

test('never passes the body as a command-line argument', async () => {
  const nasty = '<!-- pdl:start v=1 -->\n`$(rm -rf /)` "quoted" $HOME\n<!-- pdl:end -->';
  const gh = fakeGh({ 'pr view 7': JSON.stringify({ body: '' }) });

  await publish({ prNumber: 7, section: nasty, gh: gh.run });

  for (const call of gh.calls) {
    for (const arg of call.args) {
      assert.ok(!arg.includes('$(rm'), `body leaked into argv: ${arg}`);
    }
  }
});
