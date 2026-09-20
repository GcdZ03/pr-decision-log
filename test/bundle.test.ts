import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..');

test('the bundled binary runs', () => {
  const built = spawnSync('node', ['scripts/build.mjs'], { cwd: repo, encoding: 'utf8' });
  assert.equal(built.status, 0, `build failed: ${built.stderr}`);

  const run = spawnSync('node', ['dist/pdl.js'], { cwd: repo, encoding: 'utf8' });

  assert.ok(!/SyntaxError/.test(run.stderr), `bundle is not valid JavaScript:\n${run.stderr}`);
  assert.match(run.stderr, /usage: pdl/, `expected usage output, got: ${run.stderr}`);
});

test('the bundle carries exactly one shebang, on the first line', () => {
  spawnSync('node', ['scripts/build.mjs'], { cwd: repo, encoding: 'utf8' });
  const lines = readFileSync(join(repo, 'dist/pdl.js'), 'utf8').split('\n');

  assert.match(lines[0] ?? '', /^#!/);
  assert.equal(lines.filter((l) => l.startsWith('#!')).length, 1);
});
