# Sources

Every URL consulted for this planning pass, one line each. "Fetched" means the page content was read; "search result only" means the title/snippet was seen but the page was not opened, so claims based on it are marked unverified in the other docs.

## Problem evidence

- https://addyosmani.com/blog/agentic-code-review/ (fetched) - "first human being to ever lay eyes on this code"; recommends requiring decision logs of agent reasoning and heightened scrutiny of test changes; aggregates GitClear/Faros/CodeRabbit stats.
- https://linearb.io/resources/software-engineering-benchmarks-report (fetched) - 8.1M PRs, 4,800 engineering teams; AI PRs wait 4.6x longer for pickup, agentic 5.3x, reviewed 2x faster once started; acceptance 32.7% vs 84.4%.
- https://opsera.ai/newsroom/new-opsera-report-reveals-how-ai-is-transforming-software-delivery-and-driving-business-outcomes/ (fetched) - 2026 AI Coding Impact Benchmark, Jan 29 2026, 250k+ developers; 4.6x longer review wait; 48-58% faster time-to-PR.
- https://www.faros.ai/blog/ai-software-engineering (fetched) - AI Productivity Paradox, Jul 23 2025, 10k+ developers, 1,255 teams; 98% more PRs merged, 91% longer review time, 154% larger PRs, 9% more bugs per developer.
- https://arxiv.org/abs/2601.04886 (fetched) - Message-code inconsistency in agent PRs: 23,247 PRs; high-inconsistency PRs (1.7%) accepted 28.3% vs 80.0%, 3.5x longer to merge; most common type is describing unimplemented changes.
- https://arxiv.org/abs/2606.18168 (fetched) - "All Smoke, No Alarm": 86,156 test patches from 33,596 agent PRs; 80.2% weak or no oracle signals; strong oracles raise merge odds (OR 1.28).
- https://prlens.dev/guides/why-ai-pull-requests-wait-longer-for-review (fetched) - Secondary write-up of LinearB numbers; AI PRs 408 vs 157 lines at p75; argues descriptions should explain "what changed and why, in the terms of the system".

## Prior art

- https://github.com/backthread/add-reasoning-to-prs (fetched) - Closest prior art. Claude Code PreToolUse hook that has the agent write a Decisions/Trade-offs/Assumptions/Limitations block into the PR body at `gh pr create`; prose only, not post-hoc, single tool, explicitly scoped to stay small. 35 stars at fetch time.
- https://github.com/entireio/cli (fetched) - Entire CLI (Go, MIT): captures transcripts/prompts/tool calls per commit into `refs/entire/checkpoints/*` with an `Entire-Checkpoint:` commit trailer; multi-agent; no PR posting documented.
- https://usegitai.com/docs/agents/claude-code (fetched) - Git AI: PreToolUse/PostToolUse hooks on Write|Edit|MultiEdit record per-line AI authorship and prompts into git notes; no PR surface documented.
- https://github.com/es617/claude-replay (fetched) - Converts Claude Code/Cursor/Codex/Gemini/OpenCode/Kimi/Hermes transcripts to a self-contained HTML replay; lists transcript directories per agent; no PR integration.
- https://github.com/patoles/agent-flow (search result only) - Real-time visualization of Claude Code agent orchestration from JSONL logs.
- https://github.com/harrylettering/claude-trace-replay (search result only) - Trace viewer for Claude Code sessions.
- https://github.com/tanghong123/claude-replay (search result only) - Read-only viewer for Claude Code transcripts.
- https://github.com/sshh12/agent-pr-replay (search result only) - Replays merged PRs through Claude Code to compare agent vs human; unrelated to attaching logs.
- https://github.com/jazzyalex/agent-sessions (search result only) - macOS app to browse local sessions across many agents.
- https://github.com/sourcegraph/docs/pull/1993 (search result only) - Example of Amp's `Amp-Thread-ID:` commit trailer linking to a hosted thread.
- https://github.com/OutVersus/assert-diff (fetched) - Python-only AST diff of test expectations (AD001-AD006: deleted tests, fewer assertions, changed expectations, new skips, fewer params, trivially passing); GitHub Action emits annotations.
- https://dev.to/moonrunnerkc/catching-the-shortcuts-ai-coding-agents-take-to-look-done-45mm (fetched) - Swarm Orchestrator: 11 diff checks for TS/JS (8 on by default) incl. tests weakened, assertions removed, coverage reduced; 84% recall on planted cheats; offline, Node 20+, ISC.
- https://github.com/moonrunnerkc/swarm-orchestrator (search result only) - Repo for the above.
- https://github.blog/changelog/2026-03-19-more-visibility-into-copilot-coding-agent-sessions/ (fetched) - Copilot coding agent session logs show setup steps and subagent activity to people viewing the session.
- https://docs.github.com/copilot/using-github-copilot/creating-a-pull-request-summary-with-github-copilot (search result only) - Copilot "Summary" button generates a prose overview plus bullet list from the diff; not available on Copilot Free.
- https://learn.chatgpt.com/docs/cloud (fetched; redirect from https://developers.openai.com/codex/cloud) - Codex cloud: review summary and diff, then open a PR; page does not document PR body contents or reviewer-visible logs.
- https://docs.devin.ai/work-with-devin/devin-review (search result only) - Devin sessions expose planner/shell; PR body contents unverified.
- https://code.claude.com/docs/en/claude-code-on-the-web (fetched) - Cloud sessions can be shared by link (Private/Public or Private/Team) and expose a diff view; docs do not describe a session link or summary being placed in the PR body.
- https://code.claude.com/docs/en/github-actions (fetched) - claude-code-action posts progress/results as a comment on the triggering issue/PR; review workflow posts inline comments; no reasoning log feature.
- https://github.com/anthropics/claude-code-action/discussions/720 (search result only) - Users asking how to make Claude update one PR comment instead of adding new ones; motivates the sticky-comment design.
- https://github.com/The-PR-Agent/pr-agent (search result only) - Diff-based PR describe/review bot; no access to the agent session.

## Claude Code hooks and transcripts

- https://code.claude.com/docs/en/hooks (fetched) - Hooks reference: all events, common input fields (`session_id`, `transcript_path`, `cwd`, `hook_event_name`, `permission_mode`, `prompt_id`), per-event fields, settings schema (`matcher`, `if`, `timeout`, `async`, `asyncRewake`), exit codes and JSON output, parallel execution, timeout defaults.
- https://code.claude.com/docs/en/hooks-guide (fetched) - Hook cookbook; `stop_hook_active` handling; testing a hook with `echo '{...}' | ./my-hook.sh`.
- Local inspection of `~/.claude/projects/*/*.jsonl` on 2026-09-19 (10 files, Claude Code 2.1.239-2.1.252) - record types, key sets, content block types, empty `thinking` text, `toolUseResult` shapes. Not a web source; details in RESEARCH.md.

## Other agents' hooks

- https://cursor.com/docs/agent/hooks (fetched) - Cursor hooks.json events (`stop`, `afterFileEdit`, `afterAgentResponse`, `afterAgentThought`, `beforeSubmitPrompt`, `preCompact`, etc.), base input incl. `transcript_path` and `conversation_id`, locations `~/.cursor/hooks.json` and `<project>/.cursor/hooks.json`.
- https://docs.github.com/en/copilot/reference/hooks-reference (fetched) - Copilot hooks: events (`sessionStart`, `userPromptSubmitted`, `preToolUse`, `postToolUse`, `agentStop`, `subagentStop`, `preCompact`, ...), camelCase fields, `transcriptPath` on some events, config in `.github/hooks/*.json`, 30s default timeout, cloud agent subset.

## GitHub integration

- https://cli.github.com/manual/gh_pr_edit (fetched) - `--body`/`--body-file -` replace the whole body; target by number/url/branch or current branch.
- https://cli.github.com/manual/gh_pr_comment (fetched) - `--edit-last`, `--create-if-none` (only with `--edit-last`), `--delete-last`, `--body-file -`.
- https://cli.github.com/manual/gh_pr_view (fetched) - `--json` fields incl. `body`, `number`, `url`, `headRefOid`, `headRefName`, `baseRefName`, `comments`, `commits`; `--jq`.
- https://cli.github.com/manual/gh_api (fetched) - `-X PATCH`, `-f`/`-F`, `@file`, `--input`, `--jq`, `{owner}/{repo}` placeholders.
- https://docs.github.com/en/rest/pulls/pulls (fetched) - `PATCH /repos/{owner}/{repo}/pulls/{pull_number}` with `body`; `GET` returns `body`, `head.sha`, `number`, `html_url`.
- https://docs.github.com/en/rest/issues/comments (fetched) - `POST .../issues/{n}/comments`, `PATCH .../issues/comments/{id}`, `GET`, `DELETE`.
- https://docs.github.com/en/rest/checks/runs (fetched) - Check runs require a GitHub App; PATs and OAuth apps cannot create or update them; `output.title/summary/text` (markdown); conclusion values.
- https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#permissions (fetched) - "`checks: write` permits an action to create a check run"; `issues: write` for comments; unspecified permissions default to none when any is specified.
- https://docs.github.com/en/rest/commits/statuses (fetched) - `POST /repos/{owner}/{repo}/statuses/{sha}` with `state`, `context`, `target_url`, `description`; push access suffices.
- https://github.com/orgs/community/discussions/27190 (fetched) - GitHub staff: PR body / issue comment limit is 65,536 4-byte Unicode characters (262,144-byte mediumblob).

## Tech stack

- https://bun.com/docs/bundler/executables (fetched) - `bun build ./cli.ts --compile --outfile mycli`; cross-compile targets for linux/windows/darwin x64 and arm64; bytecode option to cut startup.
- Local measurement on 2026-09-19 (Apple M5, Node v26.3.1, Python 3.14.6, jq 1.7.1) - `node -e ""` about 40 ms wall, `python3 -c "import json,sys"` about 10 ms, `jq`/`bash` under 10 ms. Not a web source; used for the hook-latency discussion in DESIGN.md.
