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

## Open questions: answers

Three of the four are now settled from the transcript corpus and the hooks reference. The fourth is half-settled.

### Q1. What field carries tool output on `PostToolUse`? ANSWERED

`tool_result`, and it is an **object**, not a string:

```json
"tool_result": { "type": "text", "text": "\u2713 All tests passed (42 tests)" }
```

Not `tool_response`. Source: the hooks reference input schema for `PostToolUse`.

**The consequence is the important part.** The hook payload gives a single rendered `text` blob. The transcript's `toolUseResult` sidecar gives far more (see Q2). So the recorder cannot rely on hook payloads alone for command outcomes; it must join hook events to the transcript. That is a real architectural constraint and it is not in `DESIGN.md` yet.

`PostToolUse` also has no decision model. Any non-zero exit is reported as a non-blocking error, which is the fail-open behaviour this tool wants anyway.

### Q2. Do `Bash` results carry an exit code? ANSWERED: NO, but something better exists

There is no numeric exit code anywhere in the transcript format. I grepped every scalar path across 40 large transcripts for `exit`, `returncode` and `status`. The only hits were `toolUseResult.status` (subagent lifecycle, not shell), `returnCodeInterpretation` (28 occurrences, all the literal string `"No matches found"`, i.e. grep-specific), and `attachment.exitCode` (13 occurrences, all `0`, and all on `hook_success` attachments, i.e. the exit code of a *hook*, not of the agent's command).

What does exist, on 2,528 Bash results, is richer than expected:

```json
"toolUseResult": { "stdout": "...", "stderr": "...", "interrupted": false, "isImage": false, "noOutputExpected": false }
```

**`stdout` and `stderr` arrive separately.** That is better than the single blob the hook payload gives, and it kills the plan's assumption that failure must be sniffed from mixed output. Some variants add `gitOperation` (85) and `bashEditDiff` (24).

Design consequences:

- Outcome classification must still be inferred, because no exit code exists. Use `is_error` on the `tool_result` block (present on 220 of 222 sampled), non-empty `stderr`, and per-runner output parsers, in that order.
- `interrupted: true` must be treated as a distinct outcome, not a failure. A test run the user cancelled is not a failing test run, and counting it as one would corrupt the flagship signal.
- Prefer the transcript sidecar over the hook payload wherever both exist.

### Q3. Do subagent events carry the parent session id? ANSWERED: YES, three ways

1. **Path.** Subagent transcripts live at `<project>/<parent-session-id>/subagents/agent-<agentId>.jsonl`, so the parent id is in the path.
2. **Field.** Every entry inside a subagent transcript carries the parent's `sessionId`. Verified: 222 of 222 entries in one subagent file all carry the parent id.
3. **Marker.** `isSidechain` is `true` for subagent entries and `false` otherwise. Across 40 transcripts: 2,637 true, 12,338 false.

The `Task` tool result also carries `{ agentId, status, isAsync, outputFile, resolvedModel, prompt, description }`, so a subagent hand-off can be attributed without reading the child transcript at all.

**Bonus finding that simplifies Phase 1.** Every transcript entry already carries `gitBranch`, populated on 14,669 of 14,669 entries sampled. The plan called for shelling out to `git rev-parse --abbrev-ref HEAD` and caching it per session. That is unnecessary. Note that worktrees show real branch names and detached heads show `HEAD`, so handle `HEAD` as a special case rather than a branch.

Entries also carry `cwd`, `version`, `timestamp`, `uuid` and `parentUuid`, so ordering and causality are reconstructable without inference.

### Q4. `gh pr create` interception. HALF ANSWERED

**Settled: quoting is a non-issue if you never interpolate.** `scripts/spike-splice.mjs` covers the splice with 8 tests, all passing, including a payload containing backticks, `$(whoami)`, nested double quotes, Windows backslash paths, `%` and non-ASCII. Nothing is escaped or mangled, because the body never touches a shell: write it to a file and use `gh pr edit --body-file -` on stdin. The idempotence test confirms a second identical run is a no-op via a content hash in a marker comment, and that changed content replaces in place rather than appending a second block.

**Settled: `updatedInput` is viable but has a documented hazard.** The reference confirms the shape, that omitted fields pass through, and that the transcript shows both original and updated versions. The hazard, from the hooks guide: when multiple `PreToolUse` hooks return `updatedInput` for the same tool, *the last to finish wins, and because hooks run in parallel the order is non-deterministic*. Any user with another Bash-rewriting hook would silently clobber the log. That is a strong argument for the post-hoc `gh pr edit` path as the default and `updatedInput` as opt-in.

**Not settled: live payload capture.** `src/record.mjs` is written and registered in this repo's `.claude/settings.json` for six events, and measures 61 ms per invocation, which is acceptable for `async: true`. It has not captured a real payload yet, because Claude Code loads hook settings at session start and this session predates the file. **Open a new Claude Code session in this repo and do any small edit; the payloads will land in `~/.local/share/pdl/raw/<session>.jsonl`.** That is the one remaining Phase 0 task, and it exists to confirm the documented schemas against reality, since the research doc notes the docs have renamed fields before.

## Original open questions (superseded by the section above)

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
- [x] `pdl hook` raw recorder (`src/record.mjs`, 61 ms/invocation)
- [x] Answer open questions 1-3 from the transcript corpus and hooks reference
- [x] Idempotent splice prototype (`scripts/spike-splice.mjs`, 8/8 passing)
- [ ] Two live sessions with the recorder registered (project-scoped, not `~/.claude/settings.json`)
- [ ] `gh pr create` interception prototype
- [x] Hook latency measurement (61 ms)

## Deviation from the plan

`ROADMAP.md` Phase 0 says to register the recorder in `~/.claude/settings.json`. That is global and would fire on every unrelated session on this machine. Register in this repo's `.claude/settings.json` instead, and only widen if the spike needs cross-repo data.
