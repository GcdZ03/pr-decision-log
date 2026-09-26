# Roadmap

Phased plan. Each phase is a checklist with a definition of done. Estimates assume evenings and weekends alongside a full-time job. Do not start Phase 1 until Phase 0's questions have answers; the spike exists to kill or reshape the idea cheaply.

## Phase 0 - Spike (one weekend)

Goal: prove the two risky assumptions. (a) Hook payloads plus transcript give enough signal to produce a useful log without hidden reasoning. (b) The PR body can be updated idempotently from a hook without breaking `gh pr create`.

- [x] Create the repo skeleton: `package.json` (`"type": "module"`, Node >=22, no runtime deps), `tsconfig`, esbuild bundle script, `node:test` runner. No framework.
- [x] Write a 30-line `pdl hook` that appends raw stdin JSON plus `hook_event_name` and a timestamp to `~/.local/share/pdl/raw/<session_id>.jsonl`. Register it in `~/.claude/settings.json` for `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `PostToolUseFailure`, `Stop`, `SubagentStop`, `PreCompact`, `SessionEnd`, all `async: true` except `Stop`.
- [x] Do two real Claude Code sessions on a real repo (e.g. a small change to CreativeNotch or one of your other side projects). Inspect the raw payloads. Answer: exact field name for tool output on `PostToolUse`; whether `Bash` results carry an exit code; whether subagent events carry the parent session id; what `transcript_path` looks like for subagents.
- [x] Measure decision yield: over those sessions plus 5 older transcripts in `~/.claude/projects`, count assistant `text` blocks immediately preceding an `Edit|Write` that contain a rationale marker (because / instead of / rather than / chose / trade-off / assum). Record the number per session in `docs/spike-notes.md`.
- [x] Prototype the `gh pr create` interception on a throwaway repo: (1) `PreToolUse` with `if: "Bash(gh pr create*)"` returning `updatedInput` with a modified `--body`; (2) alternative: let it run, then `PostToolUse` calls `gh pr view --json number,body` and `gh pr edit --body-file -`. Pick one; note quoting pitfalls.
- [x] Prototype idempotent update: run the splice twice, confirm the second run is a no-op (hash in marker comment).
- [x] Time the shim: `time (echo '{}' | node dist/pdl.js hook)` on your machine; record it.
- [x] Write `docs/spike-notes.md` with the answers and a go/no-go.

Definition of done: `spike-notes.md` answers all open questions 1-4 from RESEARCH.md with evidence, includes one screenshot of a PR body updated twice by the hook, and states whether SessionStart context injection is needed for adequate decision yield. Decision recorded: go / go-with-changes / stop.

## Phase 1 - MVP (3-4 weeks of evenings)

Goal: you use it on every PR you open, and it never gets in the way.

Core:
- [x] `Event` type and store: normalise the nine hook events into `{ts, session, branch, kind, ...}` and append per repo+branch; branch resolved via `git rev-parse --abbrev-ref HEAD` cached per session.
- [x] Command classifier: `runner_patterns` table -> `test | build | lint | git | other`; outcome from `PostToolUseFailure`, stderr heuristics, or a small per-runner "N passed / N failed" regex set (vitest, jest, pytest, go test, swift test, xcodebuild).
- [~] Extractor rules 1 and 3 built and measured; rule 2 deferred (no real `ExitPlanMode` sample exists); rules 4-5 partly covered by the evidence timeline.
- [x] Redactor with the built-in pattern set plus entropy check; `pdl redact-check`; unit tests including known false negatives documented.
- [x] Renderer to the markdown template; byte budget with truncation note; `decision-log.json` written next to the events file.
- [x] Publisher mode `body`: read-modify-write between markers via `gh pr view --json` and `gh pr edit --body-file -`; hash-based no-op; never exit non-zero.
- [x] Publisher mode `comment`: find comment containing marker via `gh api repos/{owner}/{repo}/issues/{n}/comments`, `PATCH` by id; create if absent. Do not rely on `--edit-last`.
- [x] Auto-publish on `gh pr create` and on `Stop`. Phase 0 chose post-hoc editing over a `PreToolUse` rewrite of `--body`, because parallel hooks rewriting the same tool input resolve in non-deterministic order. The PR number is re-derived from the branch rather than persisted, so it cannot go stale across a resume or rebase.
- [x] `pdl init` (writes `.claude/settings.json` or `~/.claude/settings.json`), `pdl doctor`, `pdl show`, `pdl purge`, `PDL_DISABLE`.
- [x] Claude Code plugin manifest (`hooks/hooks.json`) so install is one command; keep `pdl init` as fallback.
- [x] Config loading: repo `pdl.config.json` over user config over defaults; JSON schema file for editor completion.
- [ ] If Phase 0 showed low yield: SessionStart hook prints one line of context asking the agent to prefix non-trivial choices with `Decision:` (make it configurable and off by default if yield was fine).

Quality:
- [x] `node:test` suite: redactor, renderer, splice, classifier, store, publisher; fixtures from real sessions. Extractor still missing, since the extractor itself is not built.
- [ ] Integration test that runs `pdl hook` against 9 recorded payloads and asserts the store contents.
- [x] CI on GitHub Actions: typecheck, test, bundle, and a "dogfood" job that runs `pdl build` on a fixture and diffs against a golden markdown.
- [x] README: install, 60-second demo, what is and is not published, known gaps (thinking not available; regex redaction limits).

Definition of done: 10 consecutive PRs on your own repos carry a log that you did not hand-edit; zero hook-caused agent interruptions in that period; `pdl doctor` green on a fresh clone; `npm test` green in CI; published as `v0.1.0` on npm and installable as a Claude Code plugin.

## Phase 2 - Trust features (4-6 weeks)

Goal: the log carries evidence a reviewer can act on, and the update path works from CI too.

- [ ] Test-change analyser, timeline signal: `TEST_EDITED_AFTER_FAILURE`, `NO_TEST_RUN`, `TEST_ONLY_CHANGE` (DESIGN.md section 11).
- [x] Test-change analyser, diff signal: `ASSERTIONS_REMOVED`, `TEST_SKIPPED`, `TEST_DELETED`, `EXPECTATION_LOOSENED` for TS/JS, Python, Go, Swift regex sets; unit tests with planted-cheat fixtures (borrow the categories from assert-diff AD001-AD006 and Swarm Orchestrator's list; record precision/recall on your fixtures).
  - Measured on 320 real commits: 45 standalone removal warnings, 0 shortcuts. Removals now warn only when the timeline corroborates them; the same corpus then gives 0 warnings, 61 notes. Recall is evidenced by planted fixtures and one real agent run only, since the corpus holds no real shortcuts.
- [ ] Optional adapters that shell out to `assert-diff` (Python) or `swarm-orchestrator` (TS/JS) when installed and merge their findings into `flags`.
- [ ] GitHub Action (`geraldchang/pr-decision-log-action`): on `pull_request`, download the branch's `decision-log.json` artifact if present, or run diff-only checks, and publish (a) the sticky comment via `GITHUB_TOKEN` (`pull-requests: write`, `issues: write`) and (b) a `neutral` Check Run via `checks: write` with the flags in `output.summary`. Never `failure` unless the repo config sets `tests.gate: true`.
- [x] Multi-session merge: several sessions on one branch (including `--resume`/`--fork`) collapse into one log with per-session provenance; dedupe decisions by normalised title.
- [ ] Per-commit sections: when the PR gets new pushes, append a dated "Update" subsection rather than rewriting history, with a cap.
- [ ] Optional model summarisation (`extract.model_summary`): `pdl build --summarise` calls `claude -p` with the deterministic items and asks for at most five decisions; output labelled `model_summarised`. Off by default; document cost.
- [ ] `pdl publish --on-push` git `pre-push` hook installer, for people who push from a terminal rather than via the agent.
- [ ] Commit trailer option: `Decision-Log: <hash>` added by a `prepare-commit-msg` hook, following Entire's and Amp's precedent.
- [ ] Redaction hardening: run the redactor over 20 of your own real transcripts and count misses by hand; add patterns; document the residual risk.
- [ ] Self-measurement: log time-to-first-review for your PRs with vs without a decision log for one month; write it up honestly even if it shows nothing.

Definition of done: a planted `TEST_EDITED_AFTER_FAILURE` scenario in a demo repo is flagged in the PR body and the Checks tab; the Action runs on a fork PR without secrets; multi-session PRs render one log; redaction review documented; `v0.2.0` released.

## Phase 3 - Beyond Claude Code (open-ended)

Goal: same log, more agents and consumers; keep the schema stable.

- [ ] Adapter interface (`onSessionStart`, `onPrompt`, `onToolUse`, `onToolResult`, `onTurnEnd`, `onSubagentEnd`) with the Claude Code adapter as the reference implementation.
- [ ] Cursor adapter: `~/.cursor/hooks.json` events `sessionStart`, `beforeSubmitPrompt`, `afterFileEdit`, `beforeShellExecution`/`afterShellExecution`, `afterAgentResponse`, `afterAgentThought`, `stop`; transcript from `transcript_path`. Note Cursor exposes aggregated thinking text, so decisions may be richer.
- [ ] GitHub Copilot CLI adapter: `.github/hooks/*.json` events `sessionStart`, `userPromptSubmitted`, `preToolUse`/`postToolUse`, `agentStop`, `subagentStop`; camelCase payloads; cloud-agent subset (bash-only commands, restricted network, so publish must happen from the Action, not the hook).
- [ ] Codex CLI adapter if it gains comparable hooks (unverified today); otherwise read `~/.codex/sessions/<date>/` JSONL post-hoc like claude-replay does.
- [ ] Import from Entire checkpoints (`refs/entire/checkpoints/*`) as an alternative event source, so teams already on Entire get a PR-facing summary without a second hook set.
- [ ] Schema `pdl/1` frozen and published with a JSON Schema; changelog policy.
- [ ] Local viewer: `pdl show --html` renders the JSON to a single static page (or hand off to claude-replay with a deep link to the relevant turn).
- [ ] GitHub App (optional): lets non-Actions users get Check Runs; only if there is demand, since it adds hosting.
- [ ] GitLab MR publisher behind the publisher interface, if the author's workplace ever needs it.

Definition of done: one PR authored with Cursor and one with Copilot CLI carry logs produced by the same renderer; a schema validator passes on all fixtures; adapters have their own fixture-based tests.

## Portfolio deliverables

Do these as you go, not at the end.

- [ ] **Demo GIF** (Phase 1): 30-40 seconds, terminal on the left, GitHub PR on the right. Script: `claude` prompt -> agent edits and runs tests (one fail, one pass) -> `gh pr create` -> cut to the PR body showing Decisions, Verification table, Changes. Record with your screen recorder of choice at 1280x720; keep under 5 MB; embed at the top of the README.
- [ ] **Second GIF** (Phase 2): the `TEST_EDITED_AFTER_FAILURE` flag appearing on a planted scenario.
- [ ] **Blog post** (after Phase 1 dogfooding). Working title: "Your coding agent's reasoning is thrown away at `gh pr create`. I built a hook that keeps it." Outline:
  1. The moment: a reviewer asks "why not X?" and the answer is in a JSONL file on your laptop.
  2. The evidence, briefly: LinearB 4.6x/5.3x wait, 32.7% acceptance; Faros +91% review time; the message-code inconsistency and oracle-signal papers.
  3. What already exists and why it was not enough for me: add-reasoning-to-prs (prose, one-shot), Entire and Git AI (archive, not reviewer-facing), Copilot/Codex (only their own agents).
  4. The surprise: `thinking` blocks are empty on disk, so "capture the reasoning" is really "capture evidence plus visible rationale plus elicitation".
  5. Design: hooks -> events -> deterministic extraction -> redaction -> idempotent PR section. Why fail-open and async.
  6. Security: structural allowlist beats regex; what still leaks.
  7. Results from a month of dogfooding: decision yield per PR, redaction hits, and time-to-first-review with/without (whatever it shows).
  8. What is next (test-edit-after-failure, Cursor/Copilot adapters).
- [ ] **README quality bar**: badges for CI and npm; a "What gets published" table; a "Compared to" section that links the neighbours fairly.
- [ ] **One example PR** in a public demo repo, pinned in the README, with the log left intact.
- [ ] **Talk-track for interviews** (private notes): the schema trade-offs, the `updatedInput` vs post-publish decision, how you measured redaction misses, and what you would do with a GitHub App.
