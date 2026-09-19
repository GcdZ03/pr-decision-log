# Phase 0 spike notes

Date: 2026-09-19
Machine: Apple M5, Node v26.3.1, macOS 25.6.0
Corpus: 171 local Claude Code transcripts in `~/.claude/projects`; measurements run over the 80 largest (>20 KB), of which 50 contained file edits.

Reproduce with `npm run spike:yield` and `node scripts/spike-evidence.mjs 80`.

## Verdict: GO, with a changed premise

The spike was designed to kill the idea cheaply. It did kill **half** of it. The half it killed is the half the README leads with.

---

## Finding 1: thinking blocks are empty (confirmed)

| | count |
| --- | --- |
| thinking blocks on disk | 2,176 |
| non-empty | 6 |
| empty | 2,170 (99.7%) |

The research doc's claim holds. There is no hidden chain-of-thought to mine. Everything must come from visible assistant text, tool calls, and tool results.

## Finding 2: rationale extraction does not work (premise falsified)

Method: for each `Edit`/`Write`/`MultiEdit`/`NotebookEdit` call, look back up to 6 stream entries for the nearest assistant text block, and test it for rationale cues (`because`, `instead of`, `rather than`, `chose`, `trade-off`, `assum`, `so that`, `the reason`, `avoids`, `prefer`, `decided`, `alternative`).

| measure | value |
| --- | --- |
| edit tool calls | 881 |
| preceded by any assistant text | 574 (65.2%) |
| ...containing a rationale cue | **26 (3.0%)** |
| median rationale hits per session | **0** |
| sessions with >= 3 hits | **1 of 50** |

**The agent almost never says why before it edits.** It narrates what it is about to do, not why it chose that over something else. A tool that ships "the agent's reasoning" would ship an empty section on 49 of 50 PRs.

The 26 hits that *were* found are genuinely good, e.g.:

> "The second mutation survived: that `===` assertion only proves the test read back what it passed in. Sharing turns out not to be load-bearing, so the assertion goes rather than gets propped up."

So the signal is high-precision and near-zero-recall. Treat it as a garnish, never the product.

## Finding 3: the evidence timeline is rich (new premise)

Method: classify every `Bash` command as test/build/lint/other, pair it with its `tool_result`, and mark failure via `is_error` or output patterns.

| signal | total | sessions having it |
| --- | --- | --- |
| commands run | 3,085 | 50/50 (100%) |
| test runs | 877 | 48/50 (96%) |
| failing test runs | 74 | 34/50 (68%) |
| build runs | 260 | 46/50 (92%) |
| file edits | 881 | 50/50 (100%) |
| test-file edits | 170 | 37/50 (74%) |
| test edited after a failing run | 78 | **19/50 (38%)** |

Sessions that edited code but never ran a test: 2/50.

This is the inversion. The deterministic timeline fires on **every** session. The flagship reviewer signal (a test file edited after a failing test run) fires on **more than a third** of real sessions, on this machine, on real work.

## Consequence for the design

Swap the emphasis in `README.md` and `DESIGN.md`:

- **Lead with evidence.** What ran, what failed, what got edited after what. Deterministic, 100% coverage, no model self-report.
- **Demote rationale** to an optional "Notes from the session" section that renders only when hits exist. Never pad it.
- **Promote the test-change analyser from Phase 2 to Phase 1.** It is the differentiator and the data says it is common enough to matter. `add-reasoning-to-prs` (the nearest competitor) cannot do this at all, because prose self-report cannot see that the test was edited after the failure.
- **Reconsider the SessionStart elicitation line.** The roadmap offered it as a fallback for low yield. Yield is low, so it is now the only way to raise rationale coverage. But it changes agent behaviour to serve the tool, and the arXiv finding (2601.04886) says self-reported descriptions are the least reliable part of an agent PR. Recommendation: build it, default it **off**, and measure whether it helps before defaulting it on.

## Caveat on the flagship signal

`TEST_EDITED_AFTER_FAILURE` = 78 across 19 sessions is **over-counted**. The current heuristic latches: once any test run fails, every later test-file edit in that session counts. The real rule must be scoped to the window between a failing run and the next passing run of *the same* test command, and must exclude edits that add new tests. Expect the true number to be materially lower. Measuring precision against hand-labelled sessions is the first Phase 1 task, not an afterthought.

Failure detection is also regex-based over tool output; `is_error` is reliable, the rest is not. Per-runner parsers are needed.

## Open questions still unanswered

These need live hook payloads, not transcript archaeology:

1. Exact field name for tool output on `PostToolUse` (`tool_result` vs `tool_response`).
2. Whether `Bash` results carry a real exit code, or only output text.
3. Whether subagent events carry the parent session id.
4. `gh pr create` interception: `updatedInput` vs post-hoc `gh pr edit`, and quoting pitfalls.

The recorder needed to answer them is not yet written. That is the next task.

## Status of Phase 0 checklist

- [x] Repo skeleton (`package.json`, `tsconfig.json`, esbuild build script)
- [x] Decision-yield measurement (`scripts/spike-yield.mjs`)
- [x] Evidence-yield measurement (`scripts/spike-evidence.mjs`)
- [x] Confirm thinking blocks are empty
- [x] Write up go/no-go
- [ ] `pdl hook` raw recorder
- [ ] Two live sessions with the recorder registered (project-scoped, not `~/.claude/settings.json`)
- [ ] `gh pr create` interception prototype
- [ ] Idempotent splice prototype
- [ ] Hook latency measurement

## Deviation from the plan

`ROADMAP.md` Phase 0 says to register the recorder in `~/.claude/settings.json`. That is global and would fire on every unrelated session on this machine. Register in this repo's `.claude/settings.json` instead, and only widen if the spike needs cross-repo data.
