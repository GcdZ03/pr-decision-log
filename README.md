# pr-decision-log

**Status: Planning** (no code yet; see [docs/ROADMAP.md](docs/ROADMAP.md))

`pr-decision-log` captures what an AI coding agent decided while it worked (Claude Code first, Cursor and Copilot CLI later) and attaches a structured, redacted **decision log** to the resulting pull request. The reviewer gets the agent's intent, the alternatives it rejected, the assumptions it made, what it verified and how, and a flag on any test it edited after a failing run, instead of being, in Addy Osmani's words, "the first human being to ever lay eyes on this code."

## The problem

- **AI PRs sit in the queue.** LinearB's 2026 benchmarks (8.1M PRs, 4,800+ orgs) found AI-generated PRs wait **4.6x longer** for a first review, agentic PRs **5.3x**, and are accepted **32.7%** of the time vs **84.4%** for manual PRs; once picked up they are reviewed about 2x faster, so the cost is trust and triage, not reading. ([source](https://linearb.io/resources/software-engineering-benchmarks-report))
- **Review is the bottleneck, not generation.** Faros AI (10,000+ developers, 1,255 teams): high-AI-adoption teams merge **98% more PRs**, but PR review time rises **91%** and PR size **154%**. ([source](https://www.faros.ai/blog/ai-software-engineering)) Opsera's 2026 benchmark (250k+ developers) reports the same 4.6x wait alongside 48-58% faster time-to-PR. ([source](https://opsera.ai/newsroom/new-opsera-report-reveals-how-ai-is-transforming-software-delivery-and-driving-business-outcomes/))
- **Agent descriptions are not trustworthy on their own.** In a study of 23,247 agent-authored PRs, descriptions that claimed unimplemented changes were the most common inconsistency; inconsistent PRs were accepted 28.3% vs 80.0% and took 3.5x longer to merge. ([arXiv 2601.04886](https://arxiv.org/abs/2601.04886))
- **Agent-written tests often verify nothing.** 80.2% of 86,156 agent-authored test patches had weak or no explicit assertions. ([arXiv 2606.18168](https://arxiv.org/abs/2606.18168)) Osmani's recommendations include requiring decision logs of agent reasoning and giving test changes heightened scrutiny. ([source](https://addyosmani.com/blog/agentic-code-review/))
- **The reasoning is thrown away.** Claude Code writes a full JSONL transcript per session, but nothing carries it to the PR. Worse, the transcript's `thinking` blocks are stored empty (1,256 of 1,260 on this machine), so the log has to be built from visible agent text, tool calls, user prompts and explicit elicitation, not from hidden chain-of-thought. See [docs/RESEARCH.md](docs/RESEARCH.md#transcript-jsonl-format).

## What it will do (MVP)

- Install as Claude Code hooks (`PreToolUse`, `PostToolUse`, `Stop`) with one command; zero manual settings edits.
- Record a compact, local event timeline per git branch: prompts, files edited, commands run, test runs and their pass/fail, subagent hand-offs, questions asked of the human.
- Extract **decisions** from the timeline: agent statements of rationale before edits, rejected alternatives, assumptions, plan-mode plans, `AskUserQuestion` answers, and things explicitly left undone.
- Intercept `gh pr create` and render the log into the PR body between hidden markers; re-render idempotently on later pushes (`pdl publish`) so there is one log, not five.
- Redact before anything leaves the machine: secret patterns, env dumps, raw tool output. Publish structured decisions, never the transcript.
- Emit a `decision-log.json` (versioned schema) alongside the markdown so other tools can consume it.

Stretch (Phase 2): flag tests edited after a failing test run in the same session, and assertion weakening in the PR diff (`.skip`, removed `expect`, loosened literals) next to changes in the code under test.

## Docs

| Doc | Contents |
| --- | --- |
| [docs/RESEARCH.md](docs/RESEARCH.md) | Evidence, prior art (and where they already cover this), Claude Code hook reference with JSON, transcript JSONL format, GitHub attachment options, open questions |
| [docs/DESIGN.md](docs/DESIGN.md) | Architecture, decision log schema, PR markdown template, CLI/hook interface, config, tech stack decision, non-goals, security/privacy |
| [docs/ROADMAP.md](docs/ROADMAP.md) | Phase 0 spike through Phase 3, each with a definition of done, plus portfolio deliverables |
| [docs/SOURCES.md](docs/SOURCES.md) | Every URL consulted and what it contributed |

## Why I'm building this

I use Claude Code every day, and at work I ship a cloud web app and mobile apps for workshops and logistics where every PR goes through human review. The pattern is consistent: the agent does an hour of reasoning, I open a PR, and the reviewer sees a diff and a two-line description. Everything that would have made the review fast (why this approach, what was tried, what the tests actually check) is in a JSONL file on my laptop that nobody will read. The closest existing tool ([add-reasoning-to-prs](https://github.com/backthread/add-reasoning-to-prs)) asks the agent to write a prose "why" block at `gh pr create` time and deliberately stops there; git-native session capture tools (Entire, Git AI) store everything but surface nothing to reviewers. I want the piece in between: a structured, updatable, redacted log that lives where the review happens. It is small enough to finish, I can dogfood it on every PR I open, and it shows the things I want a hiring manager to see: CLI design, GitHub API integration, careful handling of sensitive data, and honest measurement of whether it helps.
