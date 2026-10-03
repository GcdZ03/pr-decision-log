import { test } from 'node:test';
import assert from 'node:assert/strict';
import { commandDir } from '../src/events/location.ts';

const CWD = '/home/dev/notch';

// Seen in a real session started in one repository that opened six pull
// requests in another, every command prefixed with a `cd`. The hook process
// runs in the session's folder, so without this every one of those commands
// was attributed to the wrong repository.

test('a command with no cd runs where the session is', () => {
  assert.equal(commandDir('npm test', CWD), CWD);
});

test('a leading cd moves the command to that directory', () => {
  assert.equal(commandDir('cd /home/dev/atlas && gh pr create --fill', CWD), '/home/dev/atlas');
});

test('a relative cd resolves against the session directory', () => {
  assert.equal(commandDir('cd ../atlas-wt-01 && just test', CWD), '/home/dev/atlas-wt-01');
});

test('successive cds compose', () => {
  assert.equal(commandDir('cd /home/dev/atlas && cd services/api && pytest', CWD), '/home/dev/atlas/services/api');
});

test('exports and assignments before the cd are skipped', () => {
  assert.equal(commandDir('export PATH=/usr/local/bin:$PATH; cd /home/dev/atlas-wt-03 && gh pr view 20', CWD), '/home/dev/atlas-wt-03');
  assert.equal(commandDir('FOO=1 cd /home/dev/atlas && ls', CWD), '/home/dev/atlas');
});

test('a cd after the first real command does not move what came before it', () => {
  assert.equal(commandDir('npm test && cd /tmp', CWD), CWD);
});

test('quoted and tilde paths are understood', () => {
  assert.equal(commandDir('cd "/home/dev/my repo" && ls', CWD, '/home/dev'), '/home/dev/my repo');
  assert.equal(commandDir("cd '/home/dev/atlas' && ls", CWD, '/home/dev'), '/home/dev/atlas');
  assert.equal(commandDir('cd ~/atlas && ls', CWD, '/home/dev'), '/home/dev/atlas');
  assert.equal(commandDir('cd $HOME/atlas && ls', CWD, '/home/dev'), '/home/dev/atlas');
});

test('git -C names the directory a git command runs in', () => {
  assert.equal(commandDir('git -C /home/dev/atlas status', CWD), '/home/dev/atlas');
});

test('a subshell cd and pushd count', () => {
  assert.equal(commandDir('(cd /home/dev/atlas && make)', CWD), '/home/dev/atlas');
  assert.equal(commandDir('pushd /home/dev/atlas && make', CWD), '/home/dev/atlas');
});

test('a cd whose target cannot be read statically leaves the session directory', () => {
  assert.equal(commandDir('cd "$(git rev-parse --show-toplevel)" && ls', CWD), CWD);
  assert.equal(commandDir('cd $WORKTREE && ls', CWD), CWD);
  assert.equal(commandDir('cd - && ls', CWD), CWD);
});

test('a multi-line script uses its first line', () => {
  assert.equal(commandDir('cd /home/dev/atlas\nnpm test\ncd /elsewhere', CWD), '/home/dev/atlas');
});
