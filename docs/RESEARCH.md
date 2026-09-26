# Research

Planning-pass research for `pr-decision-log`, done 2026-09-19. Everything stated about an external tool or API comes from a page that was fetched unless it is marked **unverified** (seen only in a search snippet). Full URL list in [SOURCES.md](SOURCES.md).

## 1. Problem evidence

| Claim | Number | Source |
| --- | --- | --- |
| AI PRs wait longer for first review | 4.6x longer pickup (16+ h vs about 200 min); agentic PRs 5.3x | LinearB 2026 Software Engineering Benchmarks, 8.1M PRs, 4,800 engineering teams |
| ...but review faster once started | about 194 vs 252 min | LinearB 2026 |
| AI PRs are accepted less | 32.7% vs 84.4% for manual PRs | LinearB 2026 |
| Independent confirmation of the wait | 4.6x longer review wait; 48-58% faster time-to-PR | Opsera 2026 AI Coding Impact Benchmark (Jan 29 2026), 250k+ developers |
| Review time grows with AI adoption | +91% PR review time, +98% PRs merged, +154% PR size, +9% bugs/dev | Faros AI "AI Productivity Paradox" (Jul 23 2025), 10k+ developers, 1,255 teams |
| Agent PR descriptions can lie | 1.7% of 23,247 agent PRs had high message-code inconsistency; those were accepted 28.3% vs 80.0% and took 3.5x longer (55.8 h vs 16.0 h) | arXiv 2601.04886 |
| Agent tests often assert nothing | 80.2% of 86,156 agent test patches had weak/no oracle signals; strong oracles raise merge odds (OR 1.28, p<0.001) | arXiv 2606.18168 (IEEE AITest 2026) |
| The "first human" framing and the ask for decision logs | Recommends requiring decision logs of agent reasoning, heightened scrutiny for test changes, CI gates reviewers cannot weaken | Addy Osmani, "Agentic code review" |

Note on the "91%" figure: in the brief it was attributed to Opsera/LinearB. Fetched pages attribute the 91% review-time increase to **Faros AI**; Opsera and LinearB both report the **4.6x** wait. Cite accordingly.

Takeaway: the bottleneck is triage and trust before review begins, plus the reviewer's inability to verify claims in the description. A decision log attacks both: it gives the triaging reviewer a reason to pick the PR up, and it makes claims ("tests pass", "no behaviour change") checkable against a recorded timeline.

## 2. Prior art

Honest summary first: **nothing found does exactly this**, but two neighbours are close enough that you must differentiate deliberately.

- `add-reasoning-to-prs` already solves "agent writes a why-block into the PR at `gh pr create`" for Claude Code, is MIT, zero-dependency TypeScript, and installs with one `npx` command. If your MVP is only that, it is redundant. Its author explicitly keeps it prose-only, not post-hoc, single-session and small. Your room is: structured schema, timeline evidence (what was run, what failed, what was edited after), idempotent updates on later pushes, test-tampering flags, and multi-agent adapters.
- Entire CLI and Git AI capture far more than you will (full transcripts per commit, per-line authorship) but store it in git refs/notes and dashboards, not on the PR. They are the "archive"; you are the "reviewer-facing summary". Design the JSON schema so a Phase 3 adapter could read from an Entire checkpoint instead of the raw transcript.

| Name | Link | What it does | Gap relative to pr-decision-log |
| --- | --- | --- | --- |
| add-reasoning-to-prs (Backthread) | https://github.com/backthread/add-reasoning-to-prs | Claude Code `PreToolUse` hook fires on `gh pr create` (and direct pushes to default branch). Asks the agent to compose Decisions / Trade-offs / Assumptions / Limitations from its own session, wrapped in invisible markers to prevent duplication, with a "never fabricate; empty is fine" self-check. Node >=22.18, TS, zero deps, MIT, 35 stars, plugin version available. Roadmap: Cursor and Codex, browser-opened PRs. | Prose only, no schema or JSON artifact. Not post-hoc: does not update after PR creation. No evidence timeline (commands run, tests failed, files touched). No test-tampering detection. Relies entirely on the model's self-report (the exact thing arXiv 2601.04886 says is unreliable). Claude Code only. |
| Entire CLI | https://github.com/entireio/cli | Go, MIT. Hooks into Claude Code, Codex, Copilot CLI, Cursor, Droid, Gemini, OpenCode, Pi. Captures transcripts, prompts, files touched, token usage, tool calls per commit into `refs/entire/checkpoints/<shard>/<id>`; adds `Entire-Checkpoint: <id>` trailer to commits; never commits to the active branch. Experimental `entire review/why/blame`. $60M seed. | No PR comment/body/check output documented. Raw capture, not a reviewer summary. Heavy (Go daemon-style CLI, dashboard). A well-funded team; do not compete on capture breadth. |
| Git AI | https://usegitai.com/docs/agents/claude-code | Installs `PreToolUse`/`PostToolUse` hooks on `Write|Edit|MultiEdit` (Claude Code, Cursor, Copilot in VS Code); records per-line human vs AI authorship and prompts into git notes; survives rebase/squash. | Attribution, not reasoning. No PR surface documented. |
| claude-replay (es617) | https://github.com/es617/claude-replay | Node 18+. Turns Claude Code / Cursor / Codex CLI / Gemini CLI / OpenCode / Kimi / Hermes JSONL into one self-contained HTML replay with thinking/tool toggles. Documents transcript locations per agent. | Replay of everything, no extraction, no PR integration. Useful as a reference parser for multiple agents' JSONL. |
| agent-flow, claude-trace-replay, tanghong123/claude-replay, agent-sessions | see SOURCES.md | Viewers/visualizers of local sessions (**unverified**, search only). | Local viewing only. |
| Amp (Sourcegraph) thread trailer | https://github.com/sourcegraph/docs/pull/1993 | Commits carry `Amp-Thread-ID: https://ampcode.com/threads/...` so reviewers can open the hosted thread (**unverified**, seen in PR commit messages). | Link to a hosted transcript, not a summary; Amp only; requires their cloud. Good precedent for a `Decision-Log:` commit trailer. |
| GitHub Copilot coding agent sessions | https://github.blog/changelog/2026-03-19-more-visibility-into-copilot-coding-agent-sessions/ | Session logs (setup steps, subagent activity) are viewable from the PR for Copilot-authored PRs. | Only for Copilot's own cloud agent; nothing for locally-run agents; a log, not a decision summary. |
| GitHub Copilot PR summary | https://docs.github.com/copilot/using-github-copilot/creating-a-pull-request-summary-with-github-copilot | "Summary" button drafts prose + bullets from the **diff** (**unverified** details; not on Copilot Free). | Diff-derived; cannot know why. Same limitation as PR-Agent and other diff-based describers. |
| OpenAI Codex cloud | https://learn.chatgpt.com/docs/cloud | Shows summary and diff, then opens a PR. Search snippets claim citations of terminal logs (**unverified**); the fetched page does not document PR body contents. | Codex cloud only; opaque format. |
| Claude Code cloud sessions | https://code.claude.com/docs/en/claude-code-on-the-web | Session share links (Private/Public or Private/Team), diff view, PR creation from the session. | Docs do not describe placing a session link or summary in the PR. Cloud-only. |
| claude-code-action | https://code.claude.com/docs/en/github-actions | Posts a progress/result comment on the triggering issue/PR; review workflow posts inline comments. | Runs Claude in CI; no decision log for locally-authored PRs. Discussion #720 (**unverified**) shows users wanting "update one comment, don't add new ones", which is your sticky-comment feature. |
| assert-diff (OutVersus) | https://github.com/OutVersus/assert-diff | Python-only AST comparison of test files: deleted tests, fewer assertions, changed expectations, new skip/xfail, fewer params, trivially passing asserts (AD001-AD006). Text/Markdown/JSON/GitHub annotations output; composite Action. | Python only; diff only, no session timeline. Reuse the finding taxonomy. |
| Swarm Orchestrator (moonrunnerkc) | https://dev.to/moonrunnerkc/catching-the-shortcuts-ai-coding-agents-take-to-look-done-45mm | 11 offline diff checks for TS/JS (8 default): errors swallowed, unfinished renames, coverage reduced, tests weakened, assertions removed, new `@ts-ignore`/`eslint-disable`, test-only fixes, mocks of missing modules. 84% recall on 300 planted cheats; 0.11 false alarms/PR. Node 20+, ISC. | Diff only. Cannot see "agent edited the test right after the test failed", which only a session timeline shows. |
| PR-Agent (Qodo) | https://github.com/The-PR-Agent/pr-agent | Diff-based describe/review bot (**unverified** details). | No session access. |

Where the gap is, concretely:

1. **Evidence, not just self-report.** The timeline (commands, exit codes, test runs, edits, subagents) is deterministic data from hooks; the "why" is model text. Show both and label which is which.
2. **Idempotent, post-hoc updates.** One log per PR that is re-rendered on every push, with per-commit sections.
3. **Structured artifact** (`decision-log.json`, versioned) plus rendered markdown.
4. **Test-change scrutiny** using the timeline (Phase 2).
5. **Adapter model** so Cursor and Copilot CLI hooks feed the same schema (Phase 3).

## 3. Claude Code hooks reference (relevant subset)

Source: https://code.claude.com/docs/en/hooks and https://code.claude.com/docs/en/hooks-guide. Verify field names in the Phase 0 spike by logging raw stdin; the docs have changed field names before.

### Events that matter

| Event | Fires | Use in pr-decision-log |
| --- | --- | --- |
| `SessionStart` | session begins or resumes (`start_reason`: startup, resume, clear, compact, fork) | Open a session record; capture `session_id`, `cwd`, git branch, model. Plain-text stdout becomes context Claude sees, so you can inject a one-line instruction ("state your reasoning before non-trivial edits") here. |
| `UserPromptSubmit` | before Claude processes a prompt; input has `user_message` | Record human intent. Exit 2 can block, so never exit 2. 30 s default timeout. |
| `PreToolUse` | before a tool call; `tool_name`, `tool_input`, `tool_use_id`; can block/modify | Match `Bash` with `if: "Bash(gh pr create*)"` to build and inject the log into `--body` (via `updatedInput`) or to run the publish step. Also record test-run intent (`npm test`, `pytest`, `go test`, `swift test`). |
| `PostToolUse` | after a tool succeeds; adds tool output (reference lists `tool_result`; older docs used `tool_response`; confirm) | Record edits (`Edit`, `Write`, `MultiEdit`, `NotebookEdit`) and command results (exit status inferred from output/stderr). Cannot block. Run with `async: true` to keep the loop fast. |
| `PostToolUseFailure` | after a tool fails; has `error` | Record failed commands (failing test runs are the key signal). |
| `Stop` | Claude finishes a turn; `last_assistant_message`, `stop_reason` | Checkpoint the session: snapshot decisions so far, update the local log. Check `stop_hook_active` and never exit 2 (would force continuation). |
| `SubagentStop` | subagent finishes; `agent_id`, `agent_type`, `last_assistant_message` | Record delegated work summaries (e.g. a review subagent's findings). |
| `PreCompact` | before compaction (`compact_reason`: manual, auto) | Flush anything derived from in-memory transcript state; after compaction the visible history changes. |
| `SessionEnd` | session ends (`end_reason`) | Final flush. All SessionEnd hooks share a 1.5 s budget by default. |
| `PermissionRequest`, `Notification`, `TaskCompleted` | | Optional: `TaskCompleted` could mark task boundaries in the log. |

### Common input fields (stdin JSON, all events)

```json
{
  "session_id": "abc123",
  "prompt_id": "550e8400-e29b-41d4-a716-446655440000",
  "transcript_path": "/Users/you/.claude/projects/-Users-you-repo/abc123.jsonl",
  "cwd": "/Users/you/repo",
  "scratchpad_dir": "/tmp/claude-501/-Users-you-repo/abc123/scratchpad",
  "permission_mode": "default",
  "effort": { "level": "medium" },
  "hook_event_name": "PreToolUse",
  "agent_id": "subagent-uuid",
  "agent_type": "Explore"
}
```

`transcript_path` is written asynchronously and may lag the hook; do not rely on the last line being the current event. `agent_id`/`agent_type` are present only inside subagents. `prompt_id` needs v2.1.196+, `scratchpad_dir` v2.1.257+.

### Event-specific examples

PreToolUse on the PR-creation command (the interception point):

```json
{
  "hook_event_name": "PreToolUse",
  "tool_name": "Bash",
  "tool_use_id": "toolu_01ABC",
  "tool_input": {
    "command": "gh pr create --title \"Add retry to sync job\" --body \"...\"",
    "description": "Open pull request",
    "timeout": 120000
  }
}
```

PostToolUse on an edit:

```json
{
  "hook_event_name": "PostToolUse",
  "tool_name": "Edit",
  "tool_use_id": "toolu_01DEF",
  "tool_input": {
    "file_path": "/Users/you/repo/src/sync.ts",
    "old_string": "retries: 0",
    "new_string": "retries: 3",
    "replace_all": false
  },
  "tool_result": { "type": "text", "text": "The file /Users/you/repo/src/sync.ts has been updated successfully." }
}
```

Stop:

```json
{
  "hook_event_name": "Stop",
  "session_id": "abc123",
  "transcript_path": "...",
  "stop_reason": "end_turn",
  "last_assistant_message": "Added retry with backoff; chose 3 attempts because ...",
  "stop_hook_active": false
}
```

### Configuration (settings.json)

```json
{
  "hooks": {
    "SessionStart": [{ "hooks": [{ "type": "command", "command": "pdl hook", "timeout": 5 }] }],
    "UserPromptSubmit": [{ "hooks": [{ "type": "command", "command": "pdl hook", "timeout": 5 }] }],
    "PreToolUse": [
      { "matcher": "Bash", "hooks": [{ "type": "command", "command": "pdl hook", "if": "Bash(gh pr create*)", "timeout": 60 }] },
      { "matcher": "Bash", "hooks": [{ "type": "command", "command": "pdl hook", "async": true }] }
    ],
    "PostToolUse": [
      { "matcher": "Edit|Write|MultiEdit|NotebookEdit|Bash", "hooks": [{ "type": "command", "command": "pdl hook", "async": true }] }
    ],
    "PostToolUseFailure": [{ "matcher": "Bash", "hooks": [{ "type": "command", "command": "pdl hook", "async": true }] }],
    "Stop": [{ "hooks": [{ "type": "command", "command": "pdl hook", "timeout": 20 }] }],
    "SubagentStop": [{ "hooks": [{ "type": "command", "command": "pdl hook", "async": true }] }],
    "PreCompact": [{ "hooks": [{ "type": "command", "command": "pdl hook", "timeout": 10 }] }]
  }
}
```

Facts that shape the design:

- Scope: `~/.claude/settings.json` (all projects), `.claude/settings.json` (committed, shared), `.claude/settings.local.json` (gitignored), plugin `hooks/hooks.json`. A **plugin** is the cleanest distribution (like add-reasoning-to-prs offers).
- Matchers: exact tool names, `A|B` lists, or regex when other characters are present. `if` takes a permission-rule string such as `Bash(gh pr create*)` to filter tool events.
- All matching hooks run **in parallel**. Default `timeout` is 600 s for command hooks, 30 s for `UserPromptSubmit`. `async: true` runs in the background and ignores timeout; `asyncRewake: true` can wake Claude on exit 2.
- Exit 0 with JSON stdout is honoured; exit 2 blocks on blockable events (`PreToolUse`, `UserPromptSubmit`, `Stop` continues the conversation). Other exit codes are non-blocking errors shown as a notice. Design rule: **the hook must never exit 2 by accident**; wrap everything, exit 0.
- `PreToolUse` can return `hookSpecificOutput.updatedInput` to rewrite the tool input, which is how you can inject the rendered log into `gh pr create --body` without racing the agent.
- Plain-text stdout on `SessionStart` and `UserPromptSubmit` is added to Claude's context; on other events it is only logged.
- Hooks also come in `prompt` and `agent` types: a `Stop` hook of `type: "prompt"` could ask a fast model "list decisions made this turn as JSON" with `$ARGUMENTS`. Useful as an optional extractor (Phase 2), but it costs tokens on every turn.
- Test a hook offline: `echo '{"tool_name":"Bash","tool_input":{"command":"ls"}}' | ./my-hook.sh`.

## 4. Transcript JSONL format

From reading 10 transcripts on this machine (Claude Code 2.1.239-2.1.252). Undocumented and subject to change; treat the hook payloads as the primary source and the transcript as a secondary, best-effort source.

Location: `~/.claude/projects/<cwd with "/" replaced by "-">/<session_id>.jsonl`, e.g. `~/.claude/projects/-Users-geraldchang-Documents-Github-CreativeNotch/46c0f487-....jsonl`. The same path arrives as `transcript_path` in every hook payload, so you never need to derive it. Where subagent transcripts live is **unverified** (all sampled records had `isSidechain: false`).

One JSON object per line. Top-level `type` values seen and their counts in one 200-line file: `assistant` 63, `attachment` 41, `user` 31, `system` 16, plus small bookkeeping records `last-prompt`, `mode`, `permission-mode`, `atis-latch`, `ai-title`, `file-history-snapshot`.

Common envelope on `user`/`assistant` records:

```json
{
  "type": "assistant",
  "uuid": "60d6a6c2-...",
  "parentUuid": "2756293a-...",
  "isSidechain": false,
  "sessionId": "07186baf-...",
  "session_id": "07186baf-...",
  "requestId": "req_011Cej...",
  "promptId": "9250057b-...",
  "timestamp": "2026-09-04T23:27:28.538Z",
  "cwd": "/Users/geraldchang",
  "gitBranch": "HEAD",
  "version": "2.1.252",
  "effort": "high",
  "userType": "external",
  "entrypoint": "cli",
  "attributionSkill": "superpowers:brainstorming",
  "message": { "...": "Anthropic Messages API shape" }
}
```

`message` follows the Messages API: `role`, `content[]` with blocks of type `text`, `thinking`, `tool_use` (`id`, `name`, `input`), `tool_result` (`tool_use_id`, `content`). Assistant records also carry `model`, `stop_reason`, `usage`. A single assistant turn is split across several lines (one per content block, same `requestId`), so group by `requestId` when reconstructing a turn.

**Thinking is not available.** Across all 10 files, 1,260 `thinking` blocks were found; 1,256 had `"thinking": ""` with only a `signature`. Whatever the reason (redaction, or only the signature being persisted), the hidden reasoning cannot be recovered from disk. The decision log has to be built from:

1. assistant `text` blocks (the agent's visible explanations, which in practice state the rationale right before edits),
2. `tool_use` blocks and their `tool_result`s (deterministic evidence),
3. `user` prompts (`type: "user"` without `isMeta: true`),
4. `AskUserQuestion` tool calls and their answers (explicit human decisions),
5. `ExitPlanMode` / plan-mode content (design decisions),
6. explicit elicitation: a `Stop`-time prompt or a CLAUDE.md convention asking the agent to state decisions.

Cursor, by contrast, exposes `afterAgentThought` with "fully aggregated thinking text" in its hooks, so a Cursor adapter could get more than Claude Code gives you.

Useful structured fields on tool-result records (`toolUseResult`, sibling of `message`):

- Edit: `{ filePath, oldString, newString, originalFile, structuredPatch: [{oldStart, oldLines, newStart, newLines, lines[]}], userModified, replaceAll }`. This is a ready-made unified-diff hunk per edit.
- Bash: `{ stdout, stderr, interrupted, isImage, noOutputExpected }`. No exit code field observed; infer failure from stderr/`PostToolUseFailure` or by wrapping test commands.
- Skill: `{ success, commandName }`.

Tool names observed: `Bash` (by far the most), `Agent`, `Edit`, `Write`, `AskUserQuestion`, `Read`, `Skill`, `WebSearch`, `WebFetch`, `SendMessage`, `ToolSearch`, `EnterWorktree`, `ExitWorktree`, `Monitor`, `Workflow`, `Artifact`.

`attachment` records include `hook_success` / `hook_additional_context` entries with hook stdout, so your own hook output also lands in the transcript; keep it small.

Sizes: 400 KB to 10 MB per session file here. Stream-parse, never `JSON.parse` the whole thing.

## 5. Other agents' hooks (for Phase 3 adapters)

| | Claude Code | Cursor | GitHub Copilot CLI / cloud agent |
| --- | --- | --- | --- |
| Config | `settings.json` `hooks` block; plugin `hooks/hooks.json` | `~/.cursor/hooks.json`, `<project>/.cursor/hooks.json` | `.github/hooks/*.json`, `~/.copilot/hooks/*.json`, `.github/copilot/settings.json`; cloud agent reads only `.github/hooks/*.json` |
| Transport | stdin JSON, stdout JSON, exit codes; also http/mcp_tool/prompt/agent hook types | spawned process, JSON over stdio; `command` or `prompt` type | command (`bash`/`powershell`/`exec`), http, prompt; camelCase payloads |
| Session start | `SessionStart` | `sessionStart` | `sessionStart` (`sessionId`, `cwd`, `source`, `initialPrompt?`) |
| Prompt | `UserPromptSubmit` (`user_message`) | `beforeSubmitPrompt` | `userPromptSubmitted` (`prompt`) |
| Tool before/after | `PreToolUse`/`PostToolUse`/`PostToolUseFailure` | `preToolUse`/`postToolUse`/`postToolUseFailure`, plus `beforeShellExecution`/`afterShellExecution`, `afterFileEdit` (`file_path`, `edits[{old_string,new_string}]`) | `preToolUse`/`postToolUse`/`postToolUseFailure` (`toolName`, `toolArgs`, `toolResult`) |
| Turn end | `Stop` (`last_assistant_message`) | `stop` (`status`, `loop_count`), `afterAgentResponse` (`text`), `afterAgentThought` (`text`, `duration_ms`) | `agentStop` (`transcriptPath`, `stopReason`, `stop_hook_active`) |
| Subagents | `SubagentStart`/`SubagentStop` | `subagentStart`/`subagentStop` | `subagentStart`/`subagentStop` (`agentName`, `response`) |
| Compaction | `PreCompact`/`PostCompact` | `preCompact` | `preCompact` |
| Transcript path | `transcript_path` on every event | `transcript_path` (null if disabled) and `CURSOR_TRANSCRIPT_PATH`; transcripts under `~/.cursor/projects/<project>/agent-transcripts/<id>/` | `transcriptPath` on `agentStop`, `subagent*`, `preCompact` only |
| Timeout default | 600 s command (30 s `UserPromptSubmit`) | configurable `timeout` | 30 s; timeouts always fail-open; `preToolUse` non-zero exit fails closed |

The event set is close enough that a single adapter interface (`onSessionStart`, `onPrompt`, `onToolUse`, `onToolResult`, `onTurnEnd`, `onSubagentEnd`) covers all three.

## 6. GitHub attachment options

| Option | Mechanism | Update without duplicating | Auth needed | Pros | Cons |
| --- | --- | --- | --- | --- | --- |
| A. PR body section between markers | `gh pr view --json body`, splice between `<!-- pdl:start -->`/`<!-- pdl:end -->`, `gh pr edit --body-file -` (or `PATCH /repos/{o}/{r}/pulls/{n}`) | Replace text between markers; create section if absent | Author's own `gh` login; no extra permissions | Visible at the top of the review; survives in the squash-merge commit body if the repo uses "PR body" as message; works from a laptop with zero CI | Body limit 65,536 chars shared with the human description; `--body` replaces the whole body so you must read-modify-write (race with the human editing the description); edits by others overwrite your section |
| B. Sticky bot comment | `gh pr comment --edit-last --create-if-none --body-file -`, or `POST/PATCH /repos/{o}/{r}/issues/{n}/comments` finding your marker | `--edit-last` edits the current user's last comment; safer: list comments, find the one containing the marker, PATCH by id | Same as A | Does not touch the human's description; separate 65,536 budget; history of edits visible | Sinks below review threads; `--edit-last` picks the wrong comment if you posted something else after it (use marker search) |
| C. Check Run with markdown summary | `POST/PATCH /repos/{o}/{r}/check-runs` with `output.title/summary/text`, `conclusion` | Update by `check_run_id`, one per head SHA | **GitHub App only**; PATs and OAuth cannot create check runs. In Actions, `GITHUB_TOKEN` with `permissions: checks: write` works ("`checks: write` permits an action to create a check run") | Shows in the Checks tab and the merge box; can carry a `neutral`/`failure` conclusion for the test-tampering gate; per-commit by construction | Needs CI or an App; markdown lives in the Checks tab where fewer reviewers look; `text` length limits undocumented |
| D. Commit status | `POST /repos/{o}/{r}/statuses/{sha}` with `state`, `context`, `description`, `target_url` | New status per SHA replaces same `context` | Push access | Works with a PAT; simplest gate | Description only, no markdown; must link elsewhere |
| E. Committed file `.decisions/<branch>.json` (or `docs/decisions/`) | Write file, commit on the branch | Overwrite on branch | None | Reviewable as part of the diff; permanent; feeds Phase 3 tooling | Pollutes the diff and history; merge conflicts across branches; reviewers may object to bot commits; secrets risk if redaction fails |
| F. Commit trailer `Decision-Log: <id>` | Add trailer at commit time (Entire and Amp precedent) | n/a | None | Ties log to commits; zero GitHub API | Needs somewhere to resolve the id |

Recommendation: **A for the MVP** (author-run, no CI, most visible), **B as a config switch** for teams that protect the description, **C in Phase 2** via a small GitHub Action for the test-tampering gate. Store `decision-log.json` locally and optionally as E later. Always search for the marker rather than trusting `--edit-last`.

Update algorithm (A):

1. `gh pr view --json number,body,headRefOid,url`.
2. If body contains both markers, replace the inner text; else append `\n\n<!-- pdl:start -->...<!-- pdl:end -->`.
3. Include `headRefOid` and a content hash inside the marker comment (`<!-- pdl:start sha=abc123 hash=... -->`) so a no-op re-run skips the write.
4. `gh pr edit <n> --body-file -`.
5. Enforce a byte budget (for example 20,000 chars for the log) and truncate with a "see decision-log.json" note.

## 7. Open questions

1. **How much of the "why" is recoverable without elicitation?** Thinking is empty on disk. Measure on 10 real sessions: what fraction of edits are preceded by an assistant `text` block that states rationale? If low, the SessionStart context injection ("state decisions as `Decision:` lines") becomes MVP, not optional.
2. **PostToolUse field name** for tool output: reference says `tool_result`; verify by logging raw stdin. Also confirm whether `Bash` results expose an exit code anywhere.
3. **Where do subagent transcripts live** and do their hook payloads carry the parent `session_id`? Needed to attribute delegated work.
4. **`updatedInput` on `gh pr create`**: does rewriting `--body` inside the command string work reliably with quoting, or is it safer to let the create happen and run `pdl publish` from a `PostToolUse` on the same command?
5. **Multiple sessions per branch**: how to merge logs from several sessions (and `--resume`/`--fork`) into one PR log. add-reasoning-to-prs uses a per-branch scratchpad; likely the same approach (key by repo + branch).
6. **Should the log ever be model-summarised?** A `prompt`-type Stop hook would produce cleaner decisions but adds cost and reintroduces the self-report problem. Proposal: deterministic extraction by default, optional summarisation clearly labelled "model-written".
7. **Squash merges**: if the PR body becomes the squash commit message, is a long log welcome in git history? Config option to trim to a "Summary" subsection on merge, or use B.
8. **Redaction confidence**: what is the false-negative rate of regex secret detection on real transcripts? Consider a hard rule: never publish any tool output text, only file paths, command names and pass/fail.
9. **Windows**: hooks default to PowerShell if Git Bash is absent; is Windows in scope at all for Phase 1? (Proposal: no.)
10. **Does a log actually change pickup time?** Plan a tiny self-measurement: time-to-first-review on your PRs with vs without the log over a month. Even n=20 is a better portfolio story than none.
