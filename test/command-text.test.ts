import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runnerFragment, scriptSkeleton } from '../src/events/command-text.ts';
import { classifyCommand } from '../src/events/classify-command.ts';

// A real PR log published file contents as commands: an agent wrote files with
// `cat > f <<'EOF'`, and lines inside the heredoc that mentioned a runner
// (`import ... from "vitest"`, `RUN npm install ...`) were picked as the row's
// command. These cases mirror those rows with invented contents.

const WRITES_A_TEST = [
  `cat > src/lib/api.test.ts <<'EOF'`,
  `import { describe, expect, it } from "vitest";`,
  `it("works", () => expect(1).toBe(1));`,
  `EOF`,
  `pnpm test 2>&1 | tail -20`,
].join('\n');

test('heredoc bodies are not part of the script', () => {
  const s = scriptSkeleton(WRITES_A_TEST);

  assert.doesNotMatch(s, /vitest|describe|toBe/);
  assert.match(s, /pnpm test/);
});

test('every heredoc form is stripped: quoted, unquoted, <<- and several in one script', () => {
  const s = scriptSkeleton([
    'cat > a <<EOF', 'secret one', 'EOF',
    'cat > b <<-"END"', '\tsecret two', '\tEND',
    "python3 - <<'PY'", 'print("secret three")', 'PY',
    'just test',
  ].join('\n'));

  assert.doesNotMatch(s, /secret/);
  assert.match(s, /just test/);
});

test('multi-line quoted strings are blanked, so a PR body passed to gh is never read as commands', () => {
  const s = scriptSkeleton('gh pr create --title "Web" --body "Adds the app.\n- apps/web/Dockerfile: pnpm install from the lockfile\nAlso: vitest tests"');

  assert.doesNotMatch(s, /Dockerfile|vitest|lockfile/);
  assert.match(s, /gh pr create/);
});

test('a script that writes a test file and runs the suite is a test run, named by its runner', () => {
  assert.equal(classifyCommand(WRITES_A_TEST), 'test');
  assert.equal(runnerFragment(WRITES_A_TEST), 'pnpm test');
});

test('a script that only writes files is not a test run, however its contents read', () => {
  const writesOnly = `cat > Dockerfile <<'EOF'\nRUN npm install --global pnpm@12\nRUN pnpm test\nEOF`;

  assert.equal(classifyCommand(writesOnly), 'other');
  assert.equal(runnerFragment(writesOnly), undefined);
});

test('the fragment is the runner and its plain arguments, nothing else', () => {
  const cases: [string, string][] = [
    ['cd /home/dev/atlas && pnpm run typecheck 2>&1 | tail -20', 'pnpm run typecheck'],
    ['timeout 110 pnpm e2e 2>&1 | tail -12', 'pnpm e2e'],
    ['pnpm --filter @atlas/web build 2>&1 | tail -30', 'pnpm --filter @atlas/web build'],
    ['FORCE_COLOR=0 uv run pytest -q tests/test_api.py', 'uv run pytest -q tests/test_api.py'],
    ['just test 2>&1 | grep -E "passed|failed"', 'just test'],
    ['npx vitest run --reporter=dot', 'npx vitest run --reporter=dot'],
    ['swift test --filter CorePurityTests > /tmp/out.log', 'swift test --filter CorePurityTests'],
    ['pnpm exec prettier --write --log-level warn apps/web', 'pnpm exec prettier --write --log-level warn apps/web'],
  ];
  for (const [command, fragment] of cases) assert.equal(runnerFragment(command), fragment, command);
});

test('the fragment stops before anything that could carry a path, a variable or a secret', () => {
  assert.equal(runnerFragment('pytest /Users/dev/private/tests'), 'pytest');
  assert.equal(runnerFragment('pnpm test -- --token=$NPM_TOKEN'), 'pnpm test --');
  assert.equal(runnerFragment('pnpm test -- "a name with spaces"'), 'pnpm test --');
  assert.equal(runnerFragment('pytest ~/notes'), 'pytest');
});

test('a fragment is capped in length', () => {
  const long = `pytest ${Array.from({ length: 30 }, (_, i) => `tests/test_${i}.py`).join(' ')}`;
  assert.ok((runnerFragment(long) ?? '').length <= 80);
});

test('task runners with test, lint and typecheck targets are classified', () => {
  assert.equal(classifyCommand('just test'), 'test');
  assert.equal(classifyCommand('make test'), 'test');
  assert.equal(classifyCommand('pnpm e2e'), 'test');
  assert.equal(classifyCommand('npx playwright test'), 'test');
  assert.equal(classifyCommand('just lint'), 'lint');
  assert.equal(classifyCommand('just typecheck'), 'build');
  assert.equal(classifyCommand('pnpm run typecheck'), 'build');
  assert.equal(classifyCommand('docker compose build web'), 'build');
});

test('an echo or comment that mentions a runner is still not a run', () => {
  assert.equal(runnerFragment('echo "run pnpm test next"'), undefined);
  assert.equal(runnerFragment('# pnpm test\nls'), undefined);
});

test('a runner named as a file argument is not a run', () => {
  assert.equal(classifyCommand('cat > vitest.config.ts <<EOF\nexport default {}\nEOF'), 'other');
  assert.equal(classifyCommand('cat jest.config.js'), 'other');
  assert.equal(classifyCommand('ls node_modules/.bin/pytest'), 'other');
  assert.equal(runnerFragment('sed -n 1,20p vitest.config.ts'), undefined);
});

test('a runner behind a launcher is a run', () => {
  assert.equal(classifyCommand('npx vitest run'), 'test');
  assert.equal(classifyCommand('uv run pytest -q'), 'test');
  assert.equal(classifyCommand('python3 -m pytest'), 'test');
  assert.equal(classifyCommand('pnpm exec tsc --noEmit'), 'build');
  assert.equal(classifyCommand('bundle exec rspec'), 'test');
  assert.equal(runnerFragment('python3 -m pytest -x'), 'python3 -m pytest -x');
});

test('a subshell group keeps its runner arguments', () => {
  assert.equal(runnerFragment('cd /w && (just lint && just typecheck && just test) 2>&1 | tail -25'), 'just test');
  assert.equal(runnerFragment('(pnpm test)'), 'pnpm test');
});
