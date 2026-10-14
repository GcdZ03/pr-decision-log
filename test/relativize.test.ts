import { test } from 'node:test';
import assert from 'node:assert/strict';
import { relativize, scrubPaths } from '../src/render/relativize.ts';

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

// scrubPaths cleans free text (a stated decision, a flag sentence) before it
// is published. These are the forms the 0.1.6 final review found leaking.

test('a file:// URL to a private path keeps only the file name', () => {
  assert.equal(scrubPaths('see file:///Users/me/proj/README.md', '/Users/me/proj'), 'see README.md');
  assert.equal(scrubPaths('see file:///Users/me/notes/plan.md'), 'see plan.md');
  assert.equal(scrubPaths('log at file:///tmp/run/x.log.'), 'log at x.log.');
});

test('a doubled leading slash is still a private path', () => {
  assert.equal(scrubPaths('wrote //tmp/build/out.txt'), 'wrote out.txt');
  assert.equal(scrubPaths('in //Users/me/a.ts'), 'in a.ts');
});

test('mount points, dev containers and system homes are private too', () => {
  const cases: [string, string][] = [
    ['open /Volumes/Work/client/brief.pdf', 'open brief.pdf'],
    ['edit /workspaces/app/src/a.ts', 'edit a.ts'],
    ['key in /root/.ssh/id_ed25519', 'key in id_ed25519'],
    ['data in /mnt/data/export.csv', 'data in export.csv'],
    ['config at /opt/acme/conf.yml', 'config at conf.yml'],
    ['served from /srv/www/index.html', 'served from index.html'],
  ];
  for (const [text, want] of cases) assert.equal(scrubPaths(text), want, text);
});

test('a Windows user path keeps only the file name, in either slash style', () => {
  assert.equal(scrubPaths('see C:\\Users\\dez\\proj\\a.ts'), 'see a.ts');
  assert.equal(scrubPaths('see C:/Users/dez/proj/a.ts'), 'see a.ts');
  assert.equal(scrubPaths('see d:\\Users\\x\\b.txt now'), 'see b.txt now');
});

test('a quoted path with spaces is reduced whole', () => {
  assert.equal(scrubPaths('see "/home/u/my docs/notes.txt" now'), 'see "notes.txt" now');
  assert.equal(scrubPaths('see `/Users/me/My Drive/plan v2.md`'), 'see `plan v2.md`');
  assert.equal(scrubPaths("see '/Volumes/Client X/a b.pdf'"), "see 'a b.pdf'");
});

test('ordinary slashes are left alone', () => {
  for (const text of ['GET /v1/customers returns 200', 'and/or', 'under /repo/tmp/x', 'https://example.com/Users/a', 'src/home/page.tsx', 'a C:/Program Files/x path']) {
    assert.equal(scrubPaths(text), text, text);
  }
});
