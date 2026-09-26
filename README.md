# pr-decision-log

[![CI](https://github.com/GcdZ03/pr-decision-log/actions/workflows/ci.yml/badge.svg)](https://github.com/GcdZ03/pr-decision-log/actions/workflows/ci.yml)

**Status: working, Phase 1 in progress.** Dogfooded on this repository's own pull requests.

`pdl` records what an AI coding agent actually did while it worked, and attaches a structured, redacted **decision log** to the resulting pull request. The reviewer gets what ran, what failed, what was edited after what, and a flag on any test that was changed right after that test failed — instead of being, in Addy Osmani's words, "the first human being to ever lay eyes on this code."

It installs as Claude Code hooks and publishes on its own. There is no step you have to remember.

## What a published log looks like

This is real output, from this repository's PR #3:

```markdown
## Decision log

*Recorded automatically from the agent session on `phase1-install-autopublish`.
Everything below is observed from tool events, not the model's self-report.*

### Flags
- **TEST_EDITED_AFTER_FAILURE** `sum.test.js` Edited after `npm test` failed and
  before it passed again; assertion count 1 -> 0.

### Verification (recorded)
| When | Command | Result |
| --- | --- | --- |
| 06:26 | `npm test 2>&1 \| tail -40` | pass |

### Decisions
- Rather than persisting the PR number, I'll re-derive it from the current
  branch, which removes a state file entirely. *(stated)*
- Integration: Merge to main locally *(confirmed by a human)*
```

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

Both of those were found by running a real agent against a failing test and telling it to make the test pass without touching the code. It declined to bend the expected values — and marked the test `todo` instead, which in node:test keeps it running while its failure no longer fails the suite. Before these fixes that session produced no flags at all. It now produces:

```
- TEST_EDITED_AFTER_FAILURE `sum.test.js` Edited after `npm test 2>&1 | tail -30` failed and before it passed again.
- TEST_SKIPPED `sum.test.js` Added `{ todo } / { skip } option` (the test still runs but its failure no longer fails the suite).
```

## Install

```bash
npm install && npm run build
node dist/pdl.js init      # registers six hooks in .claude/settings.json
node dist/pdl.js doctor    # confirms they are actually firing
```

`init` is idempotent, preserves other tools' hooks, and adopts a hand-written `pdl` hook instead of adding a second copy beside it.

**Hooks stay dormant until you trust the folder.** Claude Code holds back hooks from every settings file, including your own global one, until you accept the trust dialog for that directory. A registered-but-dormant install is indistinguishable from a working one if you only read the config, so `doctor` reads the folder's trust flag straight out of Claude Code's own state file:

```
[ok  ] hooks registered: 6 events in .claude/settings.json
[warn] folder trust: folder never opened interactively; hooks fire only in headless `claude -p` runs
       -> Run `claude` in this folder, accept the trust dialog, then `/hooks` to confirm the events show a count.
[ok  ] hooks firing: 5 session(s) recorded
```

Note the last line. An earlier version inferred trust from an empty store, and that inference failed in exactly the case that matters: headless `claude -p` runs bypass the dialog, so they record sessions and the check went green while every interactive session recorded nothing.

## Commands

| Command | Does |
| --- | --- |
| `pdl doctor` | Seven checks on the install, with a remedy for each failure |
| `pdl init [--user]` | Register hooks in project or user settings |
| `pdl show <session>` | Print the recorded timeline |
| `pdl build <session>` | Render the log to stdout |
| `pdl publish <session> <pr>` | Publish to a pull request by hand |
| `pdl purge` | Delete every recorded session |
| `pdl redact-check [file]` | Run text through the redactor and report what matched |

Set `PDL_DISABLE=1` to turn recording off entirely.

### Install as a Claude Code plugin

The repository is also a plugin, so the hooks can be installed without editing any settings file. `.claude-plugin/plugin.json` and `hooks/hooks.json` register the same six events `pdl init` writes, resolved through `${CLAUDE_PLUGIN_ROOT}`. A test asserts the two stay in step, because a plugin that registers a different set than `init` would be a silent difference between two installs of the same tool.

## Configuration

Optional. `pdl.config.json` at the repo root is the team's shared policy; `~/.config/pdl/config.json` holds personal defaults. Repo beats user beats built-in, so a personal file cannot quietly weaken what a repository asks for.

```json
{
  "publish": { "mode": "comment", "max_chars": 12000 },
  "redaction": { "extra_patterns": ["INTERNAL-[A-Z0-9]{8}"] },
  "store": { "dir": "~/.local/share/pdl" }
}
```

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

Publishing is a **post-hoc edit** of the PR body, not a rewrite of `gh pr create --body`. Two hooks rewriting the same tool input resolve in non-deterministic order, so anyone running another input-rewriting hook would lose their log intermittently — a failure that is close to unreportable. The PR number is re-derived from the current branch rather than stored, so nothing goes stale across a resume or a rebase.

Repeated publishes are a no-op: the section carries a content hash, and an unchanged log is not rewritten.

## Limitations, honestly

- **The Decisions section is usually empty.** That is the measured reality, not a defect. It is suppressed rather than rendered as "none recorded".
- **Stated decisions run about two useful items in three.** The agent's prose uses rationale words rhetorically ("verify X rather than guess"). A narration filter removes most of it; the `(stated)` label carries the rest.
- **Plan-mode extraction is not implemented.** Zero `ExitPlanMode` uses exist across 170+ transcripts here, so there is no sample to build against. Guessing at the schema is how the spike got three things wrong once already.
- **Redaction is pattern-based** and will miss novel secret formats. The structural allowlist is the real defence.
- **The diff rules are shallow regexes**, not parsers. They are tuned against real history for false positives, but that history contains no actual shortcuts, so recall is only evidenced by planted cases and one real agent run.
- **Stacked pull requests** are diffed against the repository's default branch, so a PR based on another feature branch may show its parent's changes too.
- **Claude Code only.** Cursor and Copilot CLI adapters are Phase 3.

## The problem, with evidence

- **AI PRs sit in the queue.** LinearB's 2026 benchmarks (8.1M PRs, 4,800+ orgs) found AI-generated PRs wait **4.6x longer** for a first review, agentic PRs **5.3x**, and are accepted **32.7%** of the time vs **84.4%** for manual PRs. ([source](https://linearb.io/resources/software-engineering-benchmarks-report))
- **Review is the bottleneck, not generation.** Faros AI (10,000+ developers, 1,255 teams): high-AI-adoption teams merge **98% more PRs**, but PR review time rises **91%** and PR size **154%**. ([source](https://www.faros.ai/blog/ai-software-engineering))
- **Agent descriptions are not trustworthy on their own.** In a study of 23,247 agent-authored PRs, descriptions claiming unimplemented changes were the most common inconsistency; inconsistent PRs were accepted 28.3% vs 80.0%. ([arXiv 2601.04886](https://arxiv.org/abs/2601.04886)) This is the reason the log leads with evidence and labels everything else.
- **Agent-written tests often verify nothing.** 80.2% of 86,156 agent-authored test patches had weak or no explicit assertions. ([arXiv 2606.18168](https://arxiv.org/abs/2606.18168))

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
