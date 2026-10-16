import { basename } from 'node:path';
import type { ChangedFile } from '../flags/diff-signals.ts';
import { stemOf } from '../flags/diff-signals.ts';
import { isTestFile } from '../flags/test-files.ts';

export type Coverage = {
  /** Changed source files with the changed tests whose names point at them. */
  pairs: { source: string; tests: string[] }[];
  /** Changed source files no changed test points at. */
  untested: string[];
};

const CODE = /\.(?:[cm]?[tj]sx?|py|go|rs|swift|java|kt|rb|php|cs|c|cc|cpp|h|hpp|m|scala|vue|svelte)$/;
/** Code that is rarely tested on its own: package inits and generated type declarations. */
const NOT_UNIT = /(?:^|\/)__init__\.py$|\.d\.ts$/;

/** Changed code a test could cover: code, not a test, not a package init or generated types. */
export const isSourceCode = (path: string): boolean => !isTestFile(path) && CODE.test(path) && !NOT_UNIT.test(path);

const sourceStem = (path: string): string => basename(path).replace(/\.[^.]+$/, '');

/** A language, so a Python test never pairs with a TypeScript module of the same name. */
function language(path: string): string {
  const ext = /\.([^.]+)$/.exec(path)?.[1] ?? '';
  if (/^[cm]?[tj]sx?$|^vue$|^svelte$/.test(ext)) return 'js';
  if (/^(?:c|cc|cpp|h|hpp|m)$/.test(ext)) return 'c';
  return ext;
}

/**
 * Whether a test's name points at a source file: `test_import_validate.py`
 * at `validate.py`, `review.test.ts` at `review.ts`, `RankerTests.swift` at
 * `Ranker.swift`. Names agents and people use run from the general to the
 * specific, so the test's stem must equal the source's or end with it at a
 * `_` or `-` boundary.
 */
function pointsAt(test: string, source: string): boolean {
  if (language(test) !== language(source)) return false;
  const t = stemOf(test).toLowerCase();
  const s = sourceStem(source).toLowerCase();
  return t === s || t.endsWith(`_${s}`) || t.endsWith(`-${s}`);
}

/**
 * Pair the PR's changed code with its changed tests, and name the code no
 * test change accompanies. This is a reading aid, not a coverage measure: a
 * file can be tested by an unchanged test, which the diff cannot show.
 */
export function pairTests(files: ChangedFile[]): Coverage {
  const present = files.filter((f) => f.status !== 'deleted');
  const tests = present.filter((f) => isTestFile(f.path)).map((f) => f.path);
  const sources = present.filter((f) => isSourceCode(f.path)).map((f) => f.path);

  const pairs: Coverage['pairs'] = [];
  const untested: string[] = [];
  for (const source of sources) {
    const matched = tests.filter((t) => pointsAt(t, source));
    if (matched.length > 0) pairs.push({ source, tests: matched });
    else untested.push(source);
  }
  return { pairs, untested };
}
