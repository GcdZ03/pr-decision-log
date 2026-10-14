# Reviewer-first Decision Log Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the chronological decision log with a reviewer-first one: a verdict line, what was never checked, decisions the human confirmed, the few places to look, and the change's scope, with everything else collapsed.

**Architecture:** New pure modules under `src/review/` derive review facts (checks, never-run gaps, risky paths, scope) from data pdl already records. `buildLog` attaches them to the `DecisionLog`; `render.ts` is rewritten around the new blocks. Nothing on the hook's recording path changes. The only new git call, `git check-ignore`, runs at build time.

**Tech Stack:** TypeScript run directly by Node 22+ (type stripping), `node:test`, esbuild bundle in `dist/pdl.js`, no runtime dependencies.

**Spec:** `docs/superpowers/specs/2026-10-14-reviewer-first-log-design.md`

## Global Constraints

- Node `>=22`; no runtime dependencies; tests use `node:test` and `node:assert/strict`, files in `test/*.test.ts`.
- Run TypeScript directly: imports use the `.ts` extension, and no TypeScript-only runtime syntax (no `enum`, no parameter properties).
- `dist/pdl.js` is committed and CI fails if it is stale: every commit that touches `src/` runs `npm run build` first and includes `dist/pdl.js`.
- Never published: prompts, free-text answers, raw commands, heredoc bodies, file contents, absolute paths. Published: runner fragments, repo-relative paths, counts, tool names, option labels the human picked.
- The schema stays `pdl/1`: fields are added, none removed or renamed.
- Visible part: at most 15 non-empty lines between `## Decision log` and `<details>`.
- No empty headings and no "none" lines, except `**Checks:** none were run.`
- Times shown as `HH:MM` (UTC, from the ISO timestamp); time gaps in `s`, `min` or `h`.
- Version for the release: `0.1.6`, in `package.json`, `package-lock.json`, `.claude-plugin/plugin.json` and `.claude-plugin/marketplace.json` (tests enforce they match). Publishing is the author's to run.
- Commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **No diff available** (`pdl build` before a PR exists, or an unknown base): the log must still render Checks and Look here, with no Scope block and no Never-run line. Pinned in Task 9.
2. **A very large PR** (hundreds of files, dozens of risky paths, many distinct checks): the visible part stays within 15 lines, the body within `maxChars`, and both markers survive. Pinned in Task 9.
3. **Paths that break markdown**: a file name containing `|` or a backtick must not break the checks table or the inline code. Pinned in Task 9.
4. **Sessions with only fixers or only interrupted runs** (`ruff check --fix .` alone; a cancelled `pytest`): no false ✓. Fixer-only reads `none were run`; interrupted reads `✗ (interrupted)`. Pinned in Tasks 4 and 9.
5. **Many confirmed decisions** (six answered questions, some typed): at most three visible, the rest in the details, and typed answers still read `answered in the session`. Pinned in Task 9.

---

## File Structure

| File | Responsibility |
| --- | --- |
| `src/flags/diff-signals.ts` (modify) | `changedFiles` also returns per-file added/removed line counts and a binary marker |
| `src/review/risky.ts` (create) | Path categories for privileged or risky files; `isMigration`, `isLockfile` |
| `src/review/checks.ts` (create) | One `Check` per distinct runner fragment; tool names; fixer detection; per-tool status |
| `src/review/never-run.ts` (create) | Rules: a diff that touches X with no run of Y |
| `src/review/scope.ts` (create) | Lines, file counts, areas, test files, largest files |
| `src/events/command-text.ts` (modify) | Export `withoutWrapper` for tool names |
| `src/flags/test-edited-after-failure.ts` (modify) | Readable flag detail: what failed, how and how soon the test changed, whether it passed |
| `src/publish/pr-diff.ts` (modify) | `notIgnoredIn(cwd, paths)` via `git check-ignore --stdin` |
| `src/render/build-log.ts` (modify) | Attach `checks`, `neverRun`, `risky`, `scope`, `strayWrites` |
| `src/render/render.ts` (rewrite) | The reviewer-first layout and its truncation |
| `src/extract/transcript.ts` (modify) | `userPrompts(entries)` for local display |
| `src/pdl.ts` (modify) | Wire `notIgnored` into `logMeta`; `pdl show` prints prompts locally |
| `test/golden-log.test.ts`, `test/fixtures/golden-log.md` (create) | Exact expected markdown for a fixed input |

---

### Task 1: Amend the spec for what planning found

**Files:**
- Modify: `docs/superpowers/specs/2026-10-14-reviewer-first-log-design.md`

- [ ] **Step 1: Add the agreed local-prompts add-on to section 4**

Append this bullet to the list in section 4 ("Decisions already made"):

```markdown
- **Prompts stay available locally.** `pdl show` prints the session's prompts beside the timeline, labelled as never published, so the author can check what was asked. Nothing about them reaches GitHub.
```

- [ ] **Step 2: Make "largest" precise in section 6.5**

Replace the bullet starting `- **Largest**:` with:

```markdown
- **Largest**: the two files with the most changed lines (added plus removed), shown as `` `path` (N lines) ``, excluding lockfiles, binary files, and paths that are conventionally generated (`*.min.js`, `*.min.css`, anything under `dist/`, `build/` or `vendor/`). Git itself does not mark files as generated, so this is a path rule.
```

- [ ] **Step 3: Commit**

```bash
git add docs/superpowers/specs/2026-10-14-reviewer-first-log-design.md
git commit -m "docs: spec covers local prompts and a precise largest-file rule

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Line counts and binary marker in `changedFiles`

**Files:**
- Modify: `src/flags/diff-signals.ts` (`FileDiff` type, `parse`, `changedFiles`)
- Test: `test/diff-signals.test.ts`

**Interfaces:**
- Produces: `export type ChangedFile = { path: string; status: FileStatus; added: number; removed: number; binary: boolean }` and `changedFiles(diff: string): ChangedFile[]`.

- [ ] **Step 1: Write the failing tests** (append to `test/diff-signals.test.ts`; add `changedFiles` to its import from `../src/flags/diff-signals.ts`)

```ts
test('changed files carry their added and removed line counts', () => {
  const diff = ['diff --git a/a.ts b/a.ts', '--- a/a.ts', '+++ b/a.ts', '@@ -1,2 +1,3 @@', ' keep', '-old', '+new', '+more'].join('\n');

  assert.deepEqual(changedFiles(diff), [{ path: 'a.ts', status: 'modified', added: 2, removed: 1, binary: false }]);
});

test('a binary file is marked and counts no lines', () => {
  const diff = ['diff --git a/logo.png b/logo.png', 'new file mode 100644', 'index 0000000..1111111', 'Binary files /dev/null and b/logo.png differ'].join('\n');

  assert.deepEqual(changedFiles(diff), [{ path: 'logo.png', status: 'added', added: 0, removed: 0, binary: true }]);
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `node --test test/diff-signals.test.ts`
Expected: FAIL, the objects lack `added`, `removed` and `binary`.

- [ ] **Step 3: Implement**

In `src/flags/diff-signals.ts`, extend the type and the header parsing, and return the counts:

```ts
type FileDiff = { path: string; deleted: boolean; created?: boolean; renamed?: boolean; binary?: boolean; added: string[]; removed: string[] };
```

In `parse`, inside the `if (!inHunk) {` block, add a branch before the `@@` check:

```ts
      else if (line.startsWith('Binary files ')) current.binary = true;
```

Replace `FileStatus`/`changedFiles`:

```ts
export type FileStatus = 'added' | 'modified' | 'deleted' | 'renamed';

export type ChangedFile = { path: string; status: FileStatus; added: number; removed: number; binary: boolean };

/** Every file the diff touches, with how and by how many lines, in diff order. Paths are repo-relative, as git prints them. */
export function changedFiles(diff: string): ChangedFile[] {
  return parse(diff)
    .filter((f) => f.path)
    .map((f) => ({
      path: f.path,
      status: f.deleted ? 'deleted' : f.created ? 'added' : f.renamed ? 'renamed' : 'modified',
      added: f.added.length,
      removed: f.removed.length,
      binary: f.binary === true,
    }));
}
```

- [ ] **Step 4: Run the tests**

Run: `node --test test/diff-signals.test.ts test/build-log.test.ts`
Expected: PASS (build-log maps only `path` and `status`, so it is unaffected).

- [ ] **Step 5: Commit**

```bash
npm run build
git add src/flags/diff-signals.ts test/diff-signals.test.ts dist/pdl.js
git commit -m "feat: changed files carry line counts and a binary marker

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Risky paths

**Files:**
- Create: `src/review/risky.ts`
- Test: `test/risky.test.ts`

**Interfaces:**
- Produces:
  - `export type RiskCategory = 'CI and automation' | 'Ownership and policy' | 'Migrations' | 'Dependencies' | 'Secrets and environment' | 'Auth'`
  - `export type RiskyGroup = { category: RiskCategory; paths: string[] }`
  - `export function riskyFiles(paths: string[]): RiskyGroup[]`
  - `export function isMigration(path: string): boolean`
  - `export function isLockfile(path: string): boolean`

- [ ] **Step 1: Write the failing tests** (`test/risky.test.ts`)

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isLockfile, isMigration, riskyFiles } from '../src/review/risky.ts';

test('each category is recognised', () => {
  assert.deepEqual(riskyFiles([
    '.github/workflows/ci.yml', '.github/actions/setup/action.yml', '.gitlab-ci.yml',
    'CODEOWNERS', '.github/CODEOWNERS', 'SECURITY.md',
    'services/api/migrations/versions/0004_imports.py', 'prisma/migrations/2026_init/migration.sql',
    'uv.lock', 'apps/web/pnpm-lock.yaml', 'go.sum',
    '.env', '.env.production', 'certs/server.pem', 'secrets/db.txt',
    'services/api/src/auth.py', 'src/permissions/roles.ts',
  ]), [
    { category: 'CI and automation', paths: ['.github/workflows/ci.yml', '.github/actions/setup/action.yml', '.gitlab-ci.yml'] },
    { category: 'Ownership and policy', paths: ['CODEOWNERS', '.github/CODEOWNERS', 'SECURITY.md'] },
    { category: 'Migrations', paths: ['services/api/migrations/versions/0004_imports.py', 'prisma/migrations/2026_init/migration.sql'] },
    { category: 'Dependencies', paths: ['uv.lock', 'apps/web/pnpm-lock.yaml', 'go.sum'] },
    { category: 'Secrets and environment', paths: ['.env', '.env.production', 'certs/server.pem', 'secrets/db.txt'] },
    { category: 'Auth', paths: ['services/api/src/auth.py', 'src/permissions/roles.ts'] },
  ]);
});

test('ordinary files, example env files and look-alike names are not risky', () => {
  assert.deepEqual(riskyFiles(['src/app.ts', '.env.example', '.env.sample', 'docs/authoring.md', 'src/author.ts', 'package.json']), []);
});

test('a path is listed under its first matching category only', () => {
  assert.deepEqual(riskyFiles(['auth/migrations/0001.py']), [{ category: 'Migrations', paths: ['auth/migrations/0001.py'] }]);
});

test('lockfiles and migrations are recognised on their own', () => {
  assert.equal(isLockfile('a/b/package-lock.json'), true);
  assert.equal(isLockfile('package.json'), false);
  assert.equal(isMigration('db/migrate/20260101_add.rb'), true);
  assert.equal(isMigration('src/migrate.ts'), false);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test test/risky.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement** (`src/review/risky.ts`)

```ts
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
```

- [ ] **Step 4: Run the tests**

Run: `node --test test/risky.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/review/risky.ts test/risky.test.ts
git commit -m "feat: name privileged and risky files by category

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

(No `dist/` change: nothing imports the module yet, so the bundle is unchanged. Confirm with `npm run build && git status --short dist/`.)

---

### Task 4: Checks, tools and fixers

**Files:**
- Modify: `src/events/command-text.ts` (export `withoutWrapper`)
- Create: `src/review/checks.ts`
- Test: `test/checks.test.ts`

**Interfaces:**
- Consumes: `classifyCommand(command): CommandKind`, `runnerFragment(command): string | undefined`.
- Produces:
  - `export function withoutWrapper(fragment: string): string` (in `command-text.ts`)
  - `export type Check = { command: string; kind: 'test' | 'build' | 'lint'; tool: string; runs: number; failures: number; last: Outcome; lastAt: string; fixer: boolean }`
  - `export function summariseChecks(events: TimelineEvent[]): Check[]`
  - `export function toolOf(fragment: string): string`
  - `export function isFixer(fragment: string): boolean`
  - `export type ToolStatus = { tool: string; status: Outcome }`
  - `export function toolStatuses(checks: Check[]): ToolStatus[]`

- [ ] **Step 1: Write the failing tests** (`test/checks.test.ts`)

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isFixer, summariseChecks, toolOf, toolStatuses } from '../src/review/checks.ts';
import type { Outcome, TimelineEvent } from '../src/events/types.ts';

let n = 0;
const run = (command: string, outcome: Outcome, at = `2026-10-03T06:${String(10 + n).padStart(2, '0')}:00Z`): TimelineEvent =>
  ({ kind: 'command', id: `c${n++}`, at, command, classification: 'other', outcome });

test('a check is one distinct runner fragment, with its runs, failures and last result', () => {
  const checks = summariseChecks([
    run('uv run pytest tests/test_p.py -q 2>&1 | tail', 'fail'),
    run('uv run pytest tests/test_p.py -q', 'pass'),
    run('uv run pytest -q', 'pass'),
    run('ls -la', 'pass'),
  ]);

  assert.deepEqual(checks.map((c) => [c.command, c.tool, c.runs, c.failures, c.last]), [
    ['uv run pytest tests/test_p.py -q', 'pytest', 2, 1, 'pass'],
    ['uv run pytest -q', 'pytest', 1, 0, 'pass'],
  ]);
});

test('tool names come from the runner, not its launcher or arguments', () => {
  const cases: [string, string][] = [
    ['pnpm --filter @acme/web build', 'pnpm build'],
    ['pnpm run typecheck', 'pnpm typecheck'],
    ['npm test --', 'npm test'],
    ['npx vitest run', 'vitest'],
    ['python3 -m pytest -x', 'pytest'],
    ['pnpm exec playwright test e2e/a.spec.ts', 'playwright test'],
    ['just test', 'just test'],
    ['go test ./...', 'go test'],
    ['cargo test', 'cargo test'],
    ['node --test test/a.test.ts', 'node --test'],
    ['docker compose build web', 'docker compose build'],
    ['docker build -t x .', 'docker build'],
    ['tsc --noEmit', 'tsc'],
    ['uv run ruff check .', 'ruff'],
  ];
  for (const [fragment, tool] of cases) assert.equal(toolOf(fragment), tool, fragment);
});

test('a command that rewrites files is a fixer, unless it only checks', () => {
  for (const f of ['uv run ruff check --fix .', 'pnpm exec prettier --write apps/web', 'uv run ruff format .', 'cargo fmt', 'gofmt -w .', 'black src']) {
    assert.equal(isFixer(f), true, f);
  }
  for (const f of ['uv run ruff check .', 'prettier --check .', 'cargo fmt --check', 'black --check src', 'pnpm test']) {
    assert.equal(isFixer(f), false, f);
  }
});

test('a tool passes only when the last run of every one of its checks passed', () => {
  const statuses = toolStatuses(summariseChecks([
    run('uv run pytest -q', 'pass'),
    run('uv run pytest tests/test_a.py -q', 'fail'),
    run('pnpm test', 'fail'),
    run('pnpm test', 'pass'),
    run('uv run pytest tests/test_b.py -q', 'interrupted'),
  ]));

  assert.deepEqual(statuses, [{ tool: 'pytest', status: 'fail' }, { tool: 'pnpm test', status: 'pass' }]);
});

test('an interrupted last run is never shown as a pass', () => {
  assert.deepEqual(toolStatuses(summariseChecks([run('uv run pytest -q', 'pass'), run('uv run pytest -q', 'interrupted')])),
    [{ tool: 'pytest', status: 'interrupted' }]);
});

test('fixers are summarised but never count toward a tool status', () => {
  const checks = summariseChecks([run('uv run ruff check --fix .', 'pass')]);

  assert.equal(checks[0]?.fixer, true);
  assert.deepEqual(toolStatuses(checks), []);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test test/checks.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Export `withoutWrapper`** (in `src/events/command-text.ts`, after the `WRAPPER_RE` declaration)

```ts
/** A fragment without its launcher and wrapper: `uv run pytest -q` is `pytest -q`. */
export function withoutWrapper(fragment: string): string {
  return fragment.replace(LAUNCHER_RE, '').replace(WRAPPER_RE, '');
}
```

- [ ] **Step 4: Implement** (`src/review/checks.ts`)

```ts
import type { Outcome, TimelineEvent } from '../events/types.ts';
import { classifyCommand } from '../events/classify-command.ts';
import { runnerFragment, withoutWrapper } from '../events/command-text.ts';

/** One distinct runner fragment and what happened each time it ran. */
export type Check = {
  /** The runner fragment, which is all that is published. */
  command: string;
  kind: 'test' | 'build' | 'lint';
  /** What the Checks line groups by: `pytest`, `pnpm test`, `docker build`. */
  tool: string;
  runs: number;
  failures: number;
  last: Outcome;
  lastAt: string;
  /** Rewrites files (`--fix`, `--write`, `format`): an auto-fix, never a check. */
  fixer: boolean;
};

const PACKAGE_MANAGERS = new Set(['npm', 'pnpm', 'yarn', 'bun']);
/** Package-manager options that take a value, so the value is not mistaken for the script. */
const OPTION_WITH_VALUE = new Set(['--filter', '-F', '--dir', '-C', '--prefix', '--workspace', '--cwd']);
const TASK_RUNNERS = new Set(['just', 'make', 'task']);
const SUBCOMMAND_TOOLS = new Set(['go', 'cargo', 'swift', 'dotnet', 'playwright']);

export function toolOf(fragment: string): string {
  const words = withoutWrapper(fragment).split(/\s+/).filter(Boolean);
  const first = words[0] ?? '';

  if (PACKAGE_MANAGERS.has(first)) {
    for (let i = 1; i < words.length; i++) {
      const w = words[i]!;
      if (OPTION_WITH_VALUE.has(w)) { i++; continue; }
      if (w.startsWith('-') || w === 'run') continue;
      return `${first} ${w}`;
    }
    return first;
  }
  if (TASK_RUNNERS.has(first)) return words[1] && !words[1].startsWith('-') ? `${first} ${words[1]}` : first;
  if (first === 'node' && words[1] === '--test') return 'node --test';
  if (first === 'docker') {
    const rest = words.slice(1).filter((w) => !w.startsWith('-'));
    return ['docker', ...rest.slice(0, rest[0] === 'build' ? 1 : 2)].join(' ');
  }
  if (SUBCOMMAND_TOOLS.has(first) && words[1] && !words[1].startsWith('-')) return `${first} ${words[1]}`;
  return first;
}

const FORMATTERS = /\b(?:ruff\s+format|cargo\s+fmt|black|rustfmt|swiftformat|gofmt)\b/;

export function isFixer(fragment: string): boolean {
  const words = fragment.split(/\s+/);
  if (words.includes('--check') || words.includes('--diff')) return false;
  if (words.some((w) => w === '--fix' || w === '--write' || w === '-w' || w.startsWith('--fix='))) return true;
  return FORMATTERS.test(fragment);
}

/**
 * Every test, build and lint run, folded into one entry per distinct runner
 * fragment in first-seen order. Classification happens here, from the text,
 * so events recorded by older versions are read with today's rules.
 */
export function summariseChecks(events: TimelineEvent[]): Check[] {
  const byCommand = new Map<string, Check>();
  for (const e of events) {
    if (e.kind !== 'command') continue;
    const kind = classifyCommand(e.command);
    if (kind !== 'test' && kind !== 'build' && kind !== 'lint') continue;
    const command = runnerFragment(e.command);
    if (!command) continue;

    const failed = e.outcome === 'fail' ? 1 : 0;
    const seen = byCommand.get(command);
    if (seen) {
      seen.runs += 1;
      seen.failures += failed;
      seen.last = e.outcome;
      seen.lastAt = e.at;
    } else {
      byCommand.set(command, {
        command, kind, tool: toolOf(command), runs: 1, failures: failed,
        last: e.outcome, lastAt: e.at, fixer: isFixer(command),
      });
    }
  }
  return [...byCommand.values()];
}

export type ToolStatus = { tool: string; status: Outcome };

const RANK: Record<Outcome, number> = { pass: 0, unknown: 1, interrupted: 2, fail: 3 };

/**
 * One status per tool: the worst last result among its checks. A tool reads
 * as passing only when every check under it last passed, so a green full
 * suite cannot hide a single file still failing. Fixers are left out.
 */
export function toolStatuses(checks: Check[]): ToolStatus[] {
  const out: ToolStatus[] = [];
  for (const c of checks) {
    if (c.fixer) continue;
    const t = out.find((x) => x.tool === c.tool);
    if (!t) out.push({ tool: c.tool, status: c.last });
    else if (RANK[c.last] > RANK[t.status]) t.status = c.last;
  }
  return out;
}
```

- [ ] **Step 5: Run the tests**

Run: `node --test test/checks.test.ts test/command-text.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
npm run build
git add src/events/command-text.ts src/review/checks.ts test/checks.test.ts dist/pdl.js
git commit -m "feat: summarise checks per runner, by tool, with fixers apart

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Never-run rules

**Files:**
- Create: `src/review/never-run.ts`
- Test: `test/never-run.test.ts`

**Interfaces:**
- Consumes: `commandSegments(command): string[]`, `runsKind(segment, re): boolean` (both in `command-text.ts`), `isMigration(path)` (Task 3).
- Produces: `export type NeverRun = { check: string; because: string }` and `export function neverRun(paths: string[], commands: string[]): NeverRun[]`.

- [ ] **Step 1: Write the failing tests** (`test/never-run.test.ts`)

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { neverRun } from '../src/review/never-run.ts';

test('a changed Dockerfile with no build run is reported', () => {
  assert.deepEqual(neverRun(['services/api/Dockerfile', 'src/a.ts'], ['pnpm test']), [{ check: 'docker build', because: 'a Docker file changed' }]);
  assert.deepEqual(neverRun(['docker-compose.yml'], []), [{ check: 'docker build', because: 'a Docker file changed' }]);
});

test('any docker build form satisfies the rule, wherever it appears in a script', () => {
  for (const c of ['docker build -t x .', 'cd /w && docker compose build web 2>&1 | tail', 'docker buildx build .']) {
    assert.deepEqual(neverRun(['Dockerfile'], [c]), [], c);
  }
});

test('a changed migration with no migrate run is reported, and a migrate run satisfies it', () => {
  const paths = ['services/api/migrations/versions/0004_imports.py'];

  assert.deepEqual(neverRun(paths, ['uv run pytest -q']), [{ check: 'migrations', because: 'a migration changed' }]);
  for (const c of ['uv run alembic upgrade head', 'just migrate', 'python manage.py migrate', 'npx prisma migrate dev']) {
    assert.deepEqual(neverRun(paths, [c]), [], c);
  }
});

test('a Dockerfile only mentioned in a heredoc or an echo is not a build', () => {
  assert.deepEqual(neverRun(['Dockerfile'], ["cat > notes.md <<'EOF'\ndocker build .\nEOF", 'echo "docker build later"']),
    [{ check: 'docker build', because: 'a Docker file changed' }]);
});

test('nothing matching means nothing reported', () => {
  assert.deepEqual(neverRun(['src/a.ts', 'README.md'], []), []);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test test/never-run.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement** (`src/review/never-run.ts`)

```ts
import { commandSegments, runsKind } from '../events/command-text.ts';
import { isMigration } from './risky.ts';

export type NeverRun = { check: string; because: string };

type Rule = { check: string; because: string; touches: (path: string) => boolean; satisfiedBy: RegExp };

const DOCKER_FILE = /(^|\/)(?:Dockerfile[^/]*|[^/]+\.dockerfile|docker-compose[^/]*\.ya?ml|compose[^/]*\.ya?ml)$/i;

/**
 * A change whose own check never ran. Deliberately few: each rule is a claim
 * that a reviewer would otherwise have to find for themselves, and a wrong
 * one at the top of the log costs more than a missing one.
 */
export const NEVER_RUN_RULES: readonly Rule[] = [
  {
    check: 'docker build', because: 'a Docker file changed',
    touches: (p) => DOCKER_FILE.test(p),
    satisfiedBy: /docker\s+(?:compose\s+|buildx\s+)?build\b/,
  },
  {
    check: 'migrations', because: 'a migration changed',
    touches: isMigration,
    satisfiedBy: /(?:alembic\s+upgrade|prisma\s+migrate|rails\s+db:migrate|(?:python3?\s+)?manage\.py\s+migrate|(?:just|make)\s+migrate)\b/,
  },
];

/** `paths`: the PR's changed files that still exist. `commands`: every command text the sessions ran. */
export function neverRun(paths: string[], commands: string[]): NeverRun[] {
  const segments = commands.flatMap(commandSegments);
  return NEVER_RUN_RULES
    .filter((r) => paths.some(r.touches) && !segments.some((s) => runsKind(s, r.satisfiedBy)))
    .map(({ check, because }) => ({ check, because }));
}
```

- [ ] **Step 4: Run the tests**

Run: `node --test test/never-run.test.ts`
Expected: PASS. If `npx prisma migrate dev` fails, check that `WRAPPER_RE` in `command-text.ts` strips `npx` (it does in 0.1.5); do not widen the rule.

- [ ] **Step 5: Commit**

```bash
git add src/review/never-run.ts test/never-run.test.ts
git commit -m "feat: report a changed Dockerfile or migration whose check never ran

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Scope

**Files:**
- Create: `src/review/scope.ts`
- Test: `test/scope.test.ts`

**Interfaces:**
- Consumes: `ChangedFile` (Task 2), `isLockfile` (Task 3), `isTestFile(path)` from `src/flags/test-files.ts`.
- Produces:
  - `export type Scope = { added: number; removed: number; files: number; created: number; deleted: number; renamed: number; areas: string[]; moreAreas: number; testsChanged: number; testsAdded: number; largest: { path: string; lines: number }[] }`
  - `export function summariseScope(files: ChangedFile[]): Scope`
  - `export function areaOf(path: string): string`

- [ ] **Step 1: Write the failing tests** (`test/scope.test.ts`)

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { areaOf, summariseScope } from '../src/review/scope.ts';
import type { ChangedFile } from '../src/flags/diff-signals.ts';

const f = (path: string, added: number, removed = 0, status: ChangedFile['status'] = 'modified', binary = false): ChangedFile =>
  ({ path, status, added, removed, binary });

test('areas use the first segment, or two under a monorepo container', () => {
  assert.equal(areaOf('services/api/src/main.py'), 'services/api');
  assert.equal(areaOf('apps/web/page.tsx'), 'apps/web');
  assert.equal(areaOf('src/a.ts'), 'src');
  assert.equal(areaOf('services/README.md'), 'services');
  assert.equal(areaOf('README.md'), '(root)');
});

test('scope counts lines and files by status, tests, and ranks areas by lines changed', () => {
  const s = summariseScope([
    f('services/api/src/parsing.py', 400, 10, 'added'),
    f('services/api/tests/test_parsing.py', 270, 0, 'added'),
    f('apps/web/src/lib/imports.ts', 250, 10),
    f('uv.lock', 900, 300),
    f('old.md', 0, 5, 'deleted'),
    f('logo.png', 0, 0, 'added', true),
  ]);

  assert.deepEqual(
    [s.added, s.removed, s.files, s.created, s.deleted, s.renamed, s.testsChanged, s.testsAdded],
    [1820, 325, 6, 3, 1, 0, 1, 1],
  );
  assert.deepEqual(s.areas, ['(root)', 'services/api', 'apps/web']);
  assert.equal(s.moreAreas, 0);
});

test('largest skips lockfiles, binaries and generated paths', () => {
  const s = summariseScope([f('uv.lock', 5000), f('dist/app.js', 4000), f('a.min.js', 3000), f('logo.png', 0, 0, 'added', true),
    f('src/big.ts', 300, 20), f('src/mid.ts', 100), f('src/small.ts', 5)]);

  assert.deepEqual(s.largest, [{ path: 'src/big.ts', lines: 320 }, { path: 'src/mid.ts', lines: 100 }]);
});

test('at most six areas are named, with a count of the rest', () => {
  const s = summariseScope(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'].map((x, i) => f(`${x}/file.ts`, 100 - i)));

  assert.deepEqual(s.areas, ['a', 'b', 'c', 'd', 'e', 'f']);
  assert.equal(s.moreAreas, 2);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test test/scope.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement** (`src/review/scope.ts`)

```ts
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
```

- [ ] **Step 4: Run the tests**

Run: `node --test test/scope.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/review/scope.ts test/scope.test.ts
git commit -m "feat: summarise a change's size, spread, tests and largest files

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Readable test-edit flag

**Files:**
- Modify: `src/flags/test-edited-after-failure.ts` (`detail`, the window bookkeeping, `emit`)
- Test: `test/test-edited-after-failure.test.ts`, `test/pipeline.test.ts` (check only), `test/build-log.test.ts` (check only)

**Interfaces:**
- Consumes: `EditEvent.via` (`'shell'` or absent), `summariseCommand(command)`.
- Produces: `Flag.detail` for `TEST_EDITED_AFTER_FAILURE` in the form
  `` `<fragment>` failed at HH:MM; the test was <how> <gap> later; it passed at HH:MM.`` with optional ` Assertion count A -> B.`

- [ ] **Step 1: Write the failing tests** (append to `test/test-edited-after-failure.test.ts`)

```ts
test('the flag says what failed, how and how soon the test changed, and when it passed', () => {
  const flags = detectTestEditedAfterFailure(expandWrites([
    { kind: 'command', id: 'c1', at: '2026-10-03T06:18:32.200Z', command: 'uv run pytest tests/test_p.py -q', classification: 'test', outcome: 'fail', output: 'FAILED tests/test_p.py::t' },
    { kind: 'command', id: 'w1', at: '2026-10-03T06:18:40.247Z', command: "python3 - <<'EOF'\nx\nEOF", classification: 'other', outcome: 'pass', writes: [{ path: 'tests/test_p.py' }] },
    { kind: 'command', id: 'c2', at: '2026-10-03T06:19:52.000Z', command: 'uv run pytest tests/test_p.py -q', classification: 'test', outcome: 'pass' },
  ]));

  assert.equal(flags[0]?.detail, '`uv run pytest tests/test_p.py -q` failed at 06:18; the test was written from the shell 8 s later; it passed at 06:19.');
});

test('several edits are counted, and a failure that never passed says so', () => {
  const flags = detectTestEditedAfterFailure([
    cmd('c1', '2026-10-03T09:00:00Z', 'npm test', 'fail', 'FAIL src/a.test.ts'),
    edit('e1', '2026-10-03T09:02:00Z', 'src/a.test.ts', 3, 2),
    edit('e2', '2026-10-03T09:05:00Z', 'src/a.test.ts', 2, 1),
  ]);

  assert.equal(flags[0]?.detail, '`npm test` failed at 09:00; the test was changed 2 times with the Edit tool, first 2 min later; it has not passed since. Assertion count 3 -> 1.');
});
```

Update the two existing tests that match the old wording:
- In `'a test file rewritten from the shell after a failure is flagged'`, replace `/after \`pnpm test\` failed/` with `/^\`pnpm test\` failed at /`.
- In `'a failing command that is not a test run neither opens nor closes a window'`, replace `/after \`npm test\` failed/` with `/^\`npm test\` failed at /`.

- [ ] **Step 2: Run to verify failure**

Run: `node --test test/test-edited-after-failure.test.ts`
Expected: FAIL on the two new tests and the two updated ones.

- [ ] **Step 3: Implement**

In `src/flags/test-edited-after-failure.ts`, the window keeps a count, and `emit` receives the passing run when there is one:

```ts
  let window = new Map<string, { first: EditEvent; last: EditEvent; count: number; viaShell: number }>();

  const emit = (failure: CommandEvent, passed?: CommandEvent) => {
    for (const w of window.values()) {
      if (isPurelyAdditive(w.first.assertionsBefore, w.last.assertionsAfter)) continue;
      if (w.first.additive && w.last.additive) continue; // Appends only: nothing was taken out.
      flags.push({
        code: 'TEST_EDITED_AFTER_FAILURE',
        severity: 'warn',
        file: w.first.path,
        detail: detail(failure, w, passed),
        evidence: [failure.id, w.first.id],
      });
    }
    window = new Map();
  };
```

In the loop: the closing branch becomes `emit(openFailure, e);`, the reopening branch (`if (openFailure) emit(openFailure);`) and the end-of-timeline call stay without a second argument, and the edit bookkeeping becomes:

```ts
      const seen = window.get(e.path);
      const shell = e.via === 'shell' ? 1 : 0;
      if (seen) { seen.last = e; seen.count += 1; seen.viaShell += shell; }
      else window.set(e.path, { first: e, last: e, count: 1, viaShell: shell });
```

Replace `detail`:

```ts
const hhmm = (at: string): string => /T(\d{2}:\d{2})/.exec(at)?.[1] ?? at;

function gap(from: string, to: string): string {
  const s = Math.round((Date.parse(to) - Date.parse(from)) / 1000);
  if (!Number.isFinite(s) || s < 0) return '';
  if (s < 60) return `${s} s`;
  if (s < 3600) return `${Math.round(s / 60)} min`;
  return `${Math.round(s / 3600)} h`;
}

/**
 * One sentence a reviewer can act on: what failed, how the test was changed
 * and how soon, and whether the failure was resolved. The assertion count is
 * added only when it moved, since an unchanged count says nothing.
 */
function detail(failure: CommandEvent, w: { first: EditEvent; last: EditEvent; count: number; viaShell: number }, passed?: CommandEvent): string {
  const how = w.viaShell === w.count ? 'from the shell' : w.viaShell === 0 ? 'with the Edit tool' : 'with the Edit tool and from the shell';
  const soon = gap(failure.at, w.first.at);
  const change = w.count === 1
    ? `the test was ${how === 'from the shell' ? 'written from the shell' : `changed ${how}`}${soon ? ` ${soon} later` : ''}`
    : `the test was changed ${w.count} times ${how}${soon ? `, first ${soon} later` : ''}`;
  const after = passed ? `it passed at ${hhmm(passed.at)}` : 'it has not passed since';
  const counts =
    w.first.assertionsBefore !== undefined && w.last.assertionsAfter !== undefined && w.first.assertionsBefore !== w.last.assertionsAfter
      ? ` Assertion count ${w.first.assertionsBefore} -> ${w.last.assertionsAfter}.`
      : '';
  return `\`${summariseCommand(failure.command)}\` failed at ${hhmm(failure.at)}; ${change}; ${after}.${counts}`;
}
```

- [ ] **Step 4: Run the affected suites**

Run: `node --test test/test-edited-after-failure.test.ts test/pipeline.test.ts test/build-log.test.ts test/diff-in-log.test.ts`
Expected: PASS. `pipeline.test.ts` matches `/2 -> 1/`, which the new sentence keeps. If a test still matches the removed phrase `before it passed again`, update that assertion to the new sentence; do not restore the old wording.

- [ ] **Step 5: Commit**

```bash
npm run build
git add src/flags/test-edited-after-failure.ts test/test-edited-after-failure.test.ts dist/pdl.js
git commit -m "feat: the test-edit flag says how and how soon the test changed

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: Attach the review facts in `buildLog`

**Files:**
- Modify: `src/publish/pr-diff.ts` (add `notIgnoredIn`)
- Modify: `src/render/build-log.ts` (`DecisionLog`, `LogMeta`, `buildLog`)
- Modify: `src/pdl.ts` (`logMeta`)
- Test: `test/build-log.test.ts`, `test/pr-diff.test.ts`

**Interfaces:**
- Consumes: `summariseChecks`, `Check` (Task 4); `neverRun`, `NeverRun` (Task 5); `riskyFiles`, `RiskyGroup` (Task 3); `summariseScope`, `Scope` (Task 6); `changedFiles` (Task 2).
- Produces, on `DecisionLog`: `checks: Check[]; neverRun: NeverRun[]; risky: RiskyGroup[]; scope?: Scope; strayWrites: string[]`. On `LogMeta`: `notIgnored?: (paths: string[]) => string[]`. In `pr-diff.ts`: `export function notIgnoredIn(cwd: string, paths: string[]): string[]`.

- [ ] **Step 1: Write the failing tests**

Append to `test/build-log.test.ts`:

```ts
const REVIEW_DIFF = [
  'diff --git a/Dockerfile b/Dockerfile', '--- a/Dockerfile', '+++ b/Dockerfile', '@@ -1 +1 @@', '-FROM a', '+FROM b',
  'diff --git a/.github/workflows/ci.yml b/.github/workflows/ci.yml', '--- a/.github/workflows/ci.yml', '+++ b/.github/workflows/ci.yml', '@@ -1 +1 @@', '-x', '+y',
  'diff --git a/src/api.ts b/src/api.ts', '--- a/src/api.ts', '+++ b/src/api.ts', '@@ -1 +1,2 @@', '-a', '+b', '+c',
].join('\n');

test('the log carries checks, never-run gaps, risky files and scope from the diff', () => {
  const log = buildLog([
    { kind: 'command', id: 'c1', at: '2026-10-03T06:00:00Z', command: 'pnpm test 2>&1 | tail', classification: 'test', outcome: 'pass' },
  ], { ...meta, repoRoot: '/repo', diff: REVIEW_DIFF });

  assert.deepEqual(log.checks.map((c) => [c.command, c.tool, c.last]), [['pnpm test', 'pnpm test', 'pass']]);
  assert.deepEqual(log.neverRun, [{ check: 'docker build', because: 'a Docker file changed' }]);
  assert.deepEqual(log.risky, [{ category: 'CI and automation', paths: ['.github/workflows/ci.yml'] }]);
  assert.equal(log.scope?.files, 3);
  assert.equal(log.scope?.added, 4);
});

test('stray writes are in-repo writes the diff lacks, minus what git ignores', () => {
  const log = buildLog([
    writer('w1', 'x', [{ path: '/repo/src/api.ts' }, { path: '/repo/notes/todo.md' }, { path: '/repo/out.log' }, { path: '/tmp/scratch.txt' }]),
  ], { ...meta, repoRoot: '/repo', diff: REVIEW_DIFF, notIgnored: (paths) => paths.filter((p) => !p.endsWith('.log')) });

  assert.deepEqual(log.strayWrites, ['notes/todo.md']);
});

test('with no diff there is no scope, no never-run line and no stray list', () => {
  const log = buildLog([edit('e1', 'src/a.ts')], meta);

  assert.equal(log.scope, undefined);
  assert.deepEqual(log.neverRun, []);
  assert.deepEqual(log.strayWrites, []);
});
```

Append to `test/pr-diff.test.ts` (add `notIgnoredIn` to its import, and `mkdirSync` to the `node:fs` import):

```ts
test('notIgnoredIn drops paths git ignores and keeps the rest', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pdl-ignore-'));
  try {
    execFileSync('git', ['init', '-q'], { cwd: dir });
    writeFileSync(join(dir, '.gitignore'), '*.log\nbuild/\n');
    assert.deepEqual(notIgnoredIn(dir, ['a.log', 'build/x.js', 'src/a.ts', 'notes.md']), ['src/a.ts', 'notes.md']);
    assert.deepEqual(notIgnoredIn(dir, []), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('outside a repository nothing is dropped, rather than guessing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pdl-norepo-'));
  try {
    assert.deepEqual(notIgnoredIn(dir, ['a.log']), ['a.log']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test test/build-log.test.ts test/pr-diff.test.ts`
Expected: FAIL; `log.checks` is undefined and `notIgnoredIn` is not exported.

- [ ] **Step 3: Implement `notIgnoredIn`** (append to `src/publish/pr-diff.ts`)

```ts
/**
 * The paths git does not ignore, for listing files the session wrote that the
 * diff lacks: logs and build output are ignored, so they never make the list.
 * Exit 1 means none are ignored; anything else (not a repository) keeps them all.
 */
export function notIgnoredIn(cwd: string, paths: string[]): string[] {
  if (paths.length === 0) return [];
  const p = spawnSync('git', ['check-ignore', '--stdin'], { cwd, input: paths.join('\n'), encoding: 'utf8' });
  if (p.status !== 0 && p.status !== 1) return paths;
  const ignored = new Set((p.stdout ?? '').split('\n').filter(Boolean));
  return paths.filter((x) => !ignored.has(x));
}
```

- [ ] **Step 4: Extend `DecisionLog`, `LogMeta` and `buildLog`** (in `src/render/build-log.ts`)

Add the imports:

```ts
import { summariseChecks, type Check } from '../review/checks.ts';
import { neverRun, type NeverRun } from '../review/never-run.ts';
import { riskyFiles, type RiskyGroup } from '../review/risky.ts';
import { summariseScope, type Scope } from '../review/scope.ts';
```

Add to `DecisionLog`, after `flags`:

```ts
  /** One entry per distinct test, build or lint fragment; `verification` keeps every run. */
  checks: Check[];
  neverRun: NeverRun[];
  risky: RiskyGroup[];
  /** Absent when there is no diff to measure. */
  scope?: Scope;
  /** In-repo files written in the session that the diff lacks and git does not ignore. */
  strayWrites: string[];
```

Add to `LogMeta`:

```ts
  /** Filters out paths git ignores; omitted, every path is kept. */
  notIgnored?: (paths: string[]) => string[];
```

In `buildLog`, after `changes` is computed and before the flags, add:

```ts
  const checks = summariseChecks(events).map((c) => ({ ...c, command: clean(c.command), tool: clean(c.tool) }));
  const present = fromDiff.filter((f) => f.status !== 'deleted').map((f) => f.path);
  const commandTexts = events.flatMap((e) => (e.kind === 'command' ? [e.command] : []));
  const missing = fromDiff.length > 0 ? neverRun(present, commandTexts) : [];
  const risky = riskyFiles(fromDiff.map((f) => f.path));
  const scope = fromDiff.length > 0 ? summariseScope(fromDiff) : undefined;
  const unlisted = [...edits.keys()].filter((file) => !fromDiff.some((f) => f.path === file));
  const strayWrites = fromDiff.length > 0 ? (meta.notIgnored ? meta.notIgnored(unlisted) : unlisted) : [];
```

and add them to the returned object after `flags`:

```ts
    checks,
    neverRun: missing,
    risky,
    ...(scope ? { scope } : {}),
    strayWrites,
```

(`edits` holds only in-repo paths, relative to `repoRoot`, so `/tmp/scratch.txt` never reaches `unlisted`.)

- [ ] **Step 5: Wire `notIgnored` into `logMeta`** (in `src/pdl.ts`)

Add `notIgnoredIn` to the import from `./publish/pr-diff.ts`, and in `logMeta` add:

```ts
    notIgnored: (paths: string[]) => notIgnoredIn(place.repo, paths),
```

- [ ] **Step 6: Run the suites**

Run: `npx tsc --noEmit && node --test test/build-log.test.ts test/pr-diff.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
npm run build
git add src/publish/pr-diff.ts src/render/build-log.ts src/pdl.ts test/build-log.test.ts test/pr-diff.test.ts dist/pdl.js
git commit -m "feat: the log carries checks, never-run gaps, risky files, scope and stray writes

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: Rewrite the renderer

**Files:**
- Rewrite: `src/render/render.ts`
- Rewrite: `test/render.test.ts`
- Modify: `test/decisions-render.test.ts`, `test/diff-in-log.test.ts` (the tests listed in Step 1)

**Interfaces:**
- Consumes: `DecisionLog` with the Task 8 fields; `toolStatuses` (Task 4).
- Produces: `render(log: DecisionLog, options?: RenderOptions): string`, `MARKER_START`, `MARKER_END` (unchanged names), and `export const VISIBLE_LINE_BUDGET = 15`.

- [ ] **Step 1: Write the failing tests**

Replace `test/render.test.ts` entirely:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { render, VISIBLE_LINE_BUDGET } from '../src/render/render.ts';
import { buildLog, type LogMeta } from '../src/render/build-log.ts';
import type { Outcome, TimelineEvent } from '../src/events/types.ts';
import type { Decision } from '../src/extract/decisions.ts';

const meta: LogMeta = { repo: 'github.com/g/r', branch: 'feat/x', headSha: 'abc1234', generatedAt: '2026-10-03T10:00:00Z', repoRoot: '/repo' };
let n = 0;
const run = (command: string, outcome: Outcome = 'pass', output = ''): TimelineEvent =>
  ({ kind: 'command', id: `c${n++}`, at: `2026-10-03T06:${String(n % 60).padStart(2, '0')}:00Z`, command, classification: 'other', outcome, output });
const fileDiff = (path: string, added = 1, status: 'modified' | 'added' = 'modified') => [
  `diff --git a/${path} b/${path}`, ...(status === 'added' ? ['new file mode 100644', '--- /dev/null'] : [`--- a/${path}`]),
  `+++ b/${path}`, '@@ -1 +1 @@', ...Array.from({ length: added }, (_, i) => `+line ${i}`),
].join('\n');
const visibleLines = (md: string) => {
  const start = md.indexOf('## Decision log') + '## Decision log'.length;
  const end = md.includes('<details>') ? md.indexOf('<details>') : md.indexOf('<sub>');
  return md.slice(start, end).split('\n').filter((l) => l.trim()).length;
};
const confirmed = (text: string): Decision => ({ text, kind: 'decision', source: 'human-answer', confidence: 'confirmed_by_human' });

test('blocks come in reviewer order: checks, decisions, look here, scope, then details', () => {
  const md = render(buildLog([
    run('npm test', 'fail', 'FAIL src/a.test.ts'),
    { kind: 'edit', id: 'e1', at: '2026-10-03T06:59:30Z', path: '/repo/src/a.test.ts', assertionsBefore: 2, assertionsAfter: 1 },
    run('npm test'),
  ], { ...meta, diff: fileDiff('src/a.test.ts') }, [confirmed('Base: main')]));

  const order = ['**Checks (last run):**', '### Decisions you confirmed', '### Look here', '### Scope', '<details>'].map((s) => md.indexOf(s));
  assert.ok(order.every((i, k) => i > -1 && (k === 0 || i > order[k - 1]!)), md);
});

test('the checks line shows each tool, and a last failure is said plainly', () => {
  const md = render(buildLog([run('uv run pytest -q'), run('uv run pytest tests/test_b.py -q', 'fail'), run('pnpm test')], meta));

  assert.match(md, /\*\*Checks \(last run\):\*\* pytest ✗ \(failed, not re-run\) · pnpm test ✓/);
});

test('fixers are not checks, and a session with only fixers ran none', () => {
  const md = render(buildLog([run('uv run ruff check --fix .')], meta));

  assert.match(md, /\*\*Checks:\*\* none were run\./);
  assert.match(md, /Auto-fixes: `uv run ruff check --fix \.`/);
});

test('an interrupted last run is never a tick', () => {
  const md = render(buildLog([run('uv run pytest -q', 'interrupted')], meta));

  assert.match(md, /pytest ✗ \(interrupted\)/);
});

test('never-run gaps and the intent pointer share the second line', () => {
  const md = render(buildLog([run('npm test')], { ...meta, diff: fileDiff('Dockerfile') }));

  assert.match(md, /\n\*\*Never run:\*\* docker build \(a Docker file changed\) · Intent: see the PR description\.\n/);
});

test('risky files are one bullet under Look here, grouped by category', () => {
  const md = render(buildLog([run('npm test')], { ...meta, diff: [fileDiff('.github/workflows/ci.yml'), fileDiff('uv.lock')].join('\n') }));

  assert.match(md, /- \*\*Privileged or risky files:\*\* ci and automation: `\.github\/workflows\/ci\.yml` · dependencies: `uv\.lock`/);
});

test('scope gives size, spread, tests and the largest files', () => {
  const md = render(buildLog([run('npm test')], {
    ...meta, diff: [fileDiff('services/api/src/parse.py', 40, 'added'), fileDiff('services/api/tests/test_parse.py', 20, 'added'), fileDiff('README.md', 2)].join('\n'),
  }));

  assert.match(md, /### Scope\n\+62 −0 lines · 3 files \(2 added\) · services\/api · \(root\)\nTests: 1 file changed \(1 added\) · Largest: `services\/api\/src\/parse\.py` \(40 lines\), `services\/api\/tests\/test_parse\.py` \(20 lines\)\n/);
});

test('with no diff the log still shows checks and look-here, and no scope', () => {
  const md = render(buildLog([run('npm test', 'fail', 'FAIL src/a.test.ts'), { kind: 'edit', id: 'e', at: '2026-10-03T06:59:59Z', path: '/repo/src/a.test.ts' }], meta));

  assert.match(md, /\*\*Checks \(last run\):\*\* npm test ✗/);
  assert.match(md, /### Look here/);
  assert.doesNotMatch(md, /### Scope|Never run/);
});

test('empty blocks are omitted, with no "none" lines', () => {
  const md = render(buildLog([run('npm test')], meta));

  assert.doesNotMatch(md, /### Decisions you confirmed|### Look here|### Scope|none recorded/i);
});

test('the details name what they hold, with counts', () => {
  const md = render(buildLog([run('npm test'), run('npm test'), run('ls'), run('grep -n x src')], { ...meta, diff: fileDiff('src/a.ts') }));

  assert.match(md, /<details><summary>every check \(1 distinct, 2 runs\) · every file \(1\) · 2 other commands<\/summary>/);
  assert.match(md, /\| `npm test` \| 2 \| 0 \| pass \| \d\d:\d\d \|/);
});

test('stray writes are listed inside the details', () => {
  const log = { ...buildLog([run('npm test')], { ...meta, diff: fileDiff('src/a.ts') }), strayWrites: ['notes/todo.md'] };

  assert.match(render(log), /Written during the session but not in the diff: 1 file: `notes\/todo\.md`/);
});

test('at most three confirmed decisions and three look-here items are visible', () => {
  const events: TimelineEvent[] = [];
  let diff = '';
  for (let i = 0; i < 5; i++) {
    events.push(run(`npm test -- t${i}`, 'fail', `FAIL src/t${i}.test.ts`));
    events.push({ kind: 'edit', id: `e${i}`, at: `2026-10-03T07:0${i}:00Z`, path: `/repo/src/t${i}.test.ts` });
    diff += `${fileDiff(`src/t${i}.test.ts`)}\n`;
  }
  const decisions = Array.from({ length: 6 }, (_, i) => confirmed(i === 5 ? 'Storage: answered in the session' : `Q${i}: A`));
  const md = render(buildLog(events, { ...meta, diff }, decisions));

  assert.match(md, /- \*…and 3 more in the details below\.\*/);
  assert.match(md, /- \*…and 2 more in the details below\.\*/);
  assert.match(md, /Storage: answered in the session/);
});

test('a huge PR keeps the visible part within budget and the body within maxChars', () => {
  const events: TimelineEvent[] = [];
  for (let i = 0; i < 60; i++) events.push(run(`uv run pytest tests/test_${i}.py -q`, i % 7 === 0 ? 'fail' : 'pass', `FAIL tests/test_${i}.py`));
  const diff = Array.from({ length: 400 }, (_, i) => fileDiff(i % 10 === 0 ? `.github/workflows/w${i}.yml` : `services/s${i % 9}/src/f${i}.py`, 5)).join('\n');
  const decisions = Array.from({ length: 9 }, (_, i) => confirmed(`Q${i}: A`));

  const md = render(buildLog(events, { ...meta, diff }, decisions), { maxChars: 6000 });

  assert.ok(visibleLines(md) <= VISIBLE_LINE_BUDGET, `visible part is ${visibleLines(md)} lines`);
  assert.ok(md.length <= 6000, `body is ${md.length} chars`);
  assert.ok(md.startsWith('<!-- pdl:start') && md.trimEnd().endsWith('<!-- pdl:end -->'));
});

test('a tight budget drops the details first, with a note', () => {
  const md = render(buildLog([run('npm test')], { ...meta, diff: Array.from({ length: 80 }, (_, i) => fileDiff(`src/f${i}.ts`)).join('\n') }), { maxChars: 900 });

  assert.ok(md.length <= 900, `body is ${md.length} chars`);
  assert.match(md, /truncated/i);
  assert.match(md, /\*\*Checks \(last run\):\*\*/, 'the verdict survives');
  assert.ok(md.trimEnd().endsWith('<!-- pdl:end -->'));
});

test('a path with a pipe or a backtick cannot break the table or the code span', () => {
  const md = render(buildLog([run('npm test')], { ...meta, diff: [fileDiff('src/we|ird.ts'), fileDiff('src/tick`name.ts')].join('\n') }));

  assert.match(md, /- `src\/we\\\|ird\.ts`|- `src\/we\|ird\.ts`/);
  assert.match(md, /- ``src\/tick`name\.ts``/);
});

test('raw command output never reaches the markdown', () => {
  const md = render(buildLog([run('npm test', 'fail', 'secret-output-AKIAIOSFODNN7EXAMPLE')], meta));

  assert.doesNotMatch(md, /AKIAIOSFODNN7EXAMPLE|secret-output/);
});

test('the footer says where the log came from', () => {
  assert.match(render(buildLog([run('npm test')], { ...meta, sessions: ['a', 'b'] })), /<sub>Recorded from 2 agent sessions on `feat\/x`/);
  assert.match(render(buildLog([run('npm test')], meta)), /<sub>Recorded from the agent session on `feat\/x`/);
});
```

In `test/decisions-render.test.ts`, replace the tests `'claims are rendered after the facts'`, `'a human-confirmed decision is labelled differently from a stated one'`, `'assumptions render under their own heading'`, `'open items render under their own heading'` and `'no decisions means no heading at all, which is the common case'` with:

```ts
test('confirmed decisions are visible, and stated claims are inside the details', () => {
  const md = render(buildLog([cmd], meta, [
    dec({ text: 'Base: main', source: 'human-answer', confidence: 'confirmed_by_human' }),
    dec({}),
  ]));

  assert.match(md, /### Decisions you confirmed\n- Base: main\n/);
  assert.ok(md.indexOf('#### Stated by the agent') > md.indexOf('<details>'), 'stated claims escaped the details');
  assert.match(md, /- Retry at the job level because the client is shared\. \*\(stated\)\*/);
});

test('assumptions and open items are labelled inside the stated claims', () => {
  const md = render(buildLog([cmd], meta, [dec({ kind: 'assumption', text: 'Assuming one session per PR.' }), dec({ kind: 'open_item', text: 'TODO: comment mode.' })]));

  assert.match(md, /- Assumption: Assuming one session per PR\. \*\(stated\)\*/);
  assert.match(md, /- Open item: TODO: comment mode\. \*\(stated\)\*/);
});

test('no decisions means no decision headings at all, which is the common case', () => {
  const md = render(buildLog([cmd], meta, []));

  assert.doesNotMatch(md, /Decisions you confirmed|Stated by the agent|none recorded/i);
});
```

In `test/diff-in-log.test.ts`, replace the bodies of `'an informational flag is rendered as a note, not as an accusation'` and `'a warning is not labelled as a note'` with:

```ts
// 'an informational flag is rendered as a note, not as an accusation'
  const md = render(buildLog([ran], {
    ...meta,
    diff: [
      diff('src/sum.ts', ['-  return a + b;', '+  return a + b + 1;']),
      diff('src/sum.test.ts', ['-  expect(sum(1, 2)).toBe(3);', '+  expect(sum(1, 2)).toBe(4);']),
    ].join('\n'),
  }));

  const line = md.split('\n').find((l) => l.includes('Expected value changed'));
  assert.ok(line, 'note missing from the markdown');
  assert.match(line, /\*\(note\)\*/);
  assert.ok(md.indexOf(line) > md.indexOf('<details>'), 'a note was shown above the details');
```

```ts
// 'a warning is not labelled as a note'
  const md = render(buildLog([ran], { ...meta, diff: diff('src/sum.test.ts', ["+  it.only('adds', () => {"]) }));

  const line = md.split('\n').find((l) => l.includes('Test skipped'));
  assert.ok(line && !line.includes('(note)'));
  assert.ok(md.indexOf(line) < md.indexOf('### Scope'), 'a warning was not under Look here');
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test test/render.test.ts test/decisions-render.test.ts test/diff-in-log.test.ts`
Expected: FAIL, the old renderer produces none of the new blocks.

- [ ] **Step 3: Rewrite `src/render/render.ts`**

```ts
import type { DecisionLog } from './build-log.ts';
import type { Flag, FlagCode } from '../flags/types.ts';
import type { Outcome } from '../events/types.ts';
import type { Scope } from '../review/scope.ts';
import { toolStatuses } from '../review/checks.ts';

export const MARKER_START = '<!-- pdl:start';
export const MARKER_END = '<!-- pdl:end -->';

export type RenderOptions = {
  /** Budget out of GitHub's 65,536-character body limit. */
  maxChars?: number;
  toolUrl?: string;
};

/** Spec 5: non-empty lines between the heading and the details. */
export const VISIBLE_LINE_BUDGET = 15;
const VISIBLE_ITEMS = 3;
const LISTED_PATHS = 3;
const LISTED_FILES = 100;
const LISTED_STRAY = 10;

const LABEL: Record<FlagCode, string> = {
  TEST_EDITED_AFTER_FAILURE: 'Test changed after it failed',
  NO_TEST_RUN: 'No test was run',
  TEST_ONLY_CHANGE: 'Only tests changed',
  ASSERTIONS_REMOVED: 'Assertions removed',
  TEST_SKIPPED: 'Test skipped',
  TEST_DELETED: 'Tests deleted',
  EXPECTATION_LOOSENED: 'Expected value changed',
};

/** Look-here order (spec 6.4): timeline first, then diff warnings, then no test at all. */
const WARNING_ORDER: FlagCode[] = [
  'TEST_EDITED_AFTER_FAILURE', 'TEST_SKIPPED', 'ASSERTIONS_REMOVED', 'TEST_DELETED',
  'EXPECTATION_LOOSENED', 'TEST_ONLY_CHANGE', 'NO_TEST_RUN',
];

const MARK: Record<Outcome, string> = { pass: '✓', fail: '✗ (failed, not re-run)', interrupted: '✗ (interrupted)', unknown: '?' };

const KIND_PREFIX: Record<string, string> = { decision: '', assumption: 'Assumption: ', open_item: 'Open item: ' };

/** Inline code that survives a backtick in the value. */
const code = (s: string): string => (s.includes('`') ? `\`\`${s}\`\`` : `\`${s}\``);
/** A table cell: a pipe splits the row even inside backticks, so it is escaped. */
const cell = (s: string): string => s.replace(/\|/g, '\\|');
const hhmm = (iso: string): string => /T(\d{2}:\d{2})/.exec(iso)?.[1] ?? iso;
const count = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;
const num = (n: number): string => n.toLocaleString('en-US');
const paths = (list: string[], max = LISTED_PATHS): string =>
  list.slice(0, max).map(code).join(', ') + (list.length > max ? ` +${list.length - max} more` : '');

function flagLine(f: Flag, note = false): string {
  const where = f.file ? ` ${code(f.file)}` : '';
  return `- **${LABEL[f.code]}**${note ? ' *(note)*' : ''}${where}: ${f.detail}`;
}

function checksLine(log: DecisionLog): string {
  const tools = toolStatuses(log.checks);
  if (tools.length === 0) return '**Checks:** none were run.';
  return `**Checks (last run):** ${tools.map((t) => `${t.tool} ${MARK[t.status]}`).join(' · ')}`;
}

function contextLine(log: DecisionLog): string {
  const never = log.neverRun.map((x) => `${x.check} (${x.because})`).join(' · ');
  return `${never ? `**Never run:** ${never} · ` : ''}Intent: see the PR description.`;
}

function lookHere(log: DecisionLog): string[] {
  const warnings = log.flags.filter((f) => f.severity === 'warn');
  const items = WARNING_ORDER.flatMap((c) => warnings.filter((f) => f.code === c).map((f) => flagLine(f)));
  if (log.risky.length > 0) {
    items.push(`- **Privileged or risky files:** ${log.risky.map((g) => `${g.category.toLowerCase()}: ${paths(g.paths)}`).join(' · ')}`);
  }
  return items;
}

function scopeLines(s: Scope): string[] {
  const statuses = [
    s.created ? `${s.created} added` : '', s.deleted ? `${s.deleted} deleted` : '', s.renamed ? `${s.renamed} renamed` : '',
  ].filter(Boolean);
  const areas = s.areas.join(' · ') + (s.moreAreas > 0 ? ` +${s.moreAreas} more` : '');
  const first = `+${num(s.added)} −${num(s.removed)} lines · ${count(s.files, 'file')}`
    + (statuses.length ? ` (${statuses.join(', ')})` : '') + (areas ? ` · ${areas}` : '');
  const second = [
    s.testsChanged > 0 ? `Tests: ${count(s.testsChanged, 'file')} changed${s.testsAdded ? ` (${s.testsAdded} added)` : ''}` : '',
    s.largest.length > 0 ? `Largest: ${s.largest.map((l) => `${code(l.path)} (${num(l.lines)} lines)`).join(', ')}` : '',
  ].filter(Boolean).join(' · ');
  return second ? [first, second] : [first];
}

/** The first few items, then a pointer to the rest in the details. */
function capped(items: string[]): string[] {
  if (items.length <= VISIBLE_ITEMS) return items;
  return [...items.slice(0, VISIBLE_ITEMS), `- *…and ${items.length - VISIBLE_ITEMS} more in the details below.*`];
}

function details(log: DecisionLog, moreLook: string[], moreConfirmed: string[]): string {
  const parts: string[] = [];
  const summary: string[] = [];
  const checks = log.checks.filter((c) => !c.fixer);
  const fixers = log.checks.filter((c) => c.fixer);

  if (checks.length > 0) {
    const rows = checks.map((c) => `| ${cell(code(c.command))} | ${c.runs} | ${c.failures} | ${c.last} | ${hhmm(c.lastAt)} |`);
    parts.push(`#### Checks\n\n| Check | Runs | Failures | Last result | Last run |\n| --- | --- | --- | --- | --- |\n${rows.join('\n')}`);
    summary.push(`every check (${checks.length} distinct, ${checks.reduce((n, c) => n + c.runs, 0)} runs)`);
  }
  if (fixers.length > 0) parts.push(`Auto-fixes: ${fixers.map((c) => `${code(c.command)}${c.runs > 1 ? ` (${c.runs})` : ''}`).join(', ')}`);
  if (moreLook.length > 0) {
    parts.push(`#### More to look at\n${moreLook.join('\n')}`);
    summary.push(`more to look at (${moreLook.length})`);
  }
  if (moreConfirmed.length > 0) parts.push(`#### More decisions you confirmed\n${moreConfirmed.join('\n')}`);

  const notes = log.flags.filter((f) => f.severity === 'info');
  if (notes.length > 0) {
    parts.push(`#### Notes\n${notes.map((f) => flagLine(f, true)).join('\n')}`);
    summary.push(`notes (${notes.length})`);
  }

  const stated = log.decisions.filter((d) => d.confidence !== 'confirmed_by_human');
  if (stated.length > 0) {
    parts.push(`#### Stated by the agent\n${stated.map((d) => `- ${KIND_PREFIX[d.kind] ?? ''}${d.text} *(stated)*`).join('\n')}`);
    summary.push(`stated by the agent (${stated.length})`);
  }

  const files = log.changes.filter((c) => c.status !== 'not in diff');
  if (files.length > 0) {
    const rows = files.slice(0, LISTED_FILES).map((c) => {
      const tags = [...(c.status && c.status !== 'modified' ? [c.status] : []), ...(c.role === 'test' ? ['test'] : [])];
      return `- ${code(cell(c.file))}${tags.length ? ` (${tags.join(', ')})` : ''}`;
    });
    const rest = files.length - LISTED_FILES;
    parts.push(`#### Files\n${rows.join('\n')}${rest > 0 ? `\n\n*and ${count(rest, 'more file')}.*` : ''}`);
    summary.push(`every file (${files.length})`);
  }
  if (log.strayWrites.length > 0) {
    parts.push(`Written during the session but not in the diff: ${count(log.strayWrites.length, 'file')}: ${paths(log.strayWrites, LISTED_STRAY)}`);
  }
  if (log.otherCommands > 0) {
    parts.push(`${count(log.otherCommands, 'other command')} (file writes, searches, git) not listed.`);
    summary.push(count(log.otherCommands, 'other command'));
  }

  if (parts.length === 0) return '';
  return `\n<details><summary>${summary.join(' · ') || 'details'}</summary>\n\n${parts.join('\n\n')}\n\n</details>\n`;
}

/**
 * Render the log for a reviewer (spec docs/superpowers/specs/2026-10-14-reviewer-first-log-design.md).
 *
 * The visible part answers, in order: did the checks pass, what was never
 * checked, what the human decided, where to look, and how big the change is.
 * Every block is left out when it has nothing to say, and everything else
 * is collapsed, since more bot output measurably slows review.
 */
export function render(log: DecisionLog, options: RenderOptions = {}): string {
  const max = options.maxChars ?? 12_000;
  const tool = options.toolUrl ?? 'https://github.com/GcdZ03/pr-decision-log';

  const header = `${MARKER_START} v=1 sha=${log.repo.headSha ?? 'unknown'} -->\n## Decision log\n`;
  const from = log.sessions.length > 1 ? `${log.sessions.length} agent sessions` : 'the agent session';
  const footer = `\n<sub>Recorded from ${from} on ${code(log.branch)}: observed from tool events, not the model's own account. [What this is](${tool}) · Redaction: ${count(log.redaction.hits, 'rule')} applied.</sub>\n${MARKER_END}\n`;

  const look = lookHere(log);
  const confirmed = log.decisions.filter((d) => d.confidence === 'confirmed_by_human').map((d) => `- ${d.text}`);

  const visible = [`\n${checksLine(log)}\n${contextLine(log)}\n`];
  if (confirmed.length > 0) visible.push(`\n### Decisions you confirmed\n${capped(confirmed).join('\n')}\n`);
  if (look.length > 0) visible.push(`\n### Look here\n${capped(look).join('\n')}\n`);
  if (log.scope) visible.push(`\n### Scope\n${scopeLines(log.scope).join('\n')}\n`);

  const full = header + visible.join('') + details(log, look.slice(VISIBLE_ITEMS), confirmed.slice(VISIBLE_ITEMS)) + footer;
  if (full.length <= max) return full;

  // Over budget: the details go first, then visible blocks from the end.
  // The verdict line and both markers always survive.
  const note = '\n*Log truncated to fit the PR body budget; details omitted.*\n';
  for (let keep = visible.length; keep >= 1; keep--) {
    const body = header + visible.slice(0, keep).join('') + note + footer;
    if (body.length <= max) return body;
  }
  const minimal = header + `\n${checksLine(log)}\n` + note + MARKER_END + '\n';
  if (minimal.length <= max) return minimal;
  return `${header.slice(0, Math.max(0, max - MARKER_END.length - 1))}\n${MARKER_END}\n`;
}
```

- [ ] **Step 4: Run the suites**

Run: `npx tsc --noEmit && node --test test/render.test.ts test/decisions-render.test.ts test/diff-in-log.test.ts`
Expected: PASS. In the pipe/backtick test the regex accepts either an escaped or a plain pipe inside a list item; the table path is covered by the `cell` call.

- [ ] **Step 5: Run the whole suite and fix wording assertions elsewhere**

Run: `npm test`
Expected: PASS. Tests outside these three files that grep the old headings (`### Verification`, `### Changes`, `### Flags`, `### Decisions`) must be updated to the new headings, keeping what they assert: list them with `grep -rln "### Verification\|### Changes\|### Flags" test/` and update each assertion to the equivalent new block.

- [ ] **Step 6: Commit**

```bash
npm run build
git add src/render/render.ts test/render.test.ts test/decisions-render.test.ts test/diff-in-log.test.ts test dist/pdl.js
git commit -m "feat: reviewer-first log layout

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 10: Golden test

**Files:**
- Create: `test/golden-log.test.ts`, `test/fixtures/golden-log.md`

**Interfaces:**
- Consumes: `buildLog`, `render`.

- [ ] **Step 1: Write the test** (`test/golden-log.test.ts`)

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { buildLog } from '../src/render/build-log.ts';
import { render } from '../src/render/render.ts';
import type { TimelineEvent } from '../src/events/types.ts';

// One fixed session and diff, rendered to exact markdown. A layout change
// shows up as a diff of this file in review, rather than as prose. To accept
// a deliberate change: PDL_UPDATE_GOLDEN=1 node --test test/golden-log.test.ts
const GOLDEN = new URL('./fixtures/golden-log.md', import.meta.url);

const events: TimelineEvent[] = [
  { kind: 'command', id: 'c1', at: '2026-10-03T06:17:00Z', command: 'cd /repo && uv run pytest services/api -q', classification: 'test', outcome: 'pass' },
  { kind: 'command', id: 'c2', at: '2026-10-03T06:18:32Z', command: 'uv run pytest services/api/tests/test_parsing.py -q 2>&1 | tail', classification: 'test', outcome: 'fail', output: 'FAILED services/api/tests/test_parsing.py::test_csv' },
  { kind: 'command', id: 'w1', at: '2026-10-03T06:18:40Z', command: "python3 - <<'EOF'\nx\nEOF", classification: 'other', outcome: 'pass', writes: [{ path: '/repo/services/api/tests/test_parsing.py' }] },
  { kind: 'command', id: 'c3', at: '2026-10-03T06:18:55Z', command: 'uv run pytest services/api/tests/test_parsing.py -q', classification: 'test', outcome: 'pass' },
  { kind: 'command', id: 'c4', at: '2026-10-03T06:20:00Z', command: 'uv run ruff check --fix .', classification: 'lint', outcome: 'pass' },
  { kind: 'command', id: 'c5', at: '2026-10-03T06:21:00Z', command: 'pnpm --filter @app/web test', classification: 'test', outcome: 'pass' },
  { kind: 'command', id: 'c6', at: '2026-10-03T06:22:00Z', command: 'ls -la', classification: 'other', outcome: 'pass' },
];

const file = (path: string, added: number, isNew = false) => [
  `diff --git a/${path} b/${path}`, ...(isNew ? ['new file mode 100644', '--- /dev/null'] : [`--- a/${path}`]), `+++ b/${path}`,
  '@@ -1 +1 @@', ...Array.from({ length: added }, (_, i) => `+l${i}`),
].join('\n');

const diff = [
  file('services/api/src/parsing.py', 41, true),
  file('services/api/tests/test_parsing.py', 27, true),
  file('services/api/Dockerfile', 2),
  file('apps/web/src/lib/imports.ts', 26, true),
  file('.github/workflows/ci.yml', 3),
  file('uv.lock', 12),
].join('\n');

test('a fixed session renders to the golden markdown', () => {
  const md = render(buildLog(events, {
    repo: 'github.com/acme/app', branch: 'feat/imports', headSha: 'abc1234', generatedAt: '2026-10-03T07:00:00Z',
    repoRoot: '/repo', diff, sessions: ['s1'],
  }, [{ text: 'Upload storage: Local volume', kind: 'decision', source: 'human-answer', confidence: 'confirmed_by_human' }]));

  if (process.env['PDL_UPDATE_GOLDEN'] === '1') writeFileSync(GOLDEN, md);
  assert.equal(md, readFileSync(GOLDEN, 'utf8'));
});
```

- [ ] **Step 2: Generate the golden file and read it as a reviewer**

Run: `PDL_UPDATE_GOLDEN=1 node --test test/golden-log.test.ts && cat test/fixtures/golden-log.md`

Check by eye, and fix the code (not the golden file) if any is false:
- Line 1 under the heading: `**Checks (last run):** pytest ✓ · pnpm test ✓` (ruff is a fixer, so it is absent).
- Line 2: `**Never run:** docker build (a Docker file changed) · Intent: see the PR description.`
- `### Decisions you confirmed` then `- Upload storage: Local volume`.
- `### Look here`: the test-edit flag on `services/api/tests/test_parsing.py` reading `` `uv run pytest services/api/tests/test_parsing.py -q` failed at 06:18; the test was written from the shell 8 s later; it passed at 06:18. ``, then the risky bullet naming the workflow and `uv.lock`.
- `### Scope`: `+111 −0 lines · 6 files (3 added) · services/api · apps/web · (root) · .github` (areas by lines changed: 70, 26, 12, 3), then `Tests: 1 file changed (1 added) · Largest: …parsing.py (41 lines), …test_parsing.py (27 lines)`.
- At most 15 non-empty lines before `<details>`.

- [ ] **Step 3: Run without the update flag**

Run: `node --test test/golden-log.test.ts`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add test/golden-log.test.ts test/fixtures/golden-log.md
git commit -m "test: golden markdown for the reviewer-first log

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 11: Prompts shown locally by `pdl show`

**Files:**
- Modify: `src/extract/transcript.ts` (add `isMeta` to `TranscriptEntry`, add `userPrompts`)
- Modify: `src/pdl.ts` (`show`, `printTimeline` callers)
- Test: `test/transcript.test.ts`, `test/cli.test.ts`

**Interfaces:**
- Produces: `export function userPrompts(entries: TranscriptEntry[]): { at?: string; text: string }[]`.

- [ ] **Step 1: Write the failing tests**

Append to `test/transcript.test.ts` (import `userPrompts`):

```ts
test('user prompts are the human turns, not tool results, meta entries, commands or subagents', () => {
  const prompts = userPrompts([
    { type: 'user', timestamp: '2026-10-03T06:00:00Z', message: { role: 'user', content: 'Add CSV import\nwith a preview' } },
    { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: 'ok' }] } },
    { type: 'user', isMeta: true, message: { role: 'user', content: 'Caveat: meta' } },
    { type: 'user', message: { role: 'user', content: '<command-name>/clear</command-name>' } },
    { type: 'user', isSidechain: true, message: { role: 'user', content: 'subagent prompt' } },
    { type: 'user', timestamp: '2026-10-03T06:05:00Z', message: { role: 'user', content: [{ type: 'text', text: 'now the upload UI' }] } },
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'sure' }] } },
  ]);

  assert.deepEqual(prompts, [
    { at: '2026-10-03T06:00:00Z', text: 'Add CSV import\nwith a preview' },
    { at: '2026-10-03T06:05:00Z', text: 'now the upload UI' },
  ]);
});
```

Append to `test/cli.test.ts`, inside a new test using the existing `withRepo` helper (its store has session `sess-cli-1`, but no transcript; this test writes one and a turn pointing at it):

```ts
test('pdl show lists the prompts locally and says they are never published', () => {
  withRepo(({ repo, run }) => {
    const transcript = join(repo, '..', 'transcript.jsonl');
    writeFileSync(transcript, `${JSON.stringify({ type: 'user', timestamp: '2026-09-26T10:00:30.000Z', message: { role: 'user', content: 'fix the flaky test' } })}\n`);
    const turns = join(repo, '..', 'store', 'turns.jsonl');
    const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: repo, encoding: 'utf8' }).trim();
    writeFileSync(turns, `${JSON.stringify({ session: 'sess-cli-1', repo: root, branch: 'feat', at: '2026-09-26T10:01:00.000Z', transcript })}\n`);

    const r = run('show');

    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /Prompts \(local only, never published\)/);
    assert.match(r.out, /10:00 {2}fix the flaky test/);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test test/transcript.test.ts test/cli.test.ts`
Expected: FAIL, `userPrompts` is not exported and `show` prints no prompts.

- [ ] **Step 3: Implement `userPrompts`** (in `src/extract/transcript.ts`)

Add `isMeta?: boolean;` to `TranscriptEntry`, then:

```ts
/**
 * What the human typed, for `pdl show` only. Never published: the log's
 * rule is that nothing the human wrote reaches GitHub. Tool results, meta
 * entries, slash-command wrappers and subagent prompts are not prompts.
 */
export function userPrompts(entries: TranscriptEntry[]): { at?: string; text: string }[] {
  const out: { at?: string; text: string }[] = [];
  for (const e of entries) {
    if (e.type !== 'user' || e.isMeta || e.isSidechain) continue;
    const c = e.message?.content;
    const text = typeof c === 'string'
      ? c
      : Array.isArray(c) && c.every((b) => (b as ContentBlock).type === 'text')
        ? c.map((b) => (b as ContentBlock).text ?? '').join('\n')
        : '';
    if (!text.trim() || text.trimStart().startsWith('<')) continue;
    out.push({ ...(e.timestamp ? { at: e.timestamp } : {}), text });
  }
  return out;
}
```

(`ContentBlock` is already exported from this file; confirm it has an optional `text` field, and add `text?: string` to it if not.)

- [ ] **Step 4: Print them in `pdl show`** (in `src/pdl.ts`)

Import `userPrompts` and `readTranscript` (already imported) and `findTranscript` (already imported). Add:

```ts
/** The human's prompts beside the timeline, for the author's eyes only. */
function printPrompts(transcripts: (string | undefined)[]): void {
  const prompts = transcripts.flatMap((t) => (t ? userPrompts(readTranscript(t)) : []));
  if (prompts.length === 0) return;
  process.stdout.write('\n  Prompts (local only, never published):\n');
  for (const p of prompts) {
    const first = p.text.split('\n')[0]?.slice(0, 120) ?? '';
    process.stdout.write(`  ${p.at ? /T(\d{2}:\d{2})/.exec(p.at)?.[1] ?? '' : '     '}  ${first}\n`);
  }
}
```

At the end of `show`, after each `printTimeline(...)` call:
- single-session branch: `printPrompts([findTranscript(sessionId)]);`
- branch view: `printPrompts(merged.sessions.map((s) => merged.transcripts.get(s) ?? findTranscript(s)));`

- [ ] **Step 5: Run the suites**

Run: `npx tsc --noEmit && node --test test/transcript.test.ts test/cli.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
npm run build
git add src/extract/transcript.ts src/pdl.ts test/transcript.test.ts test/cli.test.ts dist/pdl.js
git commit -m "feat: pdl show lists the session's prompts locally, never published

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 12: Real-data check, docs and the 0.1.6 bump

**Files:**
- Modify: `README.md` (example log, "What gets published" table, `pdl show` row), `docs/DESIGN.md` (dated update note)
- Modify: `package.json`, `package-lock.json`, `.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json`

- [ ] **Step 1: Re-render the stored sessions and compare**

Run (from the repo root):

```bash
node --input-type=module -e '
import { EventStore } from "./src/events/store.ts";
import { buildLog } from "./src/render/build-log.ts";
import { render } from "./src/render/render.ts";
const store = new EventStore(process.env.HOME + "/.local/share/pdl");
for (const s of store.sessionsInfo()) {
  const md = render(buildLog(store.read(s.id), { repo: "x", branch: "b" }));
  const start = md.indexOf("## Decision log"), end = md.includes("<details>") ? md.indexOf("<details>") : md.indexOf("<sub>");
  const visible = md.slice(start, end).split("\n").filter((l) => l.trim()).length - 1;
  console.log(s.id.slice(0, 8), "visible lines:", visible, "total chars:", md.length,
    /\/Users|\/private|<<|EOF/.test(md) ? "LEAK?" : "ok");
}'
```

Expected: every session `visible lines` ≤ 15 and `ok`. Any `LEAK?` stops the release: find which block printed it and fix that block with a test first. Record the before/after visible line counts for the largest session in the DESIGN note (Step 3).

- [ ] **Step 2: Update the README**

- Replace the example under "What a published log looks like" with the output of the golden test (`test/fixtures/golden-log.md`) and change its lead-in to: `Rendered from a fixed example session (the repository's golden test), so the layout here is exactly what pdl produces:`.
- In "What gets published, and what does not", add the row: `| Tool names and pass/fail per check, risky-file categories, line and file counts | Which commands were run to get there, beyond the runner fragment |`.
- In the Commands table, change the `pdl show` row to: `| \`pdl show [session]\` | Print the recorded timeline, any flags and, locally only, the session's prompts: the current branch's, or one session's |`.

- [ ] **Step 3: Add the DESIGN note**

Append under the 0.1.5 update in `docs/DESIGN.md`:

```markdown
> **Update, 14 Oct 2026 (0.1.6).** The log is laid out for a reviewer, per `docs/superpowers/specs/2026-10-14-reviewer-first-log-design.md`: a Checks line (per tool, last result, fixers apart), a Never-run line, decisions the human confirmed, Look here (warnings and privileged or risky files), Scope (lines, files, areas, tests, largest), and everything else collapsed. Answers the human typed are never published. `pdl show` lists prompts locally. Re-rendered over the stored sessions, the largest log's visible part went from <BEFORE> to <AFTER> lines.
```

Replace `<BEFORE>` and `<AFTER>` with the numbers measured in Step 1 (before: run the same script on `git stash`-ed main, or count the 0.1.5 output's lines above the first `### Changes`).

- [ ] **Step 4: Bump the version to 0.1.6**

```bash
npm version 0.1.6 --no-git-tag-version
sed -i '' 's/"version": "0.1.5"/"version": "0.1.6"/' .claude-plugin/plugin.json .claude-plugin/marketplace.json
grep -rn '"0.1.5"' package.json .claude-plugin   # expect no output
```

- [ ] **Step 5: Full verification**

Run: `npm run build && npm run typecheck && npm test && npm pack --dry-run 2>&1 | grep -E "version:|total files"`
Expected: all tests pass; `version: 0.1.6`; `total files: 7`.

- [ ] **Step 6: Commit (two commits: docs, then the release)**

```bash
git add README.md docs/DESIGN.md dist/pdl.js
git commit -m "docs: README and DESIGN describe the reviewer-first log

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
git add package.json package-lock.json .claude-plugin/plugin.json .claude-plugin/marketplace.json
git commit -m "release: 0.1.6

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

Publishing (`npm publish`) is the author's to run, in a normal terminal, after `npm login` if `npm whoami` fails.
