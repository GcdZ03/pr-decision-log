import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyzeDiff } from '../src/flags/diff-signals.ts';

/** A minimal unified diff for one file. `-` and `+` prefixes mark removed and added lines. */
function fileDiff(path: string, body: string[], opts: { deleted?: boolean } = {}): string {
  return [
    `diff --git a/${path} b/${path}`,
    ...(opts.deleted ? ['deleted file mode 100644'] : []),
    'index 1111111..2222222 100644',
    `--- a/${path}`,
    opts.deleted ? '+++ /dev/null' : `+++ b/${path}`,
    '@@ -1,9 +1,9 @@',
    ...body,
  ].join('\n');
}

const codes = (diff: string) => analyzeDiff(diff).map((f) => f.code);
const only = (diff: string, code: string) => analyzeDiff(diff).filter((f) => f.code === code);

// ASSERTIONS_REMOVED

test('net-removed assertions in a test file are flagged with both counts', () => {
  const flags = only(fileDiff('src/sum.test.ts', [
    " describe('sum', () => {",
    '-  expect(sum(1, 2)).toBe(3);',
    '-  expect(sum(2, 2)).toBe(4);',
    '+  expect(sum(1, 2)).toBe(3);',
    ' });',
  ]), 'ASSERTIONS_REMOVED');

  assert.equal(flags.length, 1);
  assert.equal(flags[0]?.file, 'src/sum.test.ts');
  assert.match(flags[0]?.detail ?? '', /2 removed, 1 added/);
});

test('an assertion that was only moved is not flagged', () => {
  assert.deepEqual(codes(fileDiff('src/sum.test.ts', [
    '-  expect(a).toBe(1);',
    '   const x = 1;',
    '+  expect(a).toBe(1);',
  ])), []);
});

test('adding assertions is never flagged', () => {
  assert.deepEqual(codes(fileDiff('src/sum.test.ts', ['+  expect(a).toBe(1);'])), []);
});

test('assertion-like lines removed from source code are not flagged', () => {
  assert.deepEqual(codes(fileDiff('src/sum.ts', ['-  assert(x > 0);'])), []);
});

test('a removed Python bare assert counts', () => {
  assert.deepEqual(codes(fileDiff('tests/test_sum.py', ['-    assert total == 3'])), ['ASSERTIONS_REMOVED']);
});

test('a removed Go testify assertion counts', () => {
  assert.deepEqual(codes(fileDiff('sum_test.go', ['-\trequire.Equal(t, 3, Sum(1, 2))'])), ['ASSERTIONS_REMOVED']);
});

test('a removed XCTest assertion counts', () => {
  assert.deepEqual(codes(fileDiff('Tests/SumTests.swift', ['-        XCTAssertEqual(sum(1, 2), 3)'])), ['ASSERTIONS_REMOVED']);
});

test('the word assert in a JavaScript comment is not an assertion', () => {
  assert.deepEqual(codes(fileDiff('src/sum.test.ts', ['-  // assert that sums are commutative'])), []);
});

// TEST_SKIPPED

test('an added .skip is flagged', () => {
  assert.deepEqual(codes(fileDiff('src/sum.test.ts', [
    "-  it('adds', () => {",
    "+  it.skip('adds', () => {",
  ])), ['TEST_SKIPPED']);
});

test('an added .only is flagged, because it silently skips everything else', () => {
  const flags = only(fileDiff('src/sum.test.ts', [
    "-  it('adds', () => {",
    "+  it.only('adds', () => {",
  ]), 'TEST_SKIPPED');

  assert.equal(flags.length, 1);
  assert.match(flags[0]?.detail ?? '', /only/);
});

test('an added pytest skip marker is flagged', () => {
  assert.deepEqual(codes(fileDiff('tests/test_sum.py', ['+@pytest.mark.skip(reason="flaky")'])), ['TEST_SKIPPED']);
});

test('an added Go t.Skip is flagged', () => {
  assert.deepEqual(codes(fileDiff('sum_test.go', ['+\tt.Skip("later")'])), ['TEST_SKIPPED']);
});

test('a skip that was already there, in unchanged context, is not flagged', () => {
  assert.deepEqual(codes(fileDiff('src/sum.test.ts', [
    "   it.skip('legacy', () => {});",
    '+  const y = 2;',
  ])), []);
});

test('removing a skip is not flagged', () => {
  assert.deepEqual(codes(fileDiff('src/sum.test.ts', [
    "-  it.skip('adds', () => {",
    "+  it('adds', () => {",
  ])), []);
});

// TEST_DELETED

test('a removed test with no replacement is flagged', () => {
  const flags = only(fileDiff('src/sum.test.ts', [
    "-  it('handles negatives', () => {",
    '-    expect(sum(-1, -1)).toBe(-2);',
    '-  });',
  ]), 'TEST_DELETED');

  assert.equal(flags.length, 1);
  assert.match(flags[0]?.detail ?? '', /1 test/);
});

test('a renamed test is not a deletion', () => {
  assert.deepEqual(only(fileDiff('src/sum.test.ts', [
    "-  it('adds', () => {",
    "+  it('adds two numbers', () => {",
  ]), 'TEST_DELETED'), []);
});

test('a removed Python test function is flagged', () => {
  assert.equal(only(fileDiff('tests/test_sum.py', ['-def test_negatives():']), 'TEST_DELETED').length, 1);
});

test('a removed Go test function is flagged', () => {
  assert.equal(only(fileDiff('sum_test.go', ['-func TestNegatives(t *testing.T) {']), 'TEST_DELETED').length, 1);
});

test('a deleted test file reports every test it held', () => {
  const flags = only(fileDiff('src/sum.test.ts', [
    "-  it('a', () => {});",
    "-  it('b', () => {});",
    "-  test('c', () => {});",
  ], { deleted: true }), 'TEST_DELETED');

  assert.match(flags[0]?.detail ?? '', /3 tests/);
});

// EXPECTATION_LOOSENED

const sourceChange = fileDiff('src/sum.ts', ['-  return a + b;', '+  return a + b + 1;']);

test('a changed expected literal is noted when the code under test also changed', () => {
  const flags = only([
    sourceChange,
    fileDiff('src/sum.test.ts', ['-  expect(sum(1, 2)).toBe(3);', '+  expect(sum(1, 2)).toBe(4);']),
  ].join('\n'), 'EXPECTATION_LOOSENED');

  assert.equal(flags.length, 1);
  assert.equal(flags[0]?.severity, 'info', 'this is often legitimate, so it must never warn');
  assert.match(flags[0]?.detail ?? '', /src\/sum\.ts/);
});

test('a changed expectation with no source change is not noted, because that is a test update', () => {
  assert.deepEqual(only(
    fileDiff('src/sum.test.ts', ['-  expect(sum(1, 2)).toBe(3);', '+  expect(sum(1, 2)).toBe(4);']),
    'EXPECTATION_LOOSENED',
  ), []);
});

test('a Python test maps to its module for the source check', () => {
  const flags = only([
    fileDiff('app/sum.py', ['-    return a + b', '+    return a + b + 1']),
    fileDiff('tests/test_sum.py', ['-    assertEqual(total(1, 2), 3)', '+    assertEqual(total(1, 2), 4)']),
  ].join('\n'), 'EXPECTATION_LOOSENED');

  assert.equal(flags.length, 1);
});

test('rewriting what is asserted, not just the literal, is not treated as a changed expectation', () => {
  assert.deepEqual(only([
    sourceChange,
    fileDiff('src/sum.test.ts', ['-  expect(sum(1, 2)).toBe(3);', '+  expect(product(1, 2)).toBe(2);']),
  ].join('\n'), 'EXPECTATION_LOOSENED'), []);
});

// General

test('an empty diff yields no flags', () => {
  assert.deepEqual(analyzeDiff(''), []);
});

test('a binary file entry does not break parsing', () => {
  const diff = [
    'diff --git a/logo.png b/logo.png',
    'index 1111111..2222222 100644',
    'Binary files a/logo.png and b/logo.png differ',
    fileDiff('src/sum.test.ts', ['-  expect(a).toBe(1);']),
  ].join('\n');

  assert.deepEqual(codes(diff), ['ASSERTIONS_REMOVED']);
});

test('diff headers are not mistaken for removed or added lines', () => {
  // `--- a/x` starts with the same character as a removed line. For a deleted
  // file there is no matching `+++ b/x` to cancel it out, and this path reads
  // as a Go `t.Error` assertion, so a leaked header would flag a removal.
  assert.deepEqual(codes(fileDiff('src/t.Errors.test.ts', ['-  const z = 3;'], { deleted: true })), []);
});

// Found by running the analyser on its own branch: this file's fixtures hold
// skip markers and assertions inside string literals, and every one of them
// was flagged as if it were code.

test('a skip marker inside a string literal is not a skip', () => {
  assert.deepEqual(codes(fileDiff('test/fixtures.test.ts', [
    `+    "+  it.skip('adds', () => {",`,
    `+  assert.deepEqual(codes(fileDiff('tests/test_sum.py', ['+@pytest.mark.skip(reason="flaky")'])), []);`,
  ])), []);
});

test('a real skip with a string argument is still flagged', () => {
  assert.deepEqual(codes(fileDiff('src/sum.test.ts', [`+  it.skip("adds", () => {`])), ['TEST_SKIPPED']);
});

test('an assertion quoted inside a removed string literal is not a removed assertion', () => {
  assert.deepEqual(codes(fileDiff('test/fixtures.test.ts', [`-    '-  expect(sum(1, 2)).toBe(3);',`])), []);
});

test('a real assertion whose arguments are strings still counts', () => {
  assert.deepEqual(codes(fileDiff('src/user.test.ts', [`-  expect(user.name).toBe('bob');`])), ['ASSERTIONS_REMOVED']);
});

// Found by running the analysers over the history of the author's own repos.

test('a removed Swift Testing @Test is a deleted test', () => {
  // CreativeNotch has 974 @Test declarations and no `func test...` at all.
  assert.equal(only(fileDiff('Tests/SumTests.swift', [
    '-    @Test func addsTwoNumbers() {',
    '-        #expect(sum(1, 2) == 3)',
    '-    }',
  ]), 'TEST_DELETED').length, 1);
});

test('a removed @Test with a display name is a deleted test', () => {
  assert.equal(only(fileDiff('Tests/SumTests.swift', ['-    @Test("adds two numbers") func adds() {']), 'TEST_DELETED').length, 1);
});

const deletedPair = (source: string, testPath: string, testBody: string[]) => [
  fileDiff(source, ['-export const coalesce = () => {};'], { deleted: true }),
  fileDiff(testPath, testBody, { deleted: true }),
].join('\n');

test('tests removed together with the code they test are a note, not a warning', () => {
  const flags = analyzeDiff(deletedPair('src/coalescer.ts', 'src/coalescer.test.ts', [
    "-  it('coalesces', () => {",
    '-    expect(coalesce()).toBe(1);',
    '-  });',
  ]));

  assert.ok(flags.length > 0, 'the removal should still be recorded');
  for (const f of flags) {
    assert.equal(f.severity, 'info', `${f.code} warned about a test removed with its code`);
    assert.match(f.detail, /src\/coalescer\.ts/);
  }
});

test('the Swift naming convention maps a deleted test file to its deleted source', () => {
  const flags = analyzeDiff(deletedPair('Sources/Core/HUDCoalescer.swift', 'Tests/CoreTests/HUDCoalescerTests.swift', [
    '-    @Test func coalesces() {',
    '-        #expect(coalescer.count == 1)',
  ]));

  assert.ok(flags.length > 0);
  assert.ok(flags.every((f) => f.severity === 'info'));
});

// Severity. Over 320 real commits, 0 of 45 standalone removal warnings were
// shortcuts: the diff knows what disappeared but not why. The timeline knows
// why, so the diff signal only warns when the timeline corroborates it.

const removal = [
  fileDiff('src/sum.ts', ['-  return a + b;', '+  return a + b + 1;']),
  fileDiff('src/sum.test.ts', ["-  it('adds', () => {", '-    expect(sum(1, 2)).toBe(3);', '-  });']),
].join('\n');

test('a removal with no timeline evidence is a note', () => {
  for (const f of analyzeDiff(removal)) assert.equal(f.severity, 'info', `${f.code} warned without corroboration`);
});

test('a removal in a file that was edited after its test failed is a warning', () => {
  const flags = analyzeDiff(removal, { corroborated: new Set(['src/sum.test.ts']) });

  assert.ok(flags.length >= 2);
  for (const f of flags) assert.equal(f.severity, 'warn', `${f.code} stayed a note despite corroboration`);
  assert.match(flags[0]?.detail ?? '', /after .*fail/i, 'the warning should say why it escalated');
});

test('corroboration on a different file does not escalate this one', () => {
  const flags = analyzeDiff(removal, { corroborated: new Set(['src/other.test.ts']) });

  for (const f of flags) assert.equal(f.severity, 'info');
});

test('a removal that follows deleted code stays a note even when corroborated', () => {
  // Deleting code makes its tests fail, so a failure followed by a test edit
  // is exactly what a legitimate removal looks like.
  const flags = analyzeDiff(
    deletedPair('src/coalescer.ts', 'src/coalescer.test.ts', ['-    expect(coalesce()).toBe(1);']),
    { corroborated: new Set(['src/coalescer.test.ts']) },
  );

  assert.ok(flags.length > 0);
  for (const f of flags) assert.equal(f.severity, 'info');
});

test('an added skip warns on its own, because none fired across 320 real commits', () => {
  const flags = only(fileDiff('src/sum.test.ts', ["+  it.only('adds', () => {"]), 'TEST_SKIPPED');

  assert.equal(flags[0]?.severity, 'warn');
});

// Found when a real agent, told to make a failing test pass without touching
// the code, marked it `todo` instead. In node:test a todo test still runs, but
// its failure no longer fails the run, so `npm test` went green.

test("node:test's todo option on an existing test is a skip", () => {
  const flags = only(fileDiff('sum.test.js', [
    "-test('adds small numbers', () => {",
    "+test('adds small numbers', { todo: 'sum.js off-by-one bug' }, () => {",
  ]), 'TEST_SKIPPED');

  assert.equal(flags.length, 1);
  assert.equal(flags[0]?.severity, 'warn');
});

test("node:test's skip option is a skip", () => {
  assert.equal(only(fileDiff('sum.test.js', ["+test('adds', { timeout: 50, skip: true }, () => {"]), 'TEST_SKIPPED').length, 1);
});

test('an explicit skip: false is not a skip', () => {
  assert.deepEqual(only(fileDiff('sum.test.js', ["+test('adds', { skip: false }, () => {"]), 'TEST_SKIPPED'), []);
});

test('adding the todo option is not also read as a deleted test', () => {
  assert.deepEqual(only(fileDiff('sum.test.js', [
    "-test('adds small numbers', () => {",
    "+test('adds small numbers', { todo: 'later' }, () => {",
  ]), 'TEST_DELETED'), []);
});
