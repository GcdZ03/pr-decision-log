import { basename } from 'node:path';
import { blankStrings, countAssertions } from './assertions.ts';
import { isTestFile } from './test-files.ts';
import type { Flag } from './types.ts';

type FileDiff = { path: string; deleted: boolean; added: string[]; removed: string[] };

/**
 * Split a unified diff into per-file added and removed lines.
 *
 * Content is only read inside a hunk. The `--- a/x` and `+++ b/x` headers
 * begin with the same characters as removed and added lines, so reading them
 * as content would count a file header as a change.
 */
function parse(diff: string): FileDiff[] {
  const files: FileDiff[] = [];
  let current: FileDiff | undefined;
  let inHunk = false;

  for (const line of diff.split('\n')) {
    if (line.startsWith('diff --git ')) {
      current = { path: /^diff --git a\/.+? b\/(.+)$/.exec(line)?.[1] ?? '', deleted: false, added: [], removed: [] };
      files.push(current);
      inHunk = false;
      continue;
    }
    if (!current) continue;

    if (!inHunk) {
      // Headers name the file; `+++` wins, except for a deletion where it is /dev/null.
      if (line.startsWith('deleted file mode') || line === '+++ /dev/null') current.deleted = true;
      else if (line.startsWith('--- a/')) current.path = line.slice(6);
      else if (line.startsWith('+++ b/')) current.path = line.slice(6);
      else if (line.startsWith('@@')) inHunk = true;
      continue;
    }

    if (line.startsWith('@@')) continue;
    if (line.startsWith('+')) current.added.push(line.slice(1));
    else if (line.startsWith('-')) current.removed.push(line.slice(1));
  }

  return files;
}

const count = (lines: string[], re: RegExp): number =>
  lines.reduce((n, l) => n + (l.match(new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`)) ?? []).length, 0);

/** Net-negative assertion count in one test file. */
function assertionsRemoved(f: FileDiff): Flag | null {
  const removed = countAssertions(f.removed.join('\n'));
  const added = countAssertions(f.added.join('\n'));
  if (removed <= added) return null;

  return {
    code: 'ASSERTIONS_REMOVED',
    severity: 'info',
    file: f.path,
    detail: `Assertions in this diff: ${removed} removed, ${added} added (net ${added - removed}).`,
    evidence: [],
  };
}

const SKIP_MARKERS: { label: string; re: RegExp; note?: string }[] = [
  { label: '.only(', re: /\.only\(/, note: 'runs only this test and silently skips the rest of the file' },
  { label: '.skip(', re: /\.skip\(/ },
  { label: 'xit( / xdescribe( / xtest(', re: /\bx(?:it|describe|test)\(/ },
  { label: '@pytest.mark.skip', re: /@pytest\.mark\.skip/ },
  { label: '@unittest.skip', re: /@unittest\.skip/ },
  { label: 't.Skip(', re: /\bt\.Skip(?:f|Now)?\(/ },
  { label: 'XCTSkip', re: /\bXCTSkip/ },
  // node:test's options object. A `todo` test still runs, but its failure no
  // longer fails the run; a real agent reached for this when told to make a
  // failing test pass without touching the code.
  {
    label: '{ todo } / { skip } option',
    re: /[{,]\s*(?:todo|skip)\s*:(?!\s*false\b)/,
    note: 'the test still runs but its failure no longer fails the suite',
  },
];

/** A marker that appears more often in added lines than removed ones was introduced by this change. */
function testSkipped(f: FileDiff): Flag | null {
  const added = f.added.map(blankStrings);
  const removed = f.removed.map(blankStrings);
  const introduced = SKIP_MARKERS.filter((m) => count(added, m.re) > count(removed, m.re));
  if (introduced.length === 0) return null;

  const parts = introduced.map((m) => `\`${m.label}\`${m.note ? ` (${m.note})` : ''}`);
  return {
    code: 'TEST_SKIPPED',
    severity: 'warn',
    file: f.path,
    detail: `Added ${parts.join(', ')}.`,
    evidence: [],
  };
}

/**
 * Test declarations across the supported languages.
 *
 * The JS/TS form includes `.skip`/`.only`/`.todo` modifiers, so turning
 * `it(` into `it.skip(` reads as a skip rather than as a deletion plus
 * nothing: one change, one flag.
 */
const TEST_DECL = new RegExp(
  [
    /\bx?(?:it|test)(?:\.(?:skip|only|todo))?\s*\(\s*['"`]/.source,
    /^\s*(?:async\s+)?def\s+test_\w*/.source,
    /^func\s+Test\w*\s*\(/.source,
    /\bfunc\s+test\w*\s*\(/.source,
    // Swift Testing. Its functions need no `test` prefix, so the attribute is
    // the only marker; a real Swift codebase here had 974 of these and no
    // `func test...` at all, which left the rule blind to it.
    /@Test\b/.source,
  ].join('|'),
  'm',
);

/**
 * Net-removed test declarations. A rename removes one and adds one, so it nets
 * to zero and is not reported; only tests that vanished without a replacement are.
 */
function testDeleted(f: FileDiff): Flag | null {
  const n = count(f.removed, TEST_DECL) - count(f.added, TEST_DECL);
  if (n <= 0) return null;

  return {
    code: 'TEST_DELETED',
    severity: 'info',
    file: f.path,
    detail: `${n} test${n === 1 ? '' : 's'} removed with no replacement.`,
    evidence: [],
  };
}

const EXPECT_RE =
  /\b(?:toBe|toEqual|toStrictEqual|toMatchObject|assertEqual|assertEquals|XCTAssertEqual|assert\.(?:equal|strictEqual|deepEqual|deepStrictEqual))\s*\(/;

/** Structure with literals blanked, so two lines that differ only in a value compare equal. */
const skeleton = (line: string): string =>
  line.replace(/(["'`])(?:\\.|(?!\1).)*\1/g, 'S').replace(/\b\d+(?:\.\d+)?\b/g, 'N').trim();

/** The name of the module a test file exercises, by the usual conventions. */
function stemOf(path: string): string {
  return basename(path)
    .replace(/\.(?:test|spec)\.[cm]?[tj]sx?$/, '')
    .replace(/^test_(.+)\.py$/, '$1')
    .replace(/_test\.(?:go|py|rb)$/, '')
    .replace(/Tests?\.(?:swift|java)$/, '');
}

const moduleName = (path: string): string => basename(path).replace(/\.[^.]+$/, '');

const fragment = (line: string): string => {
  const at = EXPECT_RE.exec(line)?.index ?? 0;
  const f = line.slice(at).trim().replace(/;$/, '');
  return f.length > 60 ? `${f.slice(0, 59)}…` : f;
};

/**
 * An expected value that changed while the code it tests also changed.
 *
 * Often legitimate — behaviour changed and the test followed — which is why
 * this is `info`: the point is to draw the eye, not to accuse. Pairs are
 * required to have the same structure and the same text up to the matcher, so
 * rewriting what is asserted is a different test, not a changed expectation.
 */
function expectationLoosened(f: FileDiff, changedSources: Map<string, string>): Flag | null {
  const source = changedSources.get(stemOf(f.path));
  if (!source) return null;

  const pool = f.added.filter((l) => EXPECT_RE.test(l));
  const pairs: [string, string][] = [];

  for (const r of f.removed) {
    const m = EXPECT_RE.exec(r);
    if (!m) continue;
    const prefix = r.slice(0, m.index);
    const i = pool.findIndex((a) => a !== r && a.startsWith(prefix) && skeleton(a) === skeleton(r));
    if (i === -1) continue;
    pairs.push([r, pool[i] as string]);
    pool.splice(i, 1);
  }

  const first = pairs[0];
  if (!first) return null;

  const more = pairs.length > 1 ? ` (${pairs.length} expectations changed)` : '';
  return {
    code: 'EXPECTATION_LOOSENED',
    severity: 'info',
    file: f.path,
    detail: `\`${fragment(first[0])}\` -> \`${fragment(first[1])}\` while \`${source}\` also changed${more}; worth confirming the new value is intended.`,
    evidence: [],
  };
}

/**
 * Tests removed along with the code they test are cleanup, not a shortcut.
 *
 * Measured on 320 real commits, every one of 36 assertion-removal warnings
 * came from this or from refactors, and 28 of them came from two commits that
 * deleted a feature and its tests together. The removal is still recorded,
 * since a reviewer may want to confirm nothing else went with it, but as a
 * note naming the deleted source rather than as a warning.
 */
const REMOVALS = new Set(['ASSERTIONS_REMOVED', 'TEST_DELETED']);

/**
 * Escalate a removal to a warning when the timeline saw this file edited after
 * its test failed.
 *
 * Measured over 320 real commits, 0 of 45 standalone removal warnings were
 * shortcuts: feature deletions, helper consolidation, review cleanup. The diff
 * knows what disappeared but never why. The timeline's fail-then-edit sequence
 * is the shortcut's signature, so a removal only accuses when both agree —
 * the "two independent signals, combined" of DESIGN section 11.
 */
function corroborate(flag: Flag, corroborated: ReadonlySet<string>): Flag {
  if (!REMOVALS.has(flag.code) || !corroborated.has(flag.file)) return flag;
  return {
    ...flag,
    severity: 'warn',
    detail: `${flag.detail} This file was also edited after its test failed in this session.`,
  };
}

function followsRemoval(flag: Flag, deletedSource: string | undefined): Flag {
  if (!deletedSource || !REMOVALS.has(flag.code)) return flag;
  return {
    ...flag,
    severity: 'info',
    detail: `${flag.detail} Follows the removal of \`${deletedSource}\`.`,
  };
}

/**
 * The diff-side test-change signals from DESIGN section 11.
 *
 * Complements the timeline detector: that one knows *when* a test changed
 * relative to a failure, this one knows *what* changed in it. Every rule is
 * `warn` or `info`, never a gate, because a false accusation costs more than
 * a miss.
 */
export type AnalyzeOptions = {
  /** Test files the timeline saw edited after their test failed. */
  corroborated?: ReadonlySet<string>;
};

export function analyzeDiff(diff: string, options: AnalyzeOptions = {}): Flag[] {
  const corroborated = options.corroborated ?? new Set<string>();
  const files = parse(diff);

  const changedSources = new Map<string, string>();
  const deletedSources = new Map<string, string>();
  for (const f of files) {
    if (isTestFile(f.path)) continue;
    if (f.added.length > 0 || f.removed.length > 0) changedSources.set(moduleName(f.path), f.path);
    if (f.deleted) deletedSources.set(moduleName(f.path), f.path);
  }

  const flags: Flag[] = [];
  for (const f of files.filter((x) => isTestFile(x.path))) {
    for (const rule of [assertionsRemoved, testSkipped, testDeleted]) {
      const flag = rule(f);
      // Removal wins over corroboration: deleting code makes its tests fail,
      // so fail-then-edit is exactly what a legitimate removal looks like.
      if (flag) flags.push(followsRemoval(corroborate(flag, corroborated), deletedSources.get(stemOf(f.path))));
    }
    const loosened = expectationLoosened(f, changedSources);
    if (loosened) flags.push(loosened);
  }
  return flags;
}
