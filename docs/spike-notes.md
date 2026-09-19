# Phase 0 spike notes

Date: 2026-09-19
Machine: Apple M5, Node v26.3.1, macOS 25.6.0
Corpus: 171 local Claude Code transcripts in `~/.claude/projects`; measurements run over the 80 largest (>20 KB), of which 50 contained file edits.

Reproduce with `npm run spike:yield`, `npm run spike:evidence`, `npm run spike:summary` and `npm run spike:splice`.

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

### Q1. What field carries tool output on `PostToolUse`? ANSWERED (and my first answer was wrong)

**`tool_response`.** Its shape depends on the tool; for `Bash` it is the structured object:

```json
"tool_response": { "stdout": "...", "stderr": "", "interrupted": false, "isImage": false }
```

`PostToolUse` also carries `duration_ms`.

> **Correction.** I first recorded this as `tool_result` holding `{type, text}`, based on a *summarised* fetch of the hooks page. Re-fetching the raw markdown (`https://code.claude.com/docs/en/hooks.md`, 330 KB) shows `tool_response` appearing 10 times and `tool_result` twice, the latter only when contrasting `PostToolBatch` against `PostToolUse`. The summariser appears to have conflated the two. **Lesson for the rest of this project: fetch the raw `.md` and grep it, do not trust a summarised doc read for a field name.**

**The consequence reverses too.** Because `tool_response` for Bash is already `{stdout, stderr, interrupted, isImage}`, the hook payload is *not* poorer than the transcript for command outcomes; it is the same shape, delivered synchronously. The mandatory transcript join I proposed is unnecessary. The transcript is still read, but only for `gitBranch` (Q3) and assistant text (the low-yield narrative rules).

`PostToolUse` also has no decision model. Any non-zero exit is reported as a non-blocking error, which is the fail-open behaviour this tool wants anyway.

### Q2. Do `Bash` results carry an exit code? ANSWERED: not in the transcript, but yes on the failure hook

There is no numeric exit code anywhere in the transcript format. I grepped every scalar path across 40 large transcripts for `exit`, `returncode` and `status`. The only hits were `toolUseResult.status` (subagent lifecycle, not shell), `returnCodeInterpretation` (28 occurrences, all the literal string `"No matches found"`, i.e. grep-specific), and `attachment.exitCode` (13 occurrences, all `0`, and all on `hook_success` attachments, i.e. the exit code of a *hook*, not of the agent's command).

What does exist, on 2,528 Bash results, is richer than expected:

```json
"toolUseResult": { "stdout": "...", "stderr": "...", "interrupted": false, "isImage": false, "noOutputExpected": false }
```

**`stdout` and `stderr` arrive separately.** Some variants add `gitOperation` (85) and `bashEditDiff` (24).

**But the exit code does exist, on `PostToolUseFailure`.** That event carries top-level `error`, `is_interrupt` and `duration_ms`, and for Bash the `error` string's **first line is `Exit code N`**. So the "no exit code" conclusion is true of the transcript and false of the hook payload. The docs warn to key on that first line only and treat the rest as display text: it is middle-truncated around a `... [N characters truncated] ...` marker and Claude Code may insert its own lines such as `Command timed out after 2m 0s`.

**Interruption arrives on the success event, not the failure event.** Cancelling a running tool does not fire `PostToolUseFailure` at all; the tool result carries the interruption message instead. `is_interrupt` on the failure event means something narrower: the failure reached Claude Code as an abort rather than as an error the tool reported.

Design consequences:

- Outcome classification: `PostToolUseFailure` + leading `Exit code N` first, then `tool_response.interrupted`, then non-empty `stderr`, then per-runner output parsers.
- `interrupted: true` must be treated as a distinct outcome, not a failure. A test run the user cancelled is not a failing test run, and counting it as one would corrupt the flagship signal.
- Prefer the **hook payload** over the transcript for outcomes: same structure, delivered synchronously, and the transcript is written asynchronously and may lag.

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

**Correction to the `updatedInput` note.** The raw reference states that `updatedInput` **replaces the entire input object**, so unchanged fields must be echoed back. An earlier revision of these notes said omitted fields pass through, copied from the same summarised fetch that got Q1 wrong. Claude Code also evaluates permission rules and Bash auto-backgrounding against the hook's returned input, not the model's original input.

**Not settled: live payload capture. Blocked on workspace trust.** `src/record.mjs` is written, registered in this repo's `.claude/settings.json` for six events, and measures 61 ms per invocation. A fresh session in the repo still captured nothing.

The cause is documented: *"Claude Code checks workspace trust before it runs any hook from a settings file. Interactive session: Claude Code holds back hooks from every settings file, including your own `~/.claude/settings.json`, until you accept the workspace trust dialog for the folder, or for a parent directory whose trust extends to it."* This repo was created by `gh repo create` minutes earlier and has never been trusted.

To unblock: open the repo interactively, accept the workspace trust dialog, then run `/hooks` and confirm the six events show a count. `-p` and SDK sessions skip the dialog and treat the folder as trusted, which is a useful fallback for testing but is also worth remembering as a security property of this tool's own install story.

This is worth carrying into the product: `pdl init` must tell the user that hooks stay dormant until the folder is trusted, and `pdl doctor` should detect "configured but never fired" and say why rather than reporting success.

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

---

# Follow-up review (2026-09-19, after the design rewrite)

A second pass over this spike, the revised `DESIGN.md` and the corpus. Three findings, ordered by how much they should change the plan. Numbers below come from `npm run spike:summary` (`scripts/spike-summary-yield.mjs`), run over the same 80-transcript corpus.

## F1. The premise was falsified by a probe that only looked in one place

`spike-yield.mjs` measures **rule 3** of `DESIGN.md` section 10: assistant text in the few stream entries *immediately preceding* an edit. 3.0% is a sound measurement of that rule. But **rule 4** (`last_assistant_message` on `Stop`) was never measured, and the design was rewritten as though it had been.

Rule 4's territory, same corpus, same cue set:

| measure | rule 3 (pre-edit) | rule 4 (turn-final) |
| --- | --- | --- |
| candidate messages | 862 edits | 227 turn-final messages |
| containing a rationale cue | 26 (3.0%) | **139 (61.2%)** |
| sessions with >= 1 hit | **1 / 47** | **31 / 48 (64.6%)** |

Also measured: 161 of 231 assistant text blocks >= 400 chars carry a cue (69.7%).

(The corpus is live — it grows with every session on this machine, including the one that produced these notes — so re-runs drift by a point or two. Snapshot the corpus before any number goes in the README.)

**Read these as an upper bound, not a yield.** A cue in the sentence before an edit is strong evidence of a stated choice; a `because` somewhere in 2 KB of wrap-up prose is weak. The true rate after hand-labelling will be well below 61%. But it will not be 3%, and the gap at session level is roughly 20x.

The behavioural explanation fits: **the agent justifies its work in the wrap-up, not before each edit.** It narrates while working and explains when reporting. Rule 3 samples the narration; rule 4 samples the explanation.

What this does *not* change: the evidence timeline is still the deterministic, 100%-coverage part, and it should still lead. What it does change is the overclaiming that came with the rewrite:

- Principle 1's "a decisions section that renders empty on most PRs is the expected case" is probably **wrong**. Expect it to render on the majority.
- Non-goal "not a window into the agent's reasoning ... rationale precedes 3% of edits" generalises a narrow probe to the whole tool.
- Section 10's "expect this to yield nothing on most PRs" is correct **for rule 3 only** and should say so.
- The SessionStart elicitation argument ("yield is low, so it is now the only lever") rests on the 3% figure. If rule 4 lands anywhere near even 25% after labelling, elicitation is unnecessary and should stay off permanently, which is the better outcome anyway given arXiv 2601.04886.

**Action before Phase 1:** hand-label the 139 turn-final hits as genuine decision / assumption / open item / noise. That gives a real rule-4 yield, and it is a couple of hours. Rewrite the four passages above from whatever it says.

**Bonus finding: rule 2 never fires.** `ExitPlanMode` appears **0 times across all 48 sessions**. Section 10 ranks plan-mode content as the second most reliable extraction source; on this corpus it is dead code. Either drop it down the order or note that it only applies to people who work in plan mode, which this corpus shows is nobody here.

## F2. Phase 0 is not done, and the docs read as though it is

Two checklist items are open, and the open ones are the two that need *live* data rather than transcript archaeology:

- **No hook payload has ever been captured.** `~/.local/share/pdl/raw/` contains exactly one file, `latency-test.jsonl`, from the timing run. `src/record.mjs` is registered but has never seen a real event.
- **The `gh pr create` interception has never run.** `spike-splice.mjs` proves the string manipulation; nothing proves the hook fires on the right matcher, finds the PR number, and survives a real `gh pr edit`.

Meanwhile `DESIGN.md` section 2.1 states the hook payload field name as settled fact. It is sourced from the hooks reference, not from observation, and `RESEARCH.md` section 3 warns in its own words that "the docs have changed field names before". The transcript-derived findings (Q2, Q3) are observations and stand; the payload-shape finding (Q1) is documentation reading wearing the same *(measured)* label.

**Action:** finish both before starting Phase 1, and mark the Q1 claims as doc-sourced until a real payload confirms them. One evening. Register `SessionStart`, `SessionEnd` and `PreCompact` in `.claude/settings.json` first — the roadmap's capture task lists nine events and the file currently has six.

## F3. The unanswered product question: what does the timeline add over a green CI check?

The revised principle 1 says evidence is the product and narrative is a garnish. But a reviewer looking at the PR already has the diff and the checks. A Verification table saying `npm test` passed at 09:41 duplicates a green check mark, and a Changes list duplicates the diff stat. Rendering both on every PR is noise, and noise on every PR is how a tool gets uninstalled.

What CI genuinely **cannot** show, because the fact exists only in the session timeline:

- a test file edited inside the window between a failing run and the next green one;
- tests never run at all before the PR was opened;
- a test run the user cancelled (`interrupted`), which looks like nothing in CI;
- an edit made and reverted within the session.

That list is exactly `flags[]`. So the honest conclusion is closer to **the flags are the product and the timeline is the substrate that makes them provable** — which is not quite what the rewrite says. Concretely:

- Render **Flags** first and always; fold **Verification** and **Changes** into a `<details>` block by default, with a config key to expand them. A log that is three lines on a clean PR and loud on a suspicious one is one a reviewer will keep.
- This strengthens the case for promoting the test-change analyser to Phase 1, but for a different reason than the roadmap gives: not because 38% of sessions have the signal, but because without the flags there is no reason for the section to exist.

**Corollary on the flagship signal.** The latching caveat above already says 78 is over-counted. After windowing on the next green run, requiring the failure output to name the test, and excluding additive edits, the real session rate could plausibly fall from 38% to single digits. Hand-label 20 sessions *before* committing the analyser to the MVP. If it lands near 5% it is still the right differentiator and a great demo, but the MVP then has to be worth installing for the other 95% of PRs — and F3 says that means flags like `NO_TEST_RUN`, not a verification table.

## Smaller things

- `README.md` says "Status: Planning (no code yet)"; there are four scripts and a recorder.
- `test/` is empty, so `npm test` has nothing to run, while the Phase 1 CI item treats it as green.
- Phase 1 is ~20 checklist items ending in npm publish, a plugin manifest, two publisher modes, `doctor`, `purge`, `redact-check` and a JSON schema. For evenings and weekends that is months, and the repo currently has 1,000+ lines of docs against 27 lines of product code. Suggested v0.1 cut: record -> build -> publish (`body` mode only) -> one flag. Everything else to v0.2.
