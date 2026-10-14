import { basename } from 'node:path';

export type RiskCategory =
  | 'CI and automation'
  | 'Ownership and policy'
  | 'Migrations'
  | 'Dependencies'
  | 'Secrets and environment'
  | 'Auth';

export type RiskyGroup = { category: RiskCategory; paths: string[] };

const LOCKFILES = new Set([
  'package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lockb', 'uv.lock', 'poetry.lock',
  'Pipfile.lock', 'Cargo.lock', 'go.sum', 'Gemfile.lock', 'Package.resolved',
]);

export const isLockfile = (path: string): boolean => LOCKFILES.has(basename(path));

export const isMigration = (path: string): boolean =>
  /(^|\/)(?:migrations|alembic\/versions|prisma\/migrations|db\/migrate)\//.test(path);

const AUTH_SEGMENT = /^(?:auth|authn|authz|security|permissions|iam)$/;

/** First match wins, so a path appears once. Order follows spec 6.4. */
const RULES: readonly [RiskCategory, (path: string) => boolean][] = [
  ['CI and automation', (p) => /^\.github\/(?:workflows|actions)\//.test(p) || p === '.gitlab-ci.yml' || p.startsWith('.circleci/')],
  ['Ownership and policy', (p) => /^(?:\.github\/|docs\/)?CODEOWNERS$/.test(p) || /(^|\/)SECURITY\.md$/.test(p)],
  ['Migrations', isMigration],
  ['Dependencies', isLockfile],
  ['Secrets and environment', (p) =>
    (/(^|\/)\.env(?:\.|$)/.test(p) && !/\.env\.(?:example|sample|template)$/.test(p)) ||
    /\.(?:pem|key)$/.test(p) || /(^|\/)secrets\//.test(p)],
  // A segment, or a file's name without its extension: `auth/`, `auth.py`.
  ['Auth', (p) => p.split('/').some((seg) => AUTH_SEGMENT.test(seg.replace(/\.[^.]+$/, '')))],
];

/**
 * Changed paths a reviewer should see named, grouped by why. GitHub's own
 * guidance for agent PRs is to inspect workflow changes before approving,
 * since workflows can run with secrets; the rest are the usual places a
 * small diff carries a large consequence.
 */
export function riskyFiles(paths: string[]): RiskyGroup[] {
  const groups: RiskyGroup[] = [];
  for (const path of paths) {
    const rule = RULES.find(([, matches]) => matches(path));
    if (!rule) continue;
    const group = groups.find((g) => g.category === rule[0]);
    if (group) group.paths.push(path);
    else groups.push({ category: rule[0], paths: [path] });
  }
  return RULES.map(([c]) => groups.find((g) => g.category === c)).filter((g): g is RiskyGroup => g !== undefined);
}
