import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findTranscript } from '../src/extract/find-transcript.ts';

function withProjects(layout: Record<string, string[]>, fn: (root: string) => void) {
  const root = mkdtempSync(join(tmpdir(), 'pdl-proj-'));
  for (const [dir, files] of Object.entries(layout)) {
    mkdirSync(join(root, dir), { recursive: true });
    for (const f of files) writeFileSync(join(root, dir, f), '{}\n');
  }
  try { fn(root); } finally { rmSync(root, { recursive: true, force: true }); }
}

test('a transcript is found by session id regardless of which project holds it', () => {
  withProjects({ '-a-b': ['other.jsonl'], '-c-d': ['sess-1.jsonl'] }, (root) => {
    assert.equal(findTranscript('sess-1', root), join(root, '-c-d', 'sess-1.jsonl'));
  });
});

test('an unknown session returns undefined rather than throwing', () => {
  withProjects({ '-a-b': ['other.jsonl'] }, (root) => {
    assert.equal(findTranscript('sess-1', root), undefined);
  });
});

test('a missing projects directory returns undefined', () => {
  assert.equal(findTranscript('sess-1', '/nonexistent/projects'), undefined);
});

test('a session id that is a path traversal finds nothing', () => {
  withProjects({ '-a-b': ['other.jsonl'] }, (root) => {
    assert.equal(findTranscript('../../etc/passwd', root), undefined);
  });
});
