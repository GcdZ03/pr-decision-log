import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isCosmeticChange } from '../src/flags/cosmetic.ts';

// Two of three new test-edit flags on real sessions were edits that only added
// `# noqa` comments. An edit that changes nothing but comments and whitespace
// does not change what a test checks, so it is not flagged.

test('comment and whitespace changes are cosmetic, per language', () => {
  assert.equal(isCosmeticChange('assert x == "bearer"', 'assert x == "bearer"  # noqa: S105', 'tests/test_a.py'), true);
  assert.equal(isCosmeticChange('expect(a).toBe(1);', 'expect(a).toBe(1); // eslint-disable-line', 'src/a.test.ts'), true);
  assert.equal(isCosmeticChange('expect(a).toBe(1);', '/* keep */ expect(a).toBe(1);', 'src/a.test.ts'), true);
  assert.equal(isCosmeticChange('assert  x==1', 'assert x == 1', 'tests/test_a.py'), false, 'spacing inside code is not proof of no change… unless only whitespace');
});

test('a change inside a string is not a comment, even when it contains # or //', () => {
  assert.equal(isCosmeticChange('assert s == "#a"', 'assert s == "#b"', 'tests/test_a.py'), false);
  assert.equal(isCosmeticChange("expect(u).toBe('http://a')", "expect(u).toBe('http://b')", 'src/a.test.ts'), false);
});

test('a code change with a comment is not cosmetic', () => {
  assert.equal(isCosmeticChange('assert x == 1', 'assert x == 2  # fixed', 'tests/test_a.py'), false);
});

test('in a language without known comment syntax only whitespace counts', () => {
  assert.equal(isCosmeticChange('a  =  1', 'a = 1', 'tests/a.unknown'), true);
  assert.equal(isCosmeticChange('a = 1', 'a = 1 # x', 'tests/a.unknown'), false);
});
