# Reviewer-first decision log

Date: 2026-10-14. Status: design, awaiting review. Target release: 0.1.6, together with the free-text answer fix.

## 1. Why

The 0.1.5 log is accurate but laid out as a recording: a chronological table of every test, build and lint run (28 rows on a real 55-file PR), then a file list that repeats GitHub's Files tab, cut off at 30. The one flag that needed a human was at the top, but nothing told a reader whether the change was ready, what had never been checked, or what the human had decided.

This redesign answers, in order, the questions a reviewer asks before approving.

## 2. Readers and success

- **The author** who ran the agent: knows the intent, did not watch every step.
- **A teammate reviewer**: no context beyond the PR.

Success: either reader can decide in under 30 seconds whether to merge, and knows the one or two places to open first. Everything else is one click away, collapsed.

## 3. Evidence behind the design

From the research pass of 2026-10-14 (sources fetched through summaries, not read in full; numbers below are from those summaries):

| Finding | Source | Design consequence |
| --- | --- | --- |
| CI and test failures are a top reason agent PRs are rejected | arXiv 2601.15195, 2606.13468 | Verification status first, per check, with no overclaiming |
| 33.1% of rejected agent PRs lacked observable decision rationale | arXiv 2605.22534 | Decisions the human confirmed go second |
| Workflows can be privileged; inspect them before approving agent PRs | GitHub docs, reviewing Copilot PRs | A risky-files line, only when one is present |
| Larger PRs that touch more files are rejected more | arXiv 2601.15195; SmartBear/Cisco 200-400 LOC (vendor) | Size and spread in one line |
| More bot output went with slower resolution and lower feedback quality (7,416 comments, 4,532 agent PRs) | arXiv 2604.24450 | One compact section; no empty headings; detail collapsed |
| Verbosity correlated with rejection more than security content did | arXiv 2601.00477 | A hard line budget for the visible part |
| Google's bar: approve when the change improves code health, even if imperfect | google.github.io/eng-practices | Help the reviewer decide; do not try to prove perfection |

## 4. Decisions already made

- **What the human typed is never published.** No prompt excerpts, by default or by option (chosen over an opt-in setting: a mis-copied config would leak irreversibly, and nobody has asked for it). Intent comes from the PR description.
- **No model-written summary** by default, as before.
- **No remote CI polling.** GitHub's merge box shows CI; polling would add a network call per turn.
- **No task-list checkboxes.** Ticks are body edits that the next publish would overwrite, and every flag would read as a mandatory chore.
- **No narrative prose.** Phase detection would be guesswork, and fluent text reads as model self-report.

## 5. The layout

Visible part, top to bottom. Every block is omitted when it has nothing to say; no "none" lines.

```markdown
## Decision log
**Checks (last run):** pytest ✓ · vitest ✓ · playwright ✓ · tsc ✓ · ruff ✓
**Never run:** docker build (a Dockerfile changed) · Intent: see the PR description.

### Decisions you confirmed
- Upload storage: Local volume

### Look here
- `services/api/tests/test_parsing.py`: **test rewritten after it failed.**
  `uv run pytest services/api/tests/test_parsing.py -q` failed 06:18 UTC; written from the shell 8 s later; passed 06:18.
- **Privileged or risky files:** `.github/workflows/ci.yml` · migrations (2 added) · lockfiles: `uv.lock`, `pnpm-lock.yaml`

### Scope
+2,940 −120 lines · 55 files (31 added, 1 deleted) · services/api · apps/web · packages/types · .github
Tests: 4 files changed (3 added). Largest: `services/api/src/parsing.py` (+410), `apps/web/src/lib/imports.ts` (+260)

<details><summary>Every check (16 distinct, 28 runs) · notes (2) · every file (55) · 73 other commands</summary>

…tables described in section 6.6…
</details>
```

Paths and values in this example are illustrative.

Visible budget: at most 15 lines between the heading and `<details>`, enforced by a test. When over budget, Look here keeps its first three items and says how many more are inside the details.

## 6. Blocks

### 6.1 Checks line

- A **check** is a distinct runner fragment (`uv run pytest services/api -q` and `uv run pytest -q` are different checks). Kinds: test, build, lint, as today.
- A check's **status** is its last run's outcome. A check that failed and was never run again shows `✗ (failed, not re-run)`.
- The line groups checks by **tool**: the runner's name after launchers and wrappers (`pytest`, `vitest`, `playwright`, `jest`, `go test`, `cargo test`, `tsc`, `ruff`, `eslint`, `prettier`, `just test`, ...). A tool shows ✓ only when the last run of **every** check under it passed, ✗ when any check's last run failed.
- **Fixers are not checks.** A lint run with a write flag (`--fix`, `--write`, `format`, `-w`) is listed in the details as an auto-fix, never on the Checks line and never as "pass".
- With no checks at all, the line reads `**Checks:** none were run.` and `NO_TEST_RUN` appears under Look here.

### 6.2 Never run

Fires only when the PR diff matches a rule **and** no command of the matching kind ran in the sessions behind the log. Initial rules, deliberately few:

| Diff touches | Satisfied by a run of |
| --- | --- |
| `Dockerfile*`, `*.dockerfile`, `docker-compose*.yml`, `compose*.yml` | `docker build`, `docker compose build`, `docker buildx build` |
| Files under `migrations/`, `alembic/versions/`, `prisma/migrations/`, `db/migrate/` | a migrate command: `alembic upgrade`, `prisma migrate`, `rails db:migrate`, `manage.py migrate`, `just migrate`, `make migrate` |
Tests are not a row here: no test run at all is already the `NO_TEST_RUN` warning under Look here (6.4), and listing it twice would be the noise section 3 warns about.

Each rule is a named entry with its own tests; adding one later is a one-entry change.

### 6.3 Decisions you confirmed

- Questions the human answered, as `<header or question>: <answer>`.
- **Privacy fix included:** an answer is published only when it equals one of the option labels the question offered. A free-text answer ("Other") renders as `<header>: answered in the session` with no text. Today the answer is published verbatim whatever it is; that breaks section 4's first rule.
- Stated decisions, assumptions and open items (the `(stated)` claims, about two useful in three) move into the details.

### 6.4 Look here

In this order, each a single bullet, warnings only:

1. Timeline flags (`TEST_EDITED_AFTER_FAILURE`), rewritten to read: what failed and when, how the test was changed (with the Edit tool, or written from the shell), how long after, and whether it then passed. Times as `HH:MM UTC`; seconds only for the gap.
2. Diff warnings (`TEST_SKIPPED`, corroborated `ASSERTIONS_REMOVED` / `TEST_DELETED`).
3. `NO_TEST_RUN`.
4. **Privileged or risky files**, one bullet, grouped, only categories present:

| Category | Paths |
| --- | --- |
| CI and automation | `.github/workflows/**`, `.github/actions/**`, `.gitlab-ci.yml`, `.circleci/**` |
| Ownership and policy | `CODEOWNERS`, `.github/CODEOWNERS`, `SECURITY.md` |
| Migrations | the migration paths of section 6.2 |
| Dependencies | lockfiles: `package-lock.json`, `pnpm-lock.yaml`, `yarn.lock`, `bun.lockb`, `uv.lock`, `poetry.lock`, `Pipfile.lock`, `Cargo.lock`, `go.sum`, `Gemfile.lock`, `Package.resolved` |
| Secrets and environment | `.env*` (not `.env.example`), `*.pem`, `*.key`, `secrets/**` |
| Auth | a path segment `auth`, `authn`, `authz`, `security`, `permissions` or `iam` |

Diff notes (`EXPECTATION_LOOSENED`, uncorroborated removals) are informational and move into the details; they are counted in the `<summary>` line.

### 6.5 Scope

- `+added −removed lines · N files (A added, D deleted, R renamed)` from the diff.
- **Areas**: each changed path's first segment, or first two when the first is a monorepo container (`apps`, `packages`, `services`, `libs`, `crates`, `cmd`, `internal`); at most six, by lines changed, then `+N more`.
- `Tests: N files changed (M added)`, using the existing `isTestFile`.
- **Largest**: the two files with the most changed lines, excluding lockfiles and files git marks as generated or binary.

### 6.6 Details (collapsed)

- **Checks**: one row per distinct check: `Check | Runs | Failures | Last result | Last run`. Auto-fixes listed below the table by tool.
- **Notes**: informational diff flags.
- **Stated by the agent**: stated decisions, assumptions, open items, labelled `(stated)` as today.
- **Files**: every file in the diff with status and test role (no edit counts: they meant nothing to reviewers). Then one line: `Written during the session but not in the diff: N file(s)`, listing up to 10 paths, counting only paths inside the repository that git does not ignore.
- **Other commands**: the count only, as today.

The `<summary>` line names what is inside with counts, so a reader knows whether opening it is worth it.

## 7. Data and code changes

- **No new recording.** Everything comes from events, the diff and the transcript already recorded. The hook path is untouched.
- `buildLog` gains derived fields: `checks` (per distinct fragment: kind, tool, runs, failures, last outcome, last time, fixer), `neverRun`, `risky` (category to paths), `scope` (lines, counts, areas, tests, largest), `strayWrites`. `verification` stays for `decision-log.json` compatibility. The schema stays `pdl/1`: fields are added, none removed.
- Diff parsing gains per-file added and removed line counts and git's binary marker (`Binary files ... differ`).
- `strayWrites` needs "not ignored by git": `logMeta` runs one `git check-ignore --stdin` over the candidates in the target working tree. That is the only new git call, made at build time.
- `render.ts` is rewritten around the blocks above; the truncation logic keeps its contract (markers survive, least important content dropped first: details before visible blocks).
- The decision extractor keeps the question's option labels so section 6.3's check can run.

## 8. Privacy

Unchanged rules, one fix. Published: runner fragments, repo-relative paths, counts, tool names, option labels the human picked. Never: prompts, free-text answers, raw commands, file contents, absolute paths. The free-text answer fix (6.3) closes the one existing leak found while writing this spec.

## 9. Testing

- Unit tests per block: tool grouping, last-run status, failed-not-re-run, fixer detection, each never-run rule, each risky category, area grouping, largest-file exclusions, free-text answer suppression, empty blocks omitted.
- A golden test: a fixed set of events plus diff renders to an exact expected markdown, so layout changes are reviewed as diffs.
- The visible-budget test: at most 15 lines before `<details>`.
- A real-data check before release: re-render the logs of the stored sessions and of one public example, and read them as a reviewer would. Record the before/after line counts in the release notes.

## 10. Out of scope

Remote CI status; CODEOWNERS reviewer resolution; model summaries; prompt excerpts; task-list checkboxes; per-commit update sections (roadmap Phase 2 item, unchanged).
