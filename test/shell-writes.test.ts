import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shellWrites } from '../src/events/shell-writes.ts';

// 73% of file writes across the stored sessions went through the shell
// (169 against 62 edit-tool edits), and 36 of 51 test-file writes. None were
// visible to the test-edit flag, which only saw the Edit and Write tools.

const CWD = '/w/repo';
const paths = (command: string, cwd = CWD) => shellWrites(command, cwd).map((w) => w.path);

test('a heredoc written to a file is a write, with the content that was written', () => {
  const [w] = shellWrites(`cat > src/a.test.ts <<'EOF'\nexpect(1).toBe(1);\nexpect(2).toBe(2);\nEOF`, CWD);

  assert.equal(w?.path, '/w/repo/src/a.test.ts');
  assert.equal(w?.append, false);
  assert.equal(w?.content, 'expect(1).toBe(1);\nexpect(2).toBe(2);');
});

test('an append is marked as one', () => {
  const [w] = shellWrites(`cat >> test/cli.test.ts <<'EOF'\ntest('x', () => {});\nEOF`, CWD);

  assert.equal(w?.append, true);
});

test('redirects, tee and sed -i are writes', () => {
  assert.deepEqual(paths('echo hi > notes.md'), ['/w/repo/notes.md']);
  assert.deepEqual(paths('printf x >> a/b.txt'), ['/w/repo/a/b.txt']);
  assert.deepEqual(paths('generate | tee out/one.ts out/two.ts'), ['/w/repo/out/one.ts', '/w/repo/out/two.ts']);
  assert.deepEqual(paths("sed -i '' 's/a/b/' src/x.ts src/y.ts"), ['/w/repo/src/x.ts', '/w/repo/src/y.ts']);
  assert.deepEqual(paths("sed -i.bak -e 's/a/b/' src/x.ts"), ['/w/repo/src/x.ts']);
  assert.deepEqual(paths('sed -i "s/a/b/" src/x.ts'), ['/w/repo/src/x.ts']);
});

test('cp and mv write their destination', () => {
  assert.deepEqual(paths('cp fixtures/a.json test/data.json'), ['/w/repo/test/data.json']);
  assert.deepEqual(paths('mv old.ts new.ts'), ['/w/repo/new.ts']);
  assert.deepEqual(paths('cp -r fixtures/ backup/'), [], 'a directory destination names no file');
});

test('a quoted target with shell characters is read whole', () => {
  assert.deepEqual(paths(`mkdir -p "app/(app)/x" && cat > "app/(app)/x/page.tsx" <<'EOF'\nexport {}\nEOF`), ['/w/repo/app/(app)/x/page.tsx']);
});

test('stderr redirects, /dev targets and descriptor duplication are not writes', () => {
  assert.deepEqual(paths('npm test 2>&1 | tail -5'), []);
  assert.deepEqual(paths('npm test > /dev/null 2> err.log'), []);
  assert.deepEqual(paths('make &> build.log'), []);
});

test('reading a file, or a > inside a quoted argument or a heredoc body, is not a write', () => {
  assert.deepEqual(paths('grep -n "a > b" src/x.ts'), []);
  assert.deepEqual(paths(`cat > Dockerfile <<'EOF'\nRUN echo hi > /etc/motd\nEOF`), ['/w/repo/Dockerfile']);
  assert.deepEqual(paths('sort < in.txt'), []);
});

test('a target held in a variable or command substitution is not guessed', () => {
  assert.deepEqual(paths('cat > "$OUT" <<EOF\nx\nEOF'), []);
  assert.deepEqual(paths('echo x > $(mktemp)'), []);
});

test('a cd earlier in the script moves where later writes land', () => {
  assert.deepEqual(paths('cd ../other && cat > a.ts <<EOF\nx\nEOF'), ['/w/other/a.ts']);
  assert.deepEqual(paths('cd /abs/dir\necho x > b.ts'), ['/abs/dir/b.ts']);
});

test('without a known directory, relative targets stay relative', () => {
  assert.deepEqual(shellWrites('echo x > src/a.ts', undefined).map((w) => w.path), ['src/a.ts']);
});

test('a Python script in a heredoc writes the files it opens for writing', () => {
  const script = [
    "python3 - <<'EOF'",
    "p='src/render/build-log.ts'; s=open(p).read()",
    "s=s.replace('a','b')",
    "open(p,'w').write(s)",
    "open('test/x.test.ts', 'a').write('more')",
    "Path('docs/notes.md').write_text('x')",
    "data = open('config.json').read()",
    'EOF',
  ].join('\n');

  assert.deepEqual(paths(script), ['/w/repo/src/render/build-log.ts', '/w/repo/test/x.test.ts', '/w/repo/docs/notes.md']);
  assert.equal(shellWrites(script, CWD)[0]?.content, undefined, 'what a script wrote is not known');
});

test('a Node script in a heredoc writes the files it writes', () => {
  const script = "node <<'EOF'\nconst fs = require('fs');\nfs.writeFileSync('src/gen.ts', out);\nconst p = 'a/b.json';\nfs.writeFileSync(p, '{}');\nEOF";

  assert.deepEqual(paths(script), ['/w/repo/src/gen.ts', '/w/repo/a/b.json']);
});

test('the same file written twice in one command is one write', () => {
  assert.deepEqual(paths("sed -i '' 's/a/b/' x.ts && sed -i '' 's/c/d/' x.ts"), ['/w/repo/x.ts']);
});

test('a variable reassigned between writes names each file in turn', () => {
  // A real script from the stored sessions: one variable, two files.
  const script = [
    "python3 - <<'EOF'",
    "p='src/testing.py'; s=open(p).read()",
    "open(p,'w').write(s)",
    "p='tests/test_salesforce.py'; s=open(p).read()",
    "open(p,'w').write(s)",
    'EOF',
  ].join('\n');

  assert.deepEqual(paths(script), ['/w/repo/src/testing.py', '/w/repo/tests/test_salesforce.py']);
});
