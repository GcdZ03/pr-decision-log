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

// Agents edit with scripts of `s = s.replace(old, new)`. Their old and new
// texts are literals in the command, so the assertions they remove or add can
// be counted the way an Edit tool edit's old_string/new_string are. A real PR
// deleted an assertion this way and the log could only say "written from the
// shell".

const replaced = (command: string) => shellWrites(command, CWD).map((w) => [w.path, w.replaced]);

test('a scripted replace records the old and new text for the file it writes', () => {
  const script = [
    "python3 - <<'EOF'",
    "p='tests/test_rank.py'",
    's=open(p).read()',
    "old='''    assert ranked == [0.01, 0.99]",
    '    # wrong direction: the fit is weak',
    "    assert ranked[1] < CONFIDENT",
    "'''",
    "new='''    assert ranked == [0.01, 0.99]",
    "'''",
    's=s.replace(old,new)',
    "open(p,'w').write(s)",
    'EOF',
  ].join('\n');

  const [w] = shellWrites(script, CWD);
  assert.equal(w?.path, '/w/repo/tests/test_rank.py');
  assert.match(w?.replaced?.old ?? '', /assert ranked\[1\] < CONFIDENT/);
  assert.doesNotMatch(w?.replaced?.new ?? '', /CONFIDENT/);
});

test('inline literals, several replaces and double-quoted triple strings all count', () => {
  const script = [
    "python3 - <<'EOF'",
    "p='tests/test_a.py'; s=open(p).read()",
    "s=s.replace('assert a == 1', 'assert a == 2')",
    's=s.replace("""assert b""", """assert b\nassert c""")',
    "open(p,'w').write(s)",
    'EOF',
  ].join('\n');

  const [w] = shellWrites(script, CWD);
  assert.equal(w?.replaced?.old, 'assert a == 1\nassert b');
  assert.equal(w?.replaced?.new, 'assert a == 2\nassert b\nassert c');
});

test('each file in a script gets only the replaces made before its own write', () => {
  const script = [
    "python3 - <<'EOF'",
    "p='src/a.py'; s=open(p).read(); s=s.replace('x', 'y'); open(p,'w').write(s)",
    "p='tests/test_b.py'; s=open(p).read(); s=s.replace('assert q', ''); open(p,'w').write(s)",
    'EOF',
  ].join('\n');

  assert.deepEqual(replaced(script), [
    ['/w/repo/src/a.py', { old: 'x', new: 'y' }],
    ['/w/repo/tests/test_b.py', { old: 'assert q', new: '' }],
  ]);
});

test('a script that changes the text in ways that cannot be read records no texts, rather than half', () => {
  for (const middle of [
    "s=re.sub(r'assert .*', '', s)",
    "s=s.replace(old_value, 'y')",
    's += extra_text',
    "s=sub(s, 'a', 'b')",
  ]) {
    const script = ["python3 - <<'EOF'", "p='tests/test_c.py'; s=open(p).read()", "s=s.replace('assert a', 'assert b')", middle, "open(p,'w').write(s)", 'EOF'].join('\n');
    assert.equal(shellWrites(script, CWD)[0]?.replaced, undefined, middle);
  }
});

test('a Node script replace with template literals counts too', () => {
  const script = "node <<'EOF'\nconst fs = require('fs'); let s = fs.readFileSync('t.test.ts', 'utf8');\ns = s.replace(`expect(a).toBe(1);`, ``);\nfs.writeFileSync('t.test.ts', s);\nEOF";

  assert.deepEqual(shellWrites(script, CWD)[0]?.replaced, { old: 'expect(a).toBe(1);', new: '' });
});

test('a write with no replace before it records no texts', () => {
  assert.equal(shellWrites("python3 - <<'EOF'\nopen('a.py','w').write(data)\nEOF", CWD)[0]?.replaced, undefined);
});

// The most common reason scripted edits had no counts: replacement pairs in a
// list, applied in a loop. Their texts are literals too.
test('replacement pairs in a list applied in a loop are read', () => {
  const script = [
    "python3 - <<'EOF'",
    "f='tests/test_a.py'",
    's=open(f).read()',
    'reps=[',
    '("""    assert a == 1""", """    assert a == 2"""),',
    "('assert b', ''),",
    ']',
    'for a,b in reps:',
    '    assert a in s, a',
    '    s=s.replace(a,b)',
    "open(f,'w').write(s)",
    'EOF',
  ].join('\n');

  assert.deepEqual(shellWrites(script, CWD)[0]?.replaced, { old: '    assert a == 1\nassert b', new: '    assert a == 2\n' });
});

test('an inline list in the loop is read too, and a pair that is not two literals leaves it unknown', () => {
  const inline = "python3 - <<'EOF'\np='t.py'; s=open(p).read()\nfor old, new in [('x', 'y'), (\"z\", \"w\")]:\n    s = s.replace(old, new)\nopen(p,'w').write(s)\nEOF";
  assert.deepEqual(shellWrites(inline, CWD)[0]?.replaced, { old: 'x\nz', new: 'y\nw' });

  const computed = "python3 - <<'EOF'\np='t.py'; s=open(p).read()\nfor a, b in [('x', make())]:\n    s = s.replace(a, b)\nopen(p,'w').write(s)\nEOF";
  assert.equal(shellWrites(computed, CWD)[0]?.replaced, undefined);
});

test('appending a literal with += is an addition, and appending anything else is unknown', () => {
  const appended = "python3 - <<'EOF'\np='tests/test_a.py'; s=open(p).read()\ns += '''\ndef test_new():\n    assert x\n'''\nopen(p,'w').write(s)\nEOF";
  assert.deepEqual(shellWrites(appended, CWD)[0]?.replaced, { old: '', new: '\ndef test_new():\n    assert x\n' });

  const computed = "python3 - <<'EOF'\np='t.py'; s=open(p).read()\ns += extra\nopen(p,'w').write(s)\nEOF";
  assert.equal(shellWrites(computed, CWD)[0]?.replaced, undefined);
});

test('text being inserted may contain f-strings, .format or sub( without making the edit unknown', () => {
  const script = [
    "python3 - <<'EOF'",
    "p='tests/conftest.py'; s=open(p).read()",
    "s=s.replace('''        message = \"unreachable\"''', '''        message = f\"Postgres is not reachable at {where}\"\n        out = sub(x)\n        y = \"{}\".format(z)''')",
    "open(p,'w').write(s)",
    'EOF',
  ].join('\n');

  assert.match(shellWrites(script, CWD)[0]?.replaced?.new ?? '', /Postgres is not reachable/);
});

test('an f-string or regex replace in the script itself still leaves the edit unknown', () => {
  for (const middle of ["s = s.replace(f'{a}', 'b')", "s = re.sub(r'x', 'y', s)"]) {
    const script = ["python3 - <<'EOF'", "p='t.py'; s=open(p).read()", middle, "open(p,'w').write(s)", 'EOF'].join('\n');
    assert.equal(shellWrites(script, CWD)[0]?.replaced, undefined, middle);
  }
});
