import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pairTests } from '../src/review/coverage.ts';
import type { ChangedFile } from '../src/flags/diff-signals.ts';

const f = (path: string, status: ChangedFile['status'] = 'modified'): ChangedFile => ({ path, status, added: 1, removed: 0, binary: false });

// A reviewer reads code with its test, and wants to know which changed code
// no test change accompanies: that is where a bug is likeliest to hide.

test('source files are paired with the changed tests that name them', () => {
  const c = pairTests([
    f('services/api/src/imports/validate.py'), f('services/api/tests/test_import_validate.py'),
    f('services/api/src/routers/import_review.py'), f('services/api/tests/test_api_import_review.py'),
    f('apps/web/src/lib/review.ts'), f('apps/web/src/lib/review.test.ts'),
    f('pkg/rank.go'), f('pkg/rank_test.go'),
    f('Sources/Core/Ranker.swift'), f('Tests/CoreTests/RankerTests.swift'),
  ]);

  assert.deepEqual(c.pairs, [
    { source: 'services/api/src/imports/validate.py', tests: ['services/api/tests/test_import_validate.py'] },
    { source: 'services/api/src/routers/import_review.py', tests: ['services/api/tests/test_api_import_review.py'] },
    { source: 'apps/web/src/lib/review.ts', tests: ['apps/web/src/lib/review.test.ts'] },
    { source: 'pkg/rank.go', tests: ['pkg/rank_test.go'] },
    { source: 'Sources/Core/Ranker.swift', tests: ['Tests/CoreTests/RankerTests.swift'] },
  ]);
  assert.deepEqual(c.untested, []);
});

test('changed code no test change matches is listed as such', () => {
  const c = pairTests([f('src/auth.py'), f('src/parse.py'), f('tests/test_parse.py')]);

  assert.deepEqual(c.untested, ['src/auth.py']);
});

test('only code counts: docs, config, lockfiles, generated types, package inits and deleted files are not untested code', () => {
  const c = pairTests([
    f('README.md'), f('docs/adr/0005.md'), f('package.json'), f('uv.lock'), f('packages/types/src/schema.d.ts'),
    f('src/conduit_api/__init__.py'), f('src/old.py', 'deleted'), f('.github/workflows/ci.yml'),
  ]);

  assert.deepEqual(c, { pairs: [], untested: [] });
});

test('a name must match at a word boundary, so review does not pair with preview', () => {
  const c = pairTests([f('src/review.py'), f('tests/test_preview.py')]);

  assert.deepEqual(c.pairs, []);
  assert.deepEqual(c.untested, ['src/review.py']);
});
