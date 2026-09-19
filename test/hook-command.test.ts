import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hookCommand } from '../src/doctor/settings.ts';

const REPO = '/Users/someone/Documents/Github/pr-decision-log';

test('an entry inside the repo is written relative to CLAUDE_PROJECT_DIR', () => {
  const command = hookCommand(`${REPO}/src/pdl.ts`, 'project', REPO);

  assert.equal(command, 'node "$CLAUDE_PROJECT_DIR/src/pdl.ts" hook');
});

test('a project hook command never embeds a home directory path', () => {
  const command = hookCommand(`${REPO}/dist/pdl.js`, 'project', REPO);

  assert.ok(!command.includes('/Users/someone'), `leaked an absolute path: ${command}`);
});

test('an entry outside the repo keeps its absolute path, because the variable would not resolve', () => {
  const command = hookCommand('/usr/local/lib/node_modules/pdl/dist/pdl.js', 'project', REPO);

  assert.equal(command, 'node "/usr/local/lib/node_modules/pdl/dist/pdl.js" hook');
});

test('user scope keeps the absolute path, because there is no project to be relative to', () => {
  const command = hookCommand(`${REPO}/src/pdl.ts`, 'user', REPO);

  assert.equal(command, `node "${REPO}/src/pdl.ts" hook`);
});

test('a sibling directory sharing the repo name prefix is not treated as inside the repo', () => {
  const command = hookCommand(`${REPO}-fork/src/pdl.ts`, 'project', REPO);

  assert.equal(command, `node "${REPO}-fork/src/pdl.ts" hook`);
});
