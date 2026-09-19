import { test } from 'node:test';
import assert from 'node:assert/strict';
import { relativize } from '../src/render/relativize.ts';

test('makes an absolute path repo-relative', () => {
  assert.equal(relativize('/Users/g/proj/src/a.ts', '/Users/g/proj'), 'src/a.ts');
});

test('resolves macOS /private symlink differences between cwd and tool paths', () => {
  // Tool payloads report /private/tmp/... while git reports /tmp/...
  assert.equal(relativize('/private/tmp/demo/sum.test.js', '/tmp/demo'), 'sum.test.js');
  assert.equal(relativize('/tmp/demo/sum.test.js', '/private/tmp/demo'), 'sum.test.js');
});

test('leaves an already-relative path alone', () => {
  assert.equal(relativize('src/a.ts', '/Users/g/proj'), 'src/a.ts');
});

test('a path outside the repo keeps only its basename, never the full path', () => {
  // Publishing "/Users/gerald/secrets/notes.txt" would leak the home layout.
  assert.equal(relativize('/Users/g/elsewhere/notes.txt', '/Users/g/proj'), 'notes.txt');
});

test('handles a trailing slash on the repo root', () => {
  assert.equal(relativize('/Users/g/proj/src/a.ts', '/Users/g/proj/'), 'src/a.ts');
});
