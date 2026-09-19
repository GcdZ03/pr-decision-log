import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyCommand } from '../src/events/classify-command.ts';

test('classifies common test runners', () => {
  for (const cmd of [
    'npm test', 'npm run test:unit', 'pnpm test -- --coverage', 'yarn test',
    'npx vitest run', 'jest src/', 'pytest -q', 'go test ./...',
    'swift test --filter CoreTests', 'cargo test', 'node --test', 'bundle exec rspec',
  ]) {
    assert.equal(classifyCommand(cmd), 'test', `expected test for: ${cmd}`);
  }
});

test('classifies builds', () => {
  for (const cmd of ['npm run build', 'tsc --noEmit', 'cargo build --release', 'go build ./...', 'swift build', 'make']) {
    assert.equal(classifyCommand(cmd), 'build', `expected build for: ${cmd}`);
  }
});

test('classifies linters and formatters', () => {
  for (const cmd of ['npm run lint', 'eslint .', 'ruff check', 'prettier --write .', 'swiftlint', 'cargo clippy']) {
    assert.equal(classifyCommand(cmd), 'lint', `expected lint for: ${cmd}`);
  }
});

test('classifies git operations', () => {
  for (const cmd of ['git status', 'git commit -m "x"', 'gh pr create --title y']) {
    assert.equal(classifyCommand(cmd), 'git', `expected git for: ${cmd}`);
  }
});

test('falls back to other', () => {
  for (const cmd of ['ls -la', 'cat README.md', 'curl https://example.com']) {
    assert.equal(classifyCommand(cmd), 'other', `expected other for: ${cmd}`);
  }
});

test('a test run wins over a cd prefix and redirection', () => {
  assert.equal(classifyCommand('cd /tmp/project && swift test --filter Foo 2>&1'), 'test');
});

test('test classification beats build when both appear', () => {
  // `npm run build && npm test` verifies; the test result is what a reviewer cares about.
  assert.equal(classifyCommand('npm run build && npm test'), 'test');
});

test('an echo mentioning a runner is not a test run', () => {
  assert.equal(classifyCommand('echo "now running npm test"'), 'other');
});
