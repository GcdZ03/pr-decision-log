import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { trustState } from '../src/doctor/settings.ts';

function withState(content: string | null, fn: (path: string) => void) {
  const dir = mkdtempSync(join(tmpdir(), 'pdl-trust-'));
  const path = join(dir, '.claude.json');
  if (content !== null) writeFileSync(path, content);
  try { fn(path); } finally { rmSync(dir, { recursive: true, force: true }); }
}

const state = (projects: Record<string, unknown>) => JSON.stringify({ projects });

test('an accepted folder reads as accepted', () => {
  withState(state({ '/r': { hasTrustDialogAccepted: true } }), (p) => {
    assert.equal(trustState('/r', p), 'accepted');
  });
});

test('a folder recorded as not accepted reads as not-accepted', () => {
  withState(state({ '/r': { hasTrustDialogAccepted: false } }), (p) => {
    assert.equal(trustState('/r', p), 'not-accepted');
  });
});

test('a folder with no entry reads as unknown-folder', () => {
  withState(state({ '/other': { hasTrustDialogAccepted: true } }), (p) => {
    assert.equal(trustState('/r', p), 'unknown-folder');
  });
});

test('a trusted parent is not treated as trusting the child, because that is unverified', () => {
  withState(state({ '/home': { hasTrustDialogAccepted: true } }), (p) => {
    assert.equal(trustState('/home/repo', p), 'unknown-folder');
  });
});

test('a missing state file reads as unreadable', () => {
  withState(null, (p) => {
    assert.equal(trustState('/r', p), 'unreadable');
  });
});

test('a malformed state file reads as unreadable', () => {
  withState('{ nope', (p) => {
    assert.equal(trustState('/r', p), 'unreadable');
  });
});
