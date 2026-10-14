import type { ChangedFile } from '../flags/diff-signals.ts';
import { isTestFile } from '../flags/test-files.ts';
import { isLockfile } from './risky.ts';

export type Scope = {
  added: number;
  removed: number;
  files: number;
  created: number;
  deleted: number;
  renamed: number;
  /** Most-changed first, at most six. */
  areas: string[];
  moreAreas: number;
  testsChanged: number;
  testsAdded: number;
  largest: { path: string; lines: number }[];
};

const CONTAINERS = new Set(['apps', 'packages', 'services', 'libs', 'crates', 'cmd', 'internal']);
const GENERATED = /\.min\.(?:js|css)$|(^|\/)(?:dist|build|vendor)\//;
const MAX_AREAS = 6;

export function areaOf(path: string): string {
  const segs = path.split('/');
  if (segs.length === 1) return '(root)';
  if (CONTAINERS.has(segs[0]!) && segs.length > 2) return `${segs[0]}/${segs[1]}`;
  return segs[0]!;
}

/** The size and spread of the change, from the PR diff. Larger, wider PRs are reviewed worse and rejected more. */
export function summariseScope(files: ChangedFile[]): Scope {
  const lines = (x: ChangedFile) => x.added + x.removed;
  const byArea = new Map<string, number>();
  for (const x of files) byArea.set(areaOf(x.path), (byArea.get(areaOf(x.path)) ?? 0) + lines(x));
  // Array.prototype.sort is stable, so ties keep first-seen order.
  const ranked = [...byArea.entries()].sort((a, b) => b[1] - a[1]).map(([area]) => area);
  const tests = files.filter((x) => isTestFile(x.path));

  return {
    added: files.reduce((n, x) => n + x.added, 0),
    removed: files.reduce((n, x) => n + x.removed, 0),
    files: files.length,
    created: files.filter((x) => x.status === 'added').length,
    deleted: files.filter((x) => x.status === 'deleted').length,
    renamed: files.filter((x) => x.status === 'renamed').length,
    areas: ranked.slice(0, MAX_AREAS),
    moreAreas: Math.max(0, ranked.length - MAX_AREAS),
    testsChanged: tests.length,
    testsAdded: tests.filter((x) => x.status === 'added').length,
    largest: files
      .filter((x) => !x.binary && !isLockfile(x.path) && !GENERATED.test(x.path) && lines(x) > 0)
      .sort((a, b) => lines(b) - lines(a))
      .slice(0, 2)
      .map((x) => ({ path: x.path, lines: lines(x) })),
  };
}
