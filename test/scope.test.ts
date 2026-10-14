import { test } from 'node:test';
import assert from 'node:assert/strict';
import { areaOf, summariseScope } from '../src/review/scope.ts';
import type { ChangedFile } from '../src/flags/diff-signals.ts';

const f = (path: string, added: number, removed = 0, status: ChangedFile['status'] = 'modified', binary = false): ChangedFile =>
  ({ path, status, added, removed, binary });

test('areas use the first segment, or two under a monorepo container', () => {
  assert.equal(areaOf('services/api/src/main.py'), 'services/api');
  assert.equal(areaOf('apps/web/page.tsx'), 'apps/web');
  assert.equal(areaOf('src/a.ts'), 'src');
  assert.equal(areaOf('services/README.md'), 'services');
  assert.equal(areaOf('README.md'), '(root)');
});

test('scope counts lines and files by status, tests, and ranks areas by lines changed', () => {
  const s = summariseScope([
    f('services/api/src/parsing.py', 400, 10, 'added'),
    f('services/api/tests/test_parsing.py', 270, 0, 'added'),
    f('apps/web/src/lib/imports.ts', 250, 10),
    f('uv.lock', 900, 300),
    f('old.md', 0, 5, 'deleted'),
    f('logo.png', 0, 0, 'added', true),
  ]);

  assert.deepEqual(
    [s.added, s.removed, s.files, s.created, s.deleted, s.renamed, s.testsChanged, s.testsAdded],
    [1820, 325, 6, 3, 1, 0, 1, 1],
  );
  assert.deepEqual(s.areas, ['(root)', 'services/api', 'apps/web']);
  assert.equal(s.moreAreas, 0);
});

test('largest skips lockfiles, binaries and generated paths', () => {
  const s = summariseScope([f('uv.lock', 5000), f('dist/app.js', 4000), f('a.min.js', 3000), f('logo.png', 0, 0, 'added', true),
    f('src/big.ts', 300, 20), f('src/mid.ts', 100), f('src/small.ts', 5)]);

  assert.deepEqual(s.largest, [{ path: 'src/big.ts', lines: 320 }, { path: 'src/mid.ts', lines: 100 }]);
});

test('at most six areas are named, with a count of the rest', () => {
  const s = summariseScope(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'].map((x, i) => f(`${x}/file.ts`, 100 - i)));

  assert.deepEqual(s.areas, ['a', 'b', 'c', 'd', 'e', 'f']);
  assert.equal(s.moreAreas, 2);
});
