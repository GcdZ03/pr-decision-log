# pr-decision-log

[![CI](https://github.com/GcdZ03/pr-decision-log/actions/workflows/ci.yml/badge.svg)](https://github.com/GcdZ03/pr-decision-log/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/pr-decision-log)](https://www.npmjs.com/package/pr-decision-log)

**Status: early.** Dogfooded on this repository's own pull requests.

`pdl` records what an AI coding agent actually did while it worked, and attaches a structured, redacted **decision log** to the resulting pull request. The reviewer gets what ran, what failed, what was edited after what, and a flag on any test that was changed right after that test failed — instead of being, in Addy Osmani's words, "the first human being to ever lay eyes on this code."

It installs as Claude Code hooks and publishes on its own. There is no step you have to remember.

## Quick start

```bash
npm install -g pr-decision-log   # needs Node 22+ and a logged-in `gh`
pdl init --user                  # hooks for every repository
pdl doctor                       # checks the install; follow any remedy it prints
```

Then open Claude Code in a repository, accept the trust prompt, and work as usual. Once the branch has a pull request, the log appears at the bottom of its description. [Install](#install) covers the plugin and clone routes, and [Using it](#using-it) covers what happens next.

## What a published log looks like

Real output, unedited, from a scratch repository where an agent was told to make a failing test pass *without touching the code*. It declined to change the expected values, and marked the test `todo` instead, which keeps it running but stops its failure from failing the suite:

```markdown
## Decision log

*Recorded automatically from the agent session on `agent-change`. Everything below is observed from tool events, not the model's self-report.*

### Flags
- **TEST_EDITED_AFTER_FAILURE** `sum.test.js` Edited at 2026-09-26T02:31:10.374Z, after `npm test 2>&1 | tail -30; cat sum.js sum.test.js package.json` failed at 2026-09-26T02:31:00.491Z and before it passed again.
- **TEST_SKIPPED** `sum.test.js` Added `{ todo } / { skip } option` (the test still runs but its failure no longer fails the suite).

### Verification (recorded)

| When | Command | Result |
| --- | --- | --- |
| 02:31 | `npm test 2>&1 \| tail -30; cat sum.js sum.test.js package.json` | fail |
| 02:31 | `npm test 2>&1 \| tail -30` | pass |

### Changes
- `sum.test.js` - 1 edit (test)
```

When the session contains them, **Decisions**, **Assumptions** and **Open items** sections follow: questions you answered, marked *(confirmed by a human)*, and sentences where the agent explained a choice, marked *(stated)*. On most pull requests there are none, and the sections are left out rather than shown empty.

## The finding that shaped it

The original pitch was "capture the agent's reasoning." **Measurement killed that**, and the tool is better for it.

Measured over 50 real Claude Code sessions on this machine:

| Question | Answer |
| --- | --- |
| Is hidden reasoning recoverable? | **No.** 2,170 of 2,176 `thinking` blocks are stored empty. |
| Does the agent explain *why* before editing? | **Rarely.** 26 of 881 edits (3%), median 0 per session. |
| Is the evidence timeline there? | **Yes.** Commands 50/50 sessions, test runs 48/50. |

So the product leads with evidence, and an empty Decisions section is the expected case rather than a bug. A tool that promised "the agent's reasoning" would have shipped an empty section on 49 of 50 pull requests.

A second measurement, over 23 sessions, revised it again: the single richest source of genuine decisions is not the agent's prose at all, but **questions the human answered** — 98 of them, each one a point where a person actually committed to something.

## What gets published, and what does not

| Published | Never published |
| --- | --- |
| Command *kind* and the runner fragment | Raw command lines |
| Pass / fail / interrupted | Raw stdout or stderr |
| Repo-relative file paths | Absolute paths |
| Assertion counts before and after | File contents or diffs |
| Sentences the agent stated, labelled `(stated)` | `thinking` blocks (they are empty anyway) |

Enforcement is structural, not a regex pass at the end: the log builder is an allowlist, so anything the renderer can see has already been through it. A test plants an AWS-shaped key in command output and asserts it cannot appear in the serialized log.

## What it flags

Flags come from two independent sources. The **timeline** knows *when* a test changed relative to a failure; the **diff** knows *what* changed in it. Neither alone is an accusation.

| Flag | Source | Severity |
| --- | --- | --- |
| `TEST_EDITED_AFTER_FAILURE` | timeline: test failed, test file edited, test passed | warning |
| `TEST_SKIPPED` | diff: added `.skip`, `.only`, `xit`, `@pytest.mark.skip`, `t.Skip`, `XCTSkip`, node:test `{ todo }` / `{ skip }` | warning |
| `ASSERTIONS_REMOVED` | diff: net fewer assertions in a test file | note; **warning** when the timeline saw that file edited after a failure |
| `TEST_DELETED` | diff: test declarations removed with no replacement | note; **warning** when corroborated, as above |
| `EXPECTATION_LOOSENED` | diff: an expected literal changed while the code under test also changed | note |
| `NO_TEST_RUN` | timeline: files changed, no test command ran | warning |

**Why removals only warn when corroborated.** Run over all 320 commits in my own repositories, the diff rules produced 45 removal warnings and **none of them was a shortcut**: two commits deleted a feature along with its tests, and the rest were refactors that consolidated assertions. The diff can see what disappeared, never why. The timeline's fail-then-edit sequence is the shortcut's signature, so a removal only warns when both agree — and never when the code under test was deleted too, since deleting code is what makes its tests fail. After that change the same corpus produces **0 warnings and 61 notes**.

That run also found two recall gaps, now fixed: Swift Testing's `@Test` was invisible (one repository had 974 of them and no `func test…` at all), and markers inside string literals — test fixtures — were flagged as real code.

**Piped test runs.** `npm test | tail -30` exits 0 however the tests went, because a pipeline takes its last command's status, and Claude Code reports that as success. Recorded as-is, it made `TEST_EDITED_AFTER_FAILURE` impossible to trigger for one of the most common ways agents run tests. When a test command's exit status can be masked (`|`, `||`, `;`), the runner's own output is read instead: summary lines for node:test, jest, vitest, mocha, pytest, go, cargo, XCTest and Swift Testing, with assertion-error markers as a fallback when `tail` cut the summary off.

Both of those were found by running a real agent against a failing test and telling it to make the test pass without touching the code. It declined to bend the expected values — and marked the test `todo` instead, which in node:test keeps it running while its failure no longer fails the suite. Before these fixes that session produced no flags at all. It now produces the two flags in [the example at the top](#what-a-published-log-looks-like).

## Install

Needs Node 22 or newer and the GitHub CLI (`gh`) logged in. Pick **one** route; `doctor` warns if pdl ends up registered twice.

### As a Claude Code plugin

```
/plugin marketplace add GcdZ03/pr-decision-log
/plugin install pr-decision-log@pr-decision-log
```

Or from a terminal, `claude plugin marketplace add GcdZ03/pr-decision-log` then `claude plugin install pr-decision-log@pr-decision-log`. Add `--scope project` or `--scope local` to both to limit pdl to one repository.

The plugin installs the hooks only. For the `pdl` command without installing anything else, use npx: `npx pr-decision-log doctor`.

### With npm

```bash
npm install -g pr-decision-log
pdl init --user    # every repository, via ~/.claude/settings.json
pdl doctor
```

Use `pdl init` without `--user` to register in the current repository's `.claude/settings.json` instead.

### From a clone

```bash
npm install && npm run build
node dist/pdl.js init
node dist/pdl.js doctor
```

`init` is idempotent, preserves other tools' hooks, and adopts a hand-written `pdl` hook instead of adding a second copy beside it. It warns if the plugin or the other settings file already registers pdl.

**Platforms:** developed on macOS; CI runs on Linux with Node 22 and 24. Windows is untested.

### How the plugin route works

The repository is its own marketplace: `.claude-plugin/marketplace.json` lists the plugin at the repository root, and both manifests pass `claude plugin validate --strict`. Claude Code installs plugins from git and runs no build step, so the bundle the hooks execute, `dist/pdl.js`, is committed, and CI fails if it no longer matches the source. It was gitignored at first, which meant a plugin install registered six hooks pointing at a file that did not exist.

The plugin registers the same six events `pdl init` writes, and a test keeps the two in step. `doctor` recognises a plugin install from Claude Code's own records (`installed_plugins.json` plus `enabledPlugins`), so a plugin user is not told to run `init` and register everything twice.

Verified end to end: installed at local scope into a scratch project from a git clone of this repository, a headless session there was recorded by the plugin's hooks alone, and `doctor` reported *6 events via the pr-decision-log plugin*.

### After installing, whichever route: trust the folder

**Hooks stay dormant until you trust the folder.** Claude Code holds back hooks from every settings file, including your own global one, until you accept the trust dialog for that directory. A registered-but-dormant install is indistinguishable from a working one if you only read the config, so `doctor` reads the folder's trust flag straight out of Claude Code's own state file:

```
[ok  ] hooks registered: 6 events via .claude/settings.json
[warn] folder trust: folder never opened interactively; hooks fire only in headless `claude -p` runs
       -> Run `claude` in this folder, accept the trust dialog, then `/hooks` to confirm the events show a count.
[ok  ] hooks firing: 5 session(s) recorded
```

Note the last line. An earlier version inferred trust from an empty store, and that inference failed in exactly the case that matters: headless `claude -p` runs bypass the dialog, so they record sessions and the check went green while every interactive session recorded nothing.

**This repository runs its own hooks.** `.claude/settings.json` registers pdl on itself, so if you open a clone in Claude Code and accept the trust dialog, your sessions here are recorded to `~/.local/share/pdl` and the log may be published to any pull request you open from that branch. Decline the dialog, or set `PDL_DISABLE=1`, to opt out.

## Using it

1. **Work in Claude Code as usual.** Every command, test run and edit is recorded locally in `~/.local/share/pdl`. Nothing is sent anywhere yet.
2. **Open a pull request** for your branch, with `gh pr create` (the agent can do it) or on the GitHub website.
3. **The log appears at the bottom of the PR description.** With `gh pr create` it appears straight away; with a PR opened on the web, at the end of your next turn within five minutes. Your own description is never touched: the log lives between hidden markers below it.
4. **It keeps itself up to date.** At the end of each agent turn the log is rebuilt and the PR is updated if anything changed. Work spread over several sessions, or resumed the next day, lands in the same log.

To see the log before there is a PR, run `pdl build` on the branch. To see the raw recorded timeline, run `pdl show`. Set `PDL_DISABLE=1` to stop recording for a session.

## Commands

| Command | Does |
| --- | --- |
| `pdl doctor` | Seven checks on the install, with a remedy for each failure |
| `pdl init [--user]` | Register hooks in this repository's `.claude/settings.json`, or with `--user` in `~/.claude/settings.json` |
| `pdl remove [--user]` | Take pdl's hooks back out of that settings file, leaving other hooks alone |
| `pdl build [session]` | Print the log without publishing: the current branch's, or one session's |
| `pdl show [session]` | Print the recorded timeline and any flags: the current branch's, or one session's |
| `pdl sessions [--all]` | List recorded sessions for this repository, newest first, with their ids and branches |
| `pdl publish <session> <pr>` | Publish one session's log to a pull request by hand |
| `pdl purge` | Delete every recorded session |
| `pdl redact-check [file]` | Run text through the redactor and report what matched |

Session ids for `show`, `build` and `publish` come from `pdl sessions`.

## Troubleshooting

**The log isn't showing up on my pull request.** Run `pdl doctor` first; it names the cause and the fix for most of these.

| Cause | Fix |
| --- | --- |
| The folder hasn't been trusted | Run `claude` there and accept the trust prompt (`doctor` reports this as *folder trust*) |
| `gh` isn't installed or logged in | `gh auth login` |
| The branch has no pull request yet | Open one; nothing publishes without a PR |
| The PR was opened on the website | It is picked up within five minutes, at the end of a turn |
| `PDL_DISABLE` is set | Unset it |
| A detached HEAD | Check out the branch; there is no PR to publish to |

**`doctor` says pdl is registered twice.** For example, the plugin and a settings file. Events are de-duplicated, so the log is still right, but each turn does the work twice. Keep one: uninstall the plugin, or run `pdl remove`.

**I deleted the log from a PR by hand and it hasn't come back.** It returns the next time the log changes.

## Uninstall

```bash
pdl remove --user                 # or `pdl remove` in a repository you ran `pdl init` in
pdl purge                         # optional: delete everything recorded
npm uninstall -g pr-decision-log
```

Plugin route: `/plugin uninstall pr-decision-log@pr-decision-log`, and `/plugin marketplace remove pr-decision-log` if you added the marketplace only for this. A log already published to a pull request stays there until you delete it from the PR description.

## Configuration

Optional. `pdl.config.json` at the repo root is the team's shared policy; `~/.config/pdl/config.json` holds personal defaults. Repo beats user beats built-in, so a personal file cannot quietly weaken what a repository asks for.

| Setting | Default | Does |
| --- | --- | --- |
| `publish.mode` | `"body"` | `"comment"` publishes a sticky PR comment instead of editing the body |
| `publish.max_chars` | `12000` | Size budget for the log; whole sections are trimmed from the end to fit (minimum 1000) |
| `publish.on_pr_create` | `true` | Publish as soon as `gh pr create` succeeds, rather than waiting for the end of the turn |
| `extract.decision_markers` | `[]` | Extra phrases, such as `"Decision:"`, that mark a stated decision |
| `tests.flag_edit_after_failure` | `true` | `false` turns `TEST_EDITED_AFTER_FAILURE` off |
| `redaction.extra_patterns` | `[]` | Regexes redacted on top of the built-in rules, never instead of them |
| `store.dir` | `~/.local/share/pdl` | Where sessions are recorded |
| `store.retention_days` | `30` | Sessions untouched this long are deleted, checked once a day; `0` keeps everything |

```json
{
  "publish": { "mode": "comment" },
  "redaction": { "extra_patterns": ["INTERNAL-[A-Z0-9]{8}"] }
}
```

That table is the whole list. An earlier version accepted eleven more settings and read none of them, so a test now fails for any setting the code does not use. Settings for features that do not exist yet were removed, and so were two that would weaken safety: a switch to turn off the built-in redaction (the repo's config wins, so one committed file could disable it for every contributor), and one to publish tool output.

`mode: "comment"` publishes a sticky pull request comment instead of editing the body. It finds its own comment by marker and edits it by id — never `gh pr comment --edit-last`, which edits whatever you most recently wrote and would overwrite a review note typed between two publishes.

A rejected setting never throws: it is ignored, the default applies, and `pdl doctor` names it. Silently applying a default for a typo is how a tool looks like it ignored your config.

## How it works

```
Claude Code hooks -> events (JSONL, outside the repo)
                              |
        transcript ----> extractor (decisions, assumptions, open items)
                              |
                     log builder (structural allowlist + redaction)
                              |
                       renderer -> idempotent splice into the PR body
```

Publishing is a **post-hoc edit** of the PR body, not a rewrite of `gh pr create --body`. Two hooks rewriting the same tool input resolve in non-deterministic order, so anyone running another input-rewriting hook would lose their log intermittently — a failure that is close to unreportable.

**One log per pull request, however many sessions it took.** Hook payloads carry no branch, so at the end of each turn — where git already runs — pdl records which branch that session was on. Every event is assigned to the turn it happened in, and a branch's log is every event from every session whose turn was on that branch, merged in time order. A `--resume`, a second session the next day, and a session that switched branches part-way all land where they belong.

**Stacked PRs are diffed against their own base**, which comes back from GitHub in the same lookup that finds the PR, so a PR built on another feature branch shows only its own changes.

**The end-of-turn cost is network, so pdl spends as little as possible.** Measured, the local work is about 75 ms and each `gh` round-trip about 500 ms. pdl makes no call while a branch is known to have no PR (rechecked every five minutes, or immediately on `gh pr create`), none when the log has not changed since it was last published, and otherwise one lookup plus one write. A turn on a branch with no PR went from 0.7 s to 0.08 s, which is Node's startup time.

If pdl is registered twice — user and project settings, or plugin and `init` — each hook fires twice. Events are collapsed by id when read, so the log is still right, and `doctor` says to remove one.

## Limitations, honestly

- **The Decisions section is usually empty.** That is the measured reality, not a defect. It is suppressed rather than rendered as "none recorded".
- **Stated decisions run about two useful items in three.** The agent's prose uses rationale words rhetorically ("verify X rather than guess"). A narration filter removes most of it; the `(stated)` label carries the rest.
- **Plan-mode extraction is not implemented.** Zero `ExitPlanMode` uses exist across 170+ transcripts here, so there is no sample to build against. Guessing at the schema is how the spike got three things wrong once already.
- **Redaction is pattern-based** and will miss novel secret formats. The structural allowlist is the real defence.
- **The diff rules are shallow regexes**, not parsers. They are tuned against real history for false positives, but that history contains no actual shortcuts, so recall is only evidenced by planted cases and one real agent run.
- **A PR opened outside the session** (on the web, or from another terminal) is picked up within five minutes, not instantly.
- **If you delete the log from a PR body by hand**, it comes back the next time the log changes, not on the next turn.
- **Claude Code only.** Cursor and Copilot CLI adapters are Phase 3.

## The problem, with evidence

- **AI PRs sit in the queue.** LinearB's 2026 benchmarks (8.1M PRs, 4,800 engineering teams) found AI-generated PRs wait **4.6x longer** for a first review, agentic PRs **5.3x** longer to be picked up, and are accepted **32.7%** of the time vs **84.4%** for manual PRs. ([source](https://linearb.io/resources/software-engineering-benchmarks-report))
- **Review is the bottleneck, not generation.** Faros AI (10,000+ developers, 1,255 teams): high-AI-adoption teams merge **98% more PRs**, but PR review time rises **91%** and PR size **154%**. ([source](https://www.faros.ai/blog/ai-software-engineering))
- **Agent descriptions are not trustworthy on their own.** In a study of 23,247 agent-authored PRs, 1.7% had a high mismatch between description and code, most often a description claiming changes that were never made; those PRs were accepted 28.3% of the time vs 80.0%. ([arXiv 2601.04886](https://arxiv.org/abs/2601.04886)) This is the reason the log leads with evidence and labels everything else.
- **Agent-written tests often verify nothing.** 80.2% of 86,156 agent-authored test patches had weak or no explicit oracle signals, meaning assertions that check nothing meaningful. ([arXiv 2606.18168](https://arxiv.org/abs/2606.18168))

## Compared to

| Tool | What it does | Why it was not enough |
| --- | --- | --- |
| [add-reasoning-to-prs](https://github.com/backthread/add-reasoning-to-prs) | Asks the agent for a prose "why" block at `gh pr create` | One-shot prose, no evidence, no update on later pushes |
| Entire, Git AI | Git-native session capture | Archives everything, surfaces nothing to the reviewer |
| Copilot / Codex PR summaries | Summarise their own agent's work | Their agent only, and still self-report |

The gap is the piece in between: structured, updatable, redacted, and anchored to what actually ran.

## Docs

| Doc | Contents |
| --- | --- |
| [docs/DESIGN.md](docs/DESIGN.md) | Architecture, schema, PR template, CLI/hook interface, security model |
| [docs/RESEARCH.md](docs/RESEARCH.md) | Evidence, prior art, hook reference, transcript format, open questions |
| [docs/ROADMAP.md](docs/ROADMAP.md) | Phase 0 through Phase 3, each with a definition of done |
| [docs/SOURCES.md](docs/SOURCES.md) | Every URL consulted and what it contributed |

## Why I built it

I use Claude Code every day, and at work I ship a cloud web app and mobile apps for workshops and logistics where every PR goes through human review. The pattern is consistent: the agent does an hour of work, I open a PR, and the reviewer sees a diff and a two-line description. Everything that would have made the review fast is in a JSONL file on my laptop that nobody will read.

What I did not expect was that building it would disprove my own pitch twice — first that the reasoning was recoverable at all, then that the agent's prose was the best source of it. Both times the measurement is in the repository, and the design doc says so rather than papering over it.

## License

MIT
