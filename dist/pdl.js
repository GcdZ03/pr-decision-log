#!/usr/bin/env node

// src/events/store.ts
import { appendFileSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { homedir } from "node:os";
var DAY_MS = 864e5;
var EventStore = class {
  #dir;
  #root;
  constructor(root = join(homedir(), ".local", "share", "pdl")) {
    this.#root = root;
    this.#dir = join(root, "events");
  }
  /**
   * Session ids come from a hook payload, so they are untrusted input. Anything
   * that is not a plain id is hashed rather than rejected: the store must never
   * lose events, and must never write outside its own directory.
   */
  #fileFor(sessionId) {
    const safe = /^[A-Za-z0-9._-]{1,128}$/.test(sessionId) && !sessionId.startsWith(".") ? sessionId : createHash("sha256").update(sessionId).digest("hex").slice(0, 32);
    return join(this.#dir, `${safe}.jsonl`);
  }
  append(sessionId, event) {
    mkdirSync(this.#dir, { recursive: true, mode: 448 });
    appendFileSync(this.#fileFor(sessionId), `${JSON.stringify(event)}
`);
  }
  /** Each recorded session's id, last write time, and event count, for `pdl sessions`. */
  sessionsInfo() {
    const out = [];
    for (const f of this.#sessionFiles()) {
      const id = f.slice(0, -".jsonl".length);
      try {
        out.push({ id, mtimeMs: statSync(join(this.#dir, f)).mtimeMs, events: this.read(id).length });
      } catch {
      }
    }
    return out;
  }
  /** Recorded sessions. `pdl doctor` reads this to tell dormant hooks from working ones. */
  sessionCount() {
    return this.#sessionFiles().length;
  }
  /** Delete every recorded session. The store holds command output, so this has to be one command. */
  purge() {
    const files = this.#sessionFiles();
    for (const f of files) rmSync(join(this.#dir, f), { force: true });
    return files.length;
  }
  #turnsFile() {
    return join(this.#root, "turns.jsonl");
  }
  appendTurn(turn) {
    mkdirSync(this.#root, { recursive: true, mode: 448 });
    appendFileSync(this.#turnsFile(), `${JSON.stringify(turn)}
`);
  }
  turns() {
    let raw;
    try {
      raw = readFileSync(this.#turnsFile(), "utf8");
    } catch {
      return [];
    }
    const out = [];
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try {
        out.push(JSON.parse(line));
      } catch {
      }
    }
    return out;
  }
  /**
   * Delete sessions not written to for `days` days. Zero keeps everything.
   * Age is the file's last write, so a resumed session stays alive.
   */
  prune(days, now) {
    if (days <= 0) return 0;
    const cutoff = now - days * DAY_MS;
    let removed = 0;
    for (const f of this.#sessionFiles()) {
      const path = join(this.#dir, f);
      try {
        if (statSync(path).mtimeMs < cutoff) {
          rmSync(path, { force: true });
          removed++;
        }
      } catch {
      }
    }
    const kept = this.turns().filter((t) => Date.parse(t.at) >= cutoff);
    if (kept.length !== this.turns().length) {
      writeFileSync(this.#turnsFile(), kept.map((t) => `${JSON.stringify(t)}
`).join(""));
    }
    return removed;
  }
  /** `prune`, at most once a day, so the Stop hook is not scanning the store every turn. */
  pruneIfDue(days, now) {
    const marker = join(this.#root, ".last-prune");
    try {
      if (now - Number(readFileSync(marker, "utf8")) < DAY_MS) return 0;
    } catch {
    }
    const removed = this.prune(days, now);
    try {
      mkdirSync(this.#root, { recursive: true, mode: 448 });
      writeFileSync(marker, String(now));
    } catch {
    }
    return removed;
  }
  #sessionFiles() {
    try {
      return readdirSync(this.#dir).filter((f) => f.endsWith(".jsonl"));
    } catch {
      return [];
    }
  }
  read(sessionId) {
    let raw;
    try {
      raw = readFileSync(this.#fileFor(sessionId), "utf8");
    } catch {
      return [];
    }
    const events = [];
    const seen = /* @__PURE__ */ new Set();
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try {
        const event = JSON.parse(line);
        if (event.id) {
          if (seen.has(event.id)) continue;
          seen.add(event.id);
        }
        events.push(event);
      } catch {
      }
    }
    return events;
  }
};

// src/events/classify-command.ts
var NOT_INVOCATION = /^\s*(#|echo\b|printf\b)/;
var PATTERNS = [
  [
    "test",
    /\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?test\b|\b(?:npm|pnpm|yarn|bun)\s+run\s+test:[\w-]+|\bvitest\b|\bjest\b|\bpytest\b|\bgo\s+test\b|\bswift\s+test\b|\bcargo\s+test\b|\bnode\s+--test\b|\brspec\b|\bphpunit\b|\bdotnet\s+test\b|\bxcodebuild\b[^\n]*\btest\b/
  ],
  [
    "lint",
    /\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?lint\b|\beslint\b|\bprettier\b|\bruff\b|\bblack\b|\bclippy\b|\bswiftlint\b|\bgolangci-lint\b|\bflake8\b|\bmypy\b/
  ],
  [
    "build",
    /\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?build\b|\btsc\b|\bcargo\s+build\b|\bgo\s+build\b|\bswift\s+build\b|\bxcodebuild\b|\bmake\b|\bgradle\b|\bmvn\b|\bdocker\s+build\b/
  ],
  ["git", /\bgit\s+\w|\bgh\s+\w/]
];
function classifyCommand(command2) {
  const lines = command2.split("\n").map((l) => l.trim()).filter((l) => l && !NOT_INVOCATION.test(l));
  for (const [kind, re] of PATTERNS) {
    if (lines.some((l) => re.test(l))) return kind;
  }
  return "other";
}

// src/flags/assertions.ts
var ASSERT_RE = /\b(?:expect\(|assert[._(]|assert[A-Z_]\w*\(|XCTAssert\w*|require\.\w+|t\.(?:Error|Fatal)\w*|Assert\.\w+)|^[ \t]*assert\s/gm;
var STRING_RE = /(["'`])(?:\\.|(?!\1).)*\1/g;
function blankStrings(s) {
  return s.replace(STRING_RE, (m) => `${m[0]}${m[0]}`);
}
function countAssertions(s) {
  if (typeof s !== "string") return 0;
  return (blankStrings(s).match(ASSERT_RE) ?? []).length;
}

// src/events/runner-output.ts
var COUNTED = [
  /^ℹ fail (\d+)/m,
  // node:test
  /^# fail (\d+)/m,
  // TAP
  /\bTests?:?\s+(\d+) failed/,
  // jest, vitest
  /^\s*(\d+) failing\b/m,
  // mocha
  /=+ .*?\b(\d+) failed\b/,
  // pytest
  /\bwith (\d+) failures?\b/
  // XCTest
];
var MARKERS = [
  /^--- FAIL:/m,
  // go
  /^FAIL\s/m,
  // go package line, jest file line
  /test result: FAILED/,
  // cargo
  /Test Suite '.*' failed/,
  // XCTest
  /^✘ Test run with .* failed/m,
  // Swift Testing
  /\bERR_ASSERTION\b|\bAssertionError\b/,
  // node, python
  /^not ok \d+/m,
  // TAP
  /^\s*✖ /m
  // node:test failing test
];
function outputShowsFailure(output) {
  let sawSummary = false;
  for (const re of COUNTED) {
    for (const m of output.matchAll(new RegExp(re.source, `${re.flags}g`))) {
      sawSummary = true;
      if (Number(m[1]) > 0) return true;
    }
  }
  if (sawSummary) return false;
  return MARKERS.some((re) => re.test(output));
}
function exitStatusMaskable(command2) {
  return /[|;]/.test(command2);
}

// src/events/normalize.ts
var EDIT_TOOLS = /* @__PURE__ */ new Set(["Edit", "MultiEdit", "NotebookEdit"]);
var WRITE_TOOLS = /* @__PURE__ */ new Set(["Write"]);
function parseExitCode(error) {
  if (typeof error !== "string") return void 0;
  const m = /^Exit code (\d+)/m.exec(error);
  return m?.[1] !== void 0 ? Number(m[1]) : void 0;
}
var str = (v) => typeof v === "string" ? v : void 0;
var obj = (v) => typeof v === "object" && v !== null ? v : void 0;
function normalize(payload, recordedAt) {
  const event = str(payload["hook_event_name"]);
  const tool = str(payload["tool_name"]);
  const id = str(payload["tool_use_id"]) ?? "";
  const input = obj(payload["tool_input"]) ?? {};
  const durationMs = typeof payload["duration_ms"] === "number" ? payload["duration_ms"] : void 0;
  if (event !== "PostToolUse" && event !== "PostToolUseFailure") return null;
  if (tool === "Bash") {
    const command2 = str(input["command"]) ?? "";
    const classification = classifyCommand(command2);
    if (event === "PostToolUseFailure") {
      const error = str(payload["error"]) ?? "";
      return {
        kind: "command",
        id,
        at: recordedAt,
        command: command2,
        classification,
        outcome: "fail",
        output: error,
        exitCode: parseExitCode(error),
        durationMs
      };
    }
    const response = obj(payload["tool_response"]) ?? {};
    const interrupted = response["interrupted"] === true;
    const stdout = str(response["stdout"]) ?? "";
    const stderr = str(response["stderr"]) ?? "";
    const output = [stdout, stderr].filter(Boolean).join("\n");
    const masked = classification === "test" && exitStatusMaskable(command2) && outputShowsFailure(output);
    return {
      kind: "command",
      id,
      at: recordedAt,
      command: command2,
      classification,
      outcome: interrupted ? "interrupted" : masked ? "fail" : "pass",
      output,
      durationMs
    };
  }
  if (EDIT_TOOLS.has(tool ?? "") || WRITE_TOOLS.has(tool ?? "")) {
    const path = str(input["file_path"]) ?? str(input["notebook_path"]) ?? "";
    if (!path) return null;
    if (WRITE_TOOLS.has(tool ?? "")) {
      return { kind: "edit", id, at: recordedAt, path };
    }
    const before = input["old_string"];
    const after = input["new_string"];
    if (typeof before !== "string" || typeof after !== "string") {
      return { kind: "edit", id, at: recordedAt, path };
    }
    return {
      kind: "edit",
      id,
      at: recordedAt,
      path,
      assertionsBefore: countAssertions(before),
      assertionsAfter: countAssertions(after)
    };
  }
  return null;
}

// src/events/handle-hook.ts
function isDisabled(env = process.env) {
  const v = env["PDL_DISABLE"];
  if (v === void 0) return false;
  return !["", "0", "false"].includes(v.trim().toLowerCase());
}
function handleHook(store2, payload, recordedAt = (/* @__PURE__ */ new Date()).toISOString()) {
  try {
    if (isDisabled()) return null;
    const sessionId = typeof payload["session_id"] === "string" ? payload["session_id"] : "";
    if (!sessionId) return null;
    const event = normalize(payload, recordedAt);
    if (!event) return null;
    store2.append(sessionId, event);
    return event;
  } catch {
    return null;
  }
}

// src/flags/test-files.ts
var TEST_DIR = /(^|\/)(tests?|spec|__tests__)\//i;
var TEST_FILE = /\.(test|spec)\.[cm]?[tj]sx?$|_test\.(go|py|rb)$|(^|\/)test_[^/]+\.py$|Tests?\.swift$|Test\.java$/;
function isTestFile(path) {
  return TEST_DIR.test(path) || TEST_FILE.test(path);
}

// src/flags/test-edited-after-failure.ts
var RUNNER = /\b(npm|pnpm|yarn|bun)\s+(run\s+)?\S|vitest|jest|pytest|go\s+test|swift\s+test|cargo\s+test|xcodebuild|node\s+--test|rspec|phpunit|dotnet\s+test|gradle|mvn\b/;
var NOT_RUNNER = /^\s*(#|echo\b|printf\b)/;
function failureNamesFile(output, path) {
  if (!output) return false;
  if (output.includes(path)) return true;
  const base = path.split("/").pop();
  return base ? output.includes(base) : false;
}
function isPurelyAdditive(before, after) {
  if (before === void 0 || after === void 0) return false;
  return after > before;
}
function summariseCommand(command2, max = 80) {
  const lines = command2.split("\n").map((l) => l.trim()).filter(Boolean);
  const runnerLine = lines.find((l) => RUNNER.test(l) && !NOT_RUNNER.test(l));
  const chosen = runnerLine ?? lines[0] ?? "";
  const withoutCd = chosen.replace(/^cd\s+\S+\s*&&\s*/, "").trim();
  const base = withoutCd || chosen;
  if (base.length <= max) return base;
  return `${base.slice(0, max - 1)}\u2026`;
}
function detail(failure, first, last) {
  const counts = first.assertionsBefore !== void 0 && last.assertionsAfter !== void 0 && first.assertionsBefore !== last.assertionsAfter ? `; assertion count ${first.assertionsBefore} -> ${last.assertionsAfter}` : "";
  const when = first.id === last.id ? `at ${first.at}` : `${first.at}-${last.at}`;
  return `Edited ${when}, after \`${summariseCommand(failure.command)}\` failed at ${failure.at} and before it passed again${counts}.`;
}
function detectTestEditedAfterFailure(events) {
  const flags = [];
  let openFailure = null;
  let window = /* @__PURE__ */ new Map();
  const emit = (failure) => {
    for (const { first, last } of window.values()) {
      if (isPurelyAdditive(first.assertionsBefore, last.assertionsAfter)) continue;
      flags.push({
        code: "TEST_EDITED_AFTER_FAILURE",
        severity: "warn",
        file: first.path,
        detail: detail(failure, first, last),
        evidence: [failure.id, first.id]
      });
    }
    window = /* @__PURE__ */ new Map();
  };
  for (const e of events) {
    if (e.kind === "command") {
      if (e.outcome === "fail") {
        if (openFailure) emit(openFailure);
        openFailure = e;
      } else if (e.outcome === "pass" && openFailure && e.command === openFailure.command) {
        emit(openFailure);
        openFailure = null;
      }
    } else if (e.kind === "edit" && openFailure) {
      if (!isTestFile(e.path)) continue;
      if (!failureNamesFile(openFailure.output ?? "", e.path)) continue;
      const seen = window.get(e.path);
      if (seen) seen.last = e;
      else window.set(e.path, { first: e, last: e });
    }
  }
  if (openFailure) emit(openFailure);
  return flags;
}

// src/render/redact.ts
var REDACTED = (rule) => `[redacted:${rule}]`;
var RULES = [
  { name: "github_token", pattern: /\b(gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g },
  { name: "aws_access_key", pattern: /\b(A3T[A-Z0-9]|AKIA|ASIA|ABIA|ACCA)[A-Z0-9]{16}\b/g },
  { name: "slack_token", pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g },
  { name: "stripe_key", pattern: /\b(sk|rk)_(live|test)_[A-Za-z0-9]{16,}\b/g },
  { name: "google_api_key", pattern: /\bAIza[A-Za-z0-9_-]{35}\b/g },
  { name: "jwt", pattern: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g },
  {
    name: "private_key_block",
    pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g
  },
  {
    // Keep the key name: it is useful context and is not itself a secret.
    name: "secret_assignment",
    pattern: /\b([A-Z0-9_]*(?:SECRET|TOKEN|PASSWORD|PASSWD|API_KEY|PRIVATE_KEY|ACCESS_KEY)[A-Z0-9_]*)\s*[=:]\s*("[^"]+"|'[^']+'|\S+)/g,
    replace: (m) => `${m[1]}=${REDACTED("secret_assignment")}`
  },
  {
    // Strip only the credentials, leaving the host and path readable.
    name: "url_credentials",
    pattern: /\b([a-z][a-z0-9+.-]*:\/\/)([^/\s:@]+):([^/\s@]+)@/gi,
    replace: (m) => `${m[1]}${REDACTED("url_credentials")}@`
  }
];
function compileExtraPatterns(patterns) {
  const rules = [];
  patterns.forEach((p, i) => {
    try {
      rules.push({ name: `custom_${i + 1}`, pattern: new RegExp(p, "g") });
    } catch {
    }
  });
  return rules;
}
function redact(input, extra = []) {
  let text = input;
  const hits = [];
  for (const rule of [...RULES, ...extra]) {
    rule.pattern.lastIndex = 0;
    if (!rule.pattern.test(text)) continue;
    rule.pattern.lastIndex = 0;
    hits.push(rule.name);
    text = text.replace(rule.pattern, (...args) => {
      const m = args.slice(0, -2);
      return rule.replace ? rule.replace(m) : REDACTED(rule.name);
    });
  }
  return { text, hits };
}

// src/render/relativize.ts
import { basename, isAbsolute, relative, resolve } from "node:path";
function relativize(path, repoRoot2) {
  if (!path) return path;
  if (!isAbsolute(path)) return path;
  const root = resolve(repoRoot2);
  const candidates = [root, root.replace(/^\/private\//, "/"), `/private${root}`];
  for (const base of candidates) {
    const rel = relative(base, path);
    if (rel && !rel.startsWith("..") && !isAbsolute(rel)) return rel;
  }
  return basename(path);
}

// src/flags/diff-signals.ts
import { basename as basename2 } from "node:path";
function parse(diff) {
  const files = [];
  let current;
  let inHunk = false;
  for (const line of diff.split("\n")) {
    if (line.startsWith("diff --git ")) {
      current = { path: /^diff --git a\/.+? b\/(.+)$/.exec(line)?.[1] ?? "", deleted: false, added: [], removed: [] };
      files.push(current);
      inHunk = false;
      continue;
    }
    if (!current) continue;
    if (!inHunk) {
      if (line.startsWith("deleted file mode") || line === "+++ /dev/null") current.deleted = true;
      else if (line.startsWith("--- a/")) current.path = line.slice(6);
      else if (line.startsWith("+++ b/")) current.path = line.slice(6);
      else if (line.startsWith("@@")) inHunk = true;
      continue;
    }
    if (line.startsWith("@@")) continue;
    if (line.startsWith("+")) current.added.push(line.slice(1));
    else if (line.startsWith("-")) current.removed.push(line.slice(1));
  }
  return files;
}
var count = (lines, re) => lines.reduce((n, l) => n + (l.match(new RegExp(re.source, re.flags.includes("g") ? re.flags : `${re.flags}g`)) ?? []).length, 0);
function assertionsRemoved(f) {
  const removed = countAssertions(f.removed.join("\n"));
  const added = countAssertions(f.added.join("\n"));
  if (removed <= added) return null;
  return {
    code: "ASSERTIONS_REMOVED",
    severity: "info",
    file: f.path,
    detail: `Assertions in this diff: ${removed} removed, ${added} added (net ${added - removed}).`,
    evidence: []
  };
}
var SKIP_MARKERS = [
  { label: ".only(", re: /\.only\(/, note: "runs only this test and silently skips the rest of the file" },
  { label: ".skip(", re: /\.skip\(/ },
  { label: "xit( / xdescribe( / xtest(", re: /\bx(?:it|describe|test)\(/ },
  { label: "@pytest.mark.skip", re: /@pytest\.mark\.skip/ },
  { label: "@unittest.skip", re: /@unittest\.skip/ },
  { label: "t.Skip(", re: /\bt\.Skip(?:f|Now)?\(/ },
  { label: "XCTSkip", re: /\bXCTSkip/ },
  // node:test's options object. A `todo` test still runs, but its failure no
  // longer fails the run; a real agent reached for this when told to make a
  // failing test pass without touching the code.
  {
    label: "{ todo } / { skip } option",
    re: /[{,]\s*(?:todo|skip)\s*:(?!\s*false\b)/,
    note: "the test still runs but its failure no longer fails the suite"
  }
];
function testSkipped(f) {
  const added = f.added.map(blankStrings);
  const removed = f.removed.map(blankStrings);
  const introduced = SKIP_MARKERS.filter((m) => count(added, m.re) > count(removed, m.re));
  if (introduced.length === 0) return null;
  const parts = introduced.map((m) => `\`${m.label}\`${m.note ? ` (${m.note})` : ""}`);
  return {
    code: "TEST_SKIPPED",
    severity: "warn",
    file: f.path,
    detail: `Added ${parts.join(", ")}.`,
    evidence: []
  };
}
var TEST_DECL = new RegExp(
  [
    /\bx?(?:it|test)(?:\.(?:skip|only|todo))?\s*\(\s*['"`]/.source,
    /^\s*(?:async\s+)?def\s+test_\w*/.source,
    /^func\s+Test\w*\s*\(/.source,
    /\bfunc\s+test\w*\s*\(/.source,
    // Swift Testing. Its functions need no `test` prefix, so the attribute is
    // the only marker; a real Swift codebase here had 974 of these and no
    // `func test...` at all, which left the rule blind to it.
    /@Test\b/.source
  ].join("|"),
  "m"
);
function testDeleted(f) {
  const n = count(f.removed, TEST_DECL) - count(f.added, TEST_DECL);
  if (n <= 0) return null;
  return {
    code: "TEST_DELETED",
    severity: "info",
    file: f.path,
    detail: `${n} test${n === 1 ? "" : "s"} removed with no replacement.`,
    evidence: []
  };
}
var EXPECT_RE = /\b(?:toBe|toEqual|toStrictEqual|toMatchObject|assertEqual|assertEquals|XCTAssertEqual|assert\.(?:equal|strictEqual|deepEqual|deepStrictEqual))\s*\(/;
var skeleton = (line) => line.replace(/(["'`])(?:\\.|(?!\1).)*\1/g, "S").replace(/\b\d+(?:\.\d+)?\b/g, "N").trim();
function stemOf(path) {
  return basename2(path).replace(/\.(?:test|spec)\.[cm]?[tj]sx?$/, "").replace(/^test_(.+)\.py$/, "$1").replace(/_test\.(?:go|py|rb)$/, "").replace(/Tests?\.(?:swift|java)$/, "");
}
var moduleName = (path) => basename2(path).replace(/\.[^.]+$/, "");
var fragment = (line) => {
  const at = EXPECT_RE.exec(line)?.index ?? 0;
  const f = line.slice(at).trim().replace(/;$/, "");
  return f.length > 60 ? `${f.slice(0, 59)}\u2026` : f;
};
function expectationLoosened(f, changedSources) {
  const source = changedSources.get(stemOf(f.path));
  if (!source) return null;
  const pool = f.added.filter((l) => EXPECT_RE.test(l));
  const pairs = [];
  for (const r of f.removed) {
    const m = EXPECT_RE.exec(r);
    if (!m) continue;
    const prefix = r.slice(0, m.index);
    const i = pool.findIndex((a) => a !== r && a.startsWith(prefix) && skeleton(a) === skeleton(r));
    if (i === -1) continue;
    pairs.push([r, pool[i]]);
    pool.splice(i, 1);
  }
  const first = pairs[0];
  if (!first) return null;
  const more = pairs.length > 1 ? ` (${pairs.length} expectations changed)` : "";
  return {
    code: "EXPECTATION_LOOSENED",
    severity: "info",
    file: f.path,
    detail: `\`${fragment(first[0])}\` -> \`${fragment(first[1])}\` while \`${source}\` also changed${more}; worth confirming the new value is intended.`,
    evidence: []
  };
}
var REMOVALS = /* @__PURE__ */ new Set(["ASSERTIONS_REMOVED", "TEST_DELETED"]);
function corroborate(flag, corroborated) {
  if (!REMOVALS.has(flag.code) || !corroborated.has(flag.file)) return flag;
  return {
    ...flag,
    severity: "warn",
    detail: `${flag.detail} This file was also edited after its test failed in this session.`
  };
}
function followsRemoval(flag, deletedSource) {
  if (!deletedSource || !REMOVALS.has(flag.code)) return flag;
  return {
    ...flag,
    severity: "info",
    detail: `${flag.detail} Follows the removal of \`${deletedSource}\`.`
  };
}
function analyzeDiff(diff, options = {}) {
  const corroborated = options.corroborated ?? /* @__PURE__ */ new Set();
  const files = parse(diff);
  const changedSources = /* @__PURE__ */ new Map();
  const deletedSources = /* @__PURE__ */ new Map();
  for (const f of files) {
    if (isTestFile(f.path)) continue;
    if (f.added.length > 0 || f.removed.length > 0) changedSources.set(moduleName(f.path), f.path);
    if (f.deleted) deletedSources.set(moduleName(f.path), f.path);
  }
  const flags = [];
  for (const f of files.filter((x) => isTestFile(x.path))) {
    for (const rule of [assertionsRemoved, testSkipped, testDeleted]) {
      const flag = rule(f);
      if (flag) flags.push(followsRemoval(corroborate(flag, corroborated), deletedSources.get(stemOf(f.path))));
    }
    const loosened = expectationLoosened(f, changedSources);
    if (loosened) flags.push(loosened);
  }
  return flags;
}

// src/render/build-log.ts
function buildLog(events, meta, decisions = []) {
  const rules = /* @__PURE__ */ new Set();
  const clean = (s) => {
    const { text, hits } = redact(s, meta.extraRedactions);
    for (const h of hits) rules.add(h);
    return text;
  };
  const rel = (p) => meta.repoRoot ? relativize(p, meta.repoRoot) : p;
  const verification = [];
  const changeMap = /* @__PURE__ */ new Map();
  for (const e of events) {
    if (e.kind === "command") {
      verification.push({
        at: e.at,
        kind: e.classification,
        command: clean(summariseCommand(e.command)),
        outcome: e.outcome,
        ...e.exitCode !== void 0 ? { exitCode: e.exitCode } : {},
        ...e.durationMs !== void 0 ? { durationMs: e.durationMs } : {}
      });
    } else {
      const file = rel(e.path);
      const existing = changeMap.get(file);
      if (existing) existing.edits += 1;
      else changeMap.set(file, { file, edits: 1, role: isTestFile(file) ? "test" : "source" });
    }
  }
  const timeline = meta.flagEditAfterFailure === false ? [] : detectTestEditedAfterFailure(events);
  const flags = timeline.map((f) => ({
    ...f,
    file: rel(f.file),
    detail: clean(meta.repoRoot ? f.detail.replaceAll(f.file, rel(f.file)) : f.detail)
  }));
  const ranATest = events.some((e) => e.kind === "command" && e.classification === "test");
  if (changeMap.size > 0 && !ranATest) {
    flags.push({
      code: "NO_TEST_RUN",
      severity: "warn",
      file: "",
      detail: `${changeMap.size} file(s) changed and no test command was recorded in this session.`,
      evidence: []
    });
  }
  if (meta.diff) {
    const corroborated = new Set(flags.filter((f) => f.code === "TEST_EDITED_AFTER_FAILURE").map((f) => f.file));
    for (const f of analyzeDiff(meta.diff, { corroborated })) flags.push({ ...f, detail: clean(f.detail) });
  }
  const intent = meta.intent === void 0 ? void 0 : clean(meta.intent);
  return {
    schema: "pdl/1",
    generatedAt: meta.generatedAt ?? (/* @__PURE__ */ new Date()).toISOString(),
    repo: { remote: meta.repo, ...meta.headSha ? { headSha: meta.headSha } : {} },
    branch: meta.branch,
    sessions: meta.sessions ?? [],
    ...intent !== void 0 ? { intent } : {},
    verification,
    changes: [...changeMap.values()],
    flags,
    // Model text, so it passes through the same redactor as everything else.
    decisions: decisions.map((d) => ({ ...d, text: clean(d.text) })),
    redaction: { hits: rules.size, rules: [...rules] }
  };
}

// src/render/render.ts
var MARKER_START = "<!-- pdl:start";
var MARKER_END = "<!-- pdl:end -->";
var OUTCOME_LABEL = {
  pass: "pass",
  fail: "fail",
  interrupted: "interrupted (cancelled)",
  unknown: "unknown"
};
function cell(value) {
  return value.replace(/\|/g, "\\|");
}
function timeOnly(iso) {
  const m = /T(\d{2}:\d{2})/.exec(iso);
  return m?.[1] ?? iso;
}
function render(log, options = {}) {
  const max = options.maxChars ?? 12e3;
  const tool = options.toolUrl ?? "https://github.com/GcdZ03/pr-decision-log";
  const header = `${MARKER_START} v=1 sha=${log.repo.headSha ?? "unknown"} -->
## Decision log
`;
  const from = log.sessions.length > 1 ? `${log.sessions.length} agent sessions` : "the agent session";
  const blurb = `
*Recorded automatically from ${from} on \`${log.branch}\`. Everything below is observed from tool events, not the model's self-report. [What this is](${tool}).*
`;
  const sections = [];
  if (log.intent) sections.push(`
**Intent**: ${log.intent}
`);
  if (log.flags.length > 0) {
    const lines = log.flags.map((f) => {
      const where = f.file ? ` \`${f.file}\`` : "";
      const note2 = f.severity === "info" ? " *(note)*" : "";
      return `- **${f.code}**${note2}${where} ${f.detail}`;
    });
    sections.push(`
### Flags
${lines.join("\n")}
`);
  }
  if (log.verification.length > 0) {
    const rows = log.verification.map(
      (v) => `| ${timeOnly(v.at)} | \`${cell(v.command)}\` | ${OUTCOME_LABEL[v.outcome] ?? v.outcome} |`
    );
    sections.push(`
### Verification (recorded)

| When | Command | Result |
| --- | --- | --- |
${rows.join("\n")}
`);
  }
  if (log.changes.length > 0) {
    const rows = log.changes.map(
      (c) => `- \`${c.file}\` - ${c.edits} edit${c.edits === 1 ? "" : "s"}${c.role === "test" ? " (test)" : ""}`
    );
    sections.push(`
### Changes
${rows.join("\n")}
`);
  }
  const CLAIM_SECTIONS = [
    { kind: "decision", heading: "Decisions" },
    { kind: "assumption", heading: "Assumptions" },
    { kind: "open_item", heading: "Open items" }
  ];
  for (const { kind, heading } of CLAIM_SECTIONS) {
    const items = log.decisions.filter((d) => d.kind === kind);
    if (items.length === 0) continue;
    const lines = items.map((d) => {
      const label = d.confidence === "confirmed_by_human" ? " *(confirmed by a human)*" : " *(stated)*";
      return `- ${d.text}${label}`;
    });
    sections.push(`
### ${heading}
${lines.join("\n")}
`);
  }
  const footer = `
<sub>Redaction: ${log.redaction.hits} rule(s) applied.</sub>
${MARKER_END}
`;
  let body = header + blurb + sections.join("") + footer;
  if (body.length <= max) return body;
  const note = `
*Log truncated to fit the PR body budget.*
`;
  const kept = [];
  for (const s of sections) {
    const candidate = header + blurb + [...kept, s].join("") + note + footer;
    if (candidate.length > max) break;
    kept.push(s);
  }
  body = header + blurb + kept.join("") + note + footer;
  if (body.length <= max) return body;
  const minimal = header + note + footer;
  if (minimal.length <= max) return minimal;
  return `${header.slice(0, Math.max(0, max - MARKER_END.length - 1))}
${MARKER_END}
`;
}

// src/publish/publish.ts
import { spawnSync } from "node:child_process";

// src/publish/splice.ts
import { createHash as createHash2 } from "node:crypto";
var BLOCK = /<!-- pdl:start[\s\S]*?<!-- pdl:end -->/;
function sectionHash(section) {
  return createHash2("sha256").update(section).digest("hex").slice(0, 12);
}
function splice(body, section) {
  const existing = body ?? "";
  const hash = sectionHash(section);
  const stamped = section.replace(MARKER_END, `<!-- pdl:hash=${hash} -->
${MARKER_END}`);
  const current = BLOCK.exec(existing);
  if (current) {
    if (current[0].includes(`pdl:hash=${hash}`)) return { body: existing, changed: false };
    return { body: existing.replace(BLOCK, stamped), changed: true };
  }
  const prefix = existing.trim() ? `${existing.trimEnd()}

` : "";
  return { body: prefix + stamped, changed: true };
}

// src/publish/publish.ts
var realGh = (args, stdin) => {
  const proc = spawnSync("gh", args, { input: stdin, encoding: "utf8" });
  return {
    ok: proc.status === 0,
    stdout: proc.stdout ?? "",
    stderr: proc.stderr ?? (proc.error ? String(proc.error.message) : "")
  };
};
async function publish(options) {
  const gh = options.gh ?? realGh;
  const repoArgs = options.repo ? ["--repo", options.repo] : [];
  const pr = String(options.prNumber);
  const view = await gh(["pr", "view", pr, ...repoArgs, "--json", "body"]);
  if (!view.ok) {
    return { status: "failed", body: "", error: view.stderr || "gh pr view failed" };
  }
  let current = "";
  try {
    current = JSON.parse(view.stdout || "{}").body ?? "";
  } catch {
    return { status: "failed", body: "", error: "could not parse gh pr view output" };
  }
  const { body, changed } = splice(current, options.section);
  if (!changed) return { status: "unchanged", body };
  if (options.dryRun) return { status: "dry-run", body };
  const edit = await gh(["pr", "edit", pr, ...repoArgs, "--body-file", "-"], body);
  if (!edit.ok) {
    return { status: "failed", body, error: edit.stderr || "gh pr edit failed" };
  }
  return { status: "updated", body };
}

// src/publish/auto-publish.ts
import { mkdirSync as mkdirSync2, readFileSync as readFileSync2, writeFileSync as writeFileSync2 } from "node:fs";
import { dirname } from "node:path";

// src/publish/publish-comment.ts
var MARKER_START2 = "<!-- pdl:start";
function parseComments(stdout) {
  try {
    const parsed = JSON.parse(stdout || "[]");
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((c) => typeof c === "object" && c !== null).filter((c) => typeof c["id"] === "number" && typeof c["body"] === "string").map((c) => ({ id: c["id"], body: c["body"] }));
  } catch {
    return [];
  }
}
async function publishComment(options) {
  const gh = options.gh ?? realGh;
  const base = `repos/${options.repo}/issues`;
  const list = await gh(["api", `${base}/${options.prNumber}/comments`, "--paginate"]);
  if (!list.ok) {
    return { status: "failed", body: "", error: list.stderr || "could not list comments" };
  }
  const existing = parseComments(list.stdout).find((c) => c.body.includes(MARKER_START2));
  const { body, changed } = splice(existing?.body ?? "", options.section);
  if (existing && !changed) return { status: "unchanged", body };
  if (options.dryRun) return { status: "dry-run", body };
  const payload = JSON.stringify({ body });
  const write = existing ? await gh(["api", "-X", "PATCH", `repos/${options.repo}/issues/comments/${existing.id}`, "--input", "-"], payload) : await gh(["api", "-X", "POST", `${base}/${options.prNumber}/comments`, "--input", "-"], payload);
  if (!write.ok) {
    return { status: "failed", body, error: write.stderr || "could not write the comment" };
  }
  return { status: "updated", body };
}

// src/publish/auto-publish.ts
var FilePublishState = class {
  path;
  constructor(path) {
    this.path = path;
  }
  #all() {
    try {
      const v = JSON.parse(readFileSync2(this.path, "utf8"));
      return typeof v === "object" && v !== null && !Array.isArray(v) ? v : {};
    } catch {
      return {};
    }
  }
  get(key) {
    return this.#all()[key] ?? {};
  }
  set(key, value) {
    const all = this.#all();
    all[key] = value;
    try {
      mkdirSync2(dirname(this.path), { recursive: true, mode: 448 });
      writeFileSync2(this.path, JSON.stringify(all));
    } catch {
    }
  }
};
var NO_PR_TTL_MS = 5 * 6e4;
function parseView(stdout) {
  try {
    const v = JSON.parse(stdout || "{}");
    if (typeof v["number"] !== "number") return null;
    const url = typeof v["url"] === "string" ? v["url"] : "";
    return {
      number: v["number"],
      body: typeof v["body"] === "string" ? v["body"] : "",
      baseRefName: typeof v["baseRefName"] === "string" && v["baseRefName"] !== "" ? v["baseRefName"] : void 0,
      repo: /github\.com\/([^/\s]+\/[^/\s]+)\/pull\//.exec(url)?.[1]
    };
  } catch {
    return null;
  }
}
var skipped = (error) => ({ status: "skipped", body: "", error });
async function autoPublish(o) {
  if (isDisabled(o.env ?? process.env)) return skipped("PDL_DISABLE is set");
  const gh = o.gh ?? realGh;
  const now = o.now ?? Date.now();
  const mode = o.mode ?? "body";
  try {
    const st = o.state.get(o.key);
    if (!o.created && st.noPrUntil !== void 0 && now < st.noPrUntil) {
      return skipped("no pull request for this branch (checked recently)");
    }
    let built;
    const sectionFor = (base2) => {
      if (built?.base !== base2) built = { base: base2, section: o.build(base2) };
      return built.section;
    };
    if (!o.created && st.pr !== void 0 && st.lastHash !== void 0 && st.mode === mode) {
      if (sectionHash(sectionFor(st.base ?? o.defaultBase)) === st.lastHash) return { status: "unchanged", body: "" };
    }
    const view = await gh(["pr", "view", "--json", "number,body,baseRefName,url"]);
    const pr = view.ok ? parseView(view.stdout) : null;
    if (!pr) {
      o.state.set(o.key, { noPrUntil: now + NO_PR_TTL_MS });
      return skipped(view.ok ? "could not parse gh pr view output" : view.stderr || "no pull request for the current branch");
    }
    const base = pr.baseRefName ?? st.base ?? o.defaultBase;
    const section = sectionFor(base);
    const dryRun = o.dryRun ?? false;
    let result;
    if (mode === "comment") {
      if (!pr.repo) return skipped("could not read the repository from the PR url");
      result = await publishComment({ prNumber: pr.number, section, repo: pr.repo, gh, dryRun });
    } else {
      const { body, changed } = splice(pr.body, section);
      if (!changed) result = { status: "unchanged", body };
      else if (dryRun) result = { status: "dry-run", body };
      else {
        const edit = await gh(["pr", "edit", String(pr.number), "--body-file", "-"], body);
        result = edit.ok ? { status: "updated", body } : { status: "failed", body, error: edit.stderr || "gh pr edit failed" };
      }
    }
    const published = result.status === "updated" || result.status === "unchanged";
    o.state.set(o.key, { pr: pr.number, base, mode, ...published ? { lastHash: sectionHash(section) } : {} });
    return result;
  } catch (e) {
    return skipped(e instanceof Error ? e.message : String(e));
  }
}

// src/publish/pr-diff.ts
import { spawnSync as spawnSync2 } from "node:child_process";
function git(args, cwd) {
  const p = spawnSync2("git", args, { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return { ok: p.status === 0, out: p.stdout ?? "" };
}
function diffAgainst(base, cwd = process.cwd()) {
  for (const ref of [`origin/${base}`, base]) {
    const d = git(["diff", "--no-color", `${ref}...HEAD`], cwd);
    if (d.ok) return d.out;
  }
  return "";
}
function defaultBase(cwd = process.cwd()) {
  const r = git(["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], cwd);
  return r.ok ? r.out.trim().replace(/^origin\//, "") || "main" : "main";
}

// src/events/branch.ts
function selectForBranch(items, turns, branch) {
  const last = turns[turns.length - 1];
  if (!last) return [];
  return items.filter((item) => {
    const owner = item.at === void 0 ? last : turns.find((t) => t.at >= item.at) ?? last;
    return owner.branch === branch;
  });
}
function sessionsForBranch(turns, repo, branch) {
  const out = [];
  for (const t of turns) {
    if (t.repo === repo && t.branch === branch && !out.includes(t.session)) out.push(t.session);
  }
  return out;
}
function eventsForBranch(store2, repo, branch) {
  const all = store2.turns().filter((t) => t.repo === repo);
  const sessions2 = sessionsForBranch(all, repo, branch);
  const events = [];
  const transcripts = /* @__PURE__ */ new Map();
  const turnsBySession = /* @__PURE__ */ new Map();
  for (const session of sessions2) {
    const turns = all.filter((t) => t.session === session).sort((a, b) => a.at.localeCompare(b.at));
    turnsBySession.set(session, turns);
    const transcript = [...turns].reverse().find((t) => t.transcript)?.transcript;
    if (transcript) transcripts.set(session, transcript);
    events.push(...selectForBranch(store2.read(session), turns, branch));
  }
  events.sort((a, b) => a.at.localeCompare(b.at));
  return { events, sessions: sessions2, transcripts, turnsBySession };
}
function summariseSessions(infos, turns, repo) {
  return infos.map((i) => {
    const own = turns.filter((t) => t.session === i.id);
    const branches = [];
    for (const t of own) if (!branches.includes(t.branch)) branches.push(t.branch);
    return { id: i.id, repo: own[own.length - 1]?.repo, branches, lastActivityMs: i.mtimeMs, events: i.events };
  }).filter((s) => repo === void 0 || s.repo === repo).sort((a, b) => b.lastActivityMs - a.lastActivityMs);
}

// src/publish/detect-pr.ts
var CREATE_RE = /(?:^|[\n;&|]\s*)\s*gh\s+pr\s+create\b/;
var PR_URL_RE = /https:\/\/github\.com\/[^\s/]+\/[^\s/]+\/pull\/(\d+)/;
function detectPrCreation(event) {
  if (event.kind !== "command") return null;
  if (event.outcome !== "pass") return null;
  if (!CREATE_RE.test(event.command)) return null;
  const match = PR_URL_RE.exec(event.output ?? "");
  if (!match?.[1]) return null;
  return { prNumber: Number(match[1]) };
}

// src/doctor/diagnose.ts
var SCOPE_NAME = {
  project: "this repo's .claude/settings.json",
  user: "~/.claude/settings.json",
  plugin: "the pr-decision-log plugin"
};
var MIN_NODE_MAJOR = 22;
var REQUIRED_HOOK_EVENTS = [
  "PreToolUse",
  "PostToolUse",
  "PostToolUseFailure",
  "UserPromptSubmit",
  "Stop",
  "SubagentStop"
];
var SEVERITY = { skip: 0, ok: 1, warn: 2, fail: 3 };
function worstStatus(checks) {
  let worst = "ok";
  for (const c of checks) {
    if (SEVERITY[c.status] > SEVERITY[worst]) worst = c.status;
  }
  return worst === "skip" ? "ok" : worst;
}
function nodeCheck(facts) {
  const major = Number(/^v?(\d+)/.exec(facts.nodeVersion)?.[1] ?? 0);
  return major >= MIN_NODE_MAJOR ? { name: "node", status: "ok", detail: facts.nodeVersion } : {
    name: "node",
    status: "fail",
    detail: `${facts.nodeVersion}, below the required v${MIN_NODE_MAJOR}`,
    remedy: `Install Node ${MIN_NODE_MAJOR} or newer.`
  };
}
function registeredCheck(facts) {
  const missing = REQUIRED_HOOK_EVENTS.filter((e) => !facts.hookEvents.includes(e));
  if (facts.hookEvents.length === 0) {
    return {
      name: "hooks registered",
      status: "fail",
      detail: "no pdl hooks found in any settings file or installed plugin",
      remedy: "Install the plugin, or run `pdl init` in this repository."
    };
  }
  if (facts.hookScopes.length > 1) {
    const names = facts.hookScopes.map((s) => SCOPE_NAME[s]);
    const where2 = names.length === 2 ? `both ${names[0]} and ${names[1]}` : names.join(", ");
    return {
      name: "hooks registered",
      status: "warn",
      detail: `registered in ${where2}, so every hook fires ${facts.hookScopes.length} times`,
      remedy: "Events are de-duplicated when read, but each turn still runs extra publishes. Remove all but one: uninstall the plugin, or run `pdl remove` (add `--user` for ~/.claude/settings.json)."
    };
  }
  if (missing.length > 0) {
    return {
      name: "hooks registered",
      status: "warn",
      detail: `${facts.hookEvents.length} registered, missing ${missing.join(", ")}`,
      remedy: "Run `pdl init` to add the missing events."
    };
  }
  const where = facts.hookScopes[0] === "plugin" ? SCOPE_NAME.plugin : facts.settingsPath ?? "settings";
  return {
    name: "hooks registered",
    status: "ok",
    detail: `${facts.hookEvents.length} events via ${where}`
  };
}
function firingCheck(facts) {
  if (facts.hookEvents.length === 0) {
    return { name: "hooks firing", status: "skip", detail: "nothing registered to fire" };
  }
  if (facts.recordedSessions === 0) {
    return {
      name: "hooks firing",
      status: "warn",
      detail: "hooks are registered but no session has ever been recorded",
      remedy: "Claude Code keeps hooks dormant until the folder is trusted. Open this repo interactively, accept the trust dialog, then run `/hooks` and confirm the events show a count."
    };
  }
  return { name: "hooks firing", status: "ok", detail: `${facts.recordedSessions} session(s) recorded` };
}
function killSwitchCheck(facts) {
  return isDisabled(facts.env) ? {
    name: "kill switch",
    status: "warn",
    detail: `PDL_DISABLE=${facts.env["PDL_DISABLE"]}, recording is off`,
    remedy: "Unset PDL_DISABLE to resume recording."
  } : { name: "kill switch", status: "ok", detail: "PDL_DISABLE not in effect" };
}
function ghCheck(facts) {
  switch (facts.gh) {
    case "ok":
      return { name: "gh", status: "ok", detail: "installed and authenticated" };
    case "missing":
      return {
        name: "gh",
        status: "warn",
        detail: "gh not found, publishing will be skipped",
        remedy: "Install the GitHub CLI: https://cli.github.com"
      };
    case "unauthenticated":
      return {
        name: "gh",
        status: "warn",
        detail: "gh is installed but not authenticated",
        remedy: "Run `gh auth login`."
      };
  }
}
function configCheck(facts) {
  return facts.configProblems.length === 0 ? { name: "config", status: "ok", detail: "no problems" } : {
    name: "config",
    status: "warn",
    detail: facts.configProblems.join("; "),
    remedy: "Fix or remove these settings; defaults are in use for them."
  };
}
var TRUST_REMEDY = "Run `claude` in this folder, accept the trust dialog, then `/hooks` to confirm the events show a count.";
function trustCheck(facts) {
  switch (facts.trust) {
    case "accepted":
      return { name: "folder trust", status: "ok", detail: "trust dialog accepted" };
    case "not-accepted":
      return {
        name: "folder trust",
        status: "warn",
        detail: "trust dialog not accepted; hooks fire only in headless `claude -p` runs",
        remedy: TRUST_REMEDY
      };
    case "unknown-folder":
      return {
        name: "folder trust",
        status: "warn",
        detail: "folder never opened interactively; hooks fire only in headless `claude -p` runs",
        remedy: TRUST_REMEDY
      };
    case "unreadable":
      return { name: "folder trust", status: "skip", detail: "could not read ~/.claude.json" };
  }
}
function diagnose(facts) {
  return [
    nodeCheck(facts),
    registeredCheck(facts),
    trustCheck(facts),
    firingCheck(facts),
    configCheck(facts),
    killSwitchCheck(facts),
    ghCheck(facts)
  ];
}

// src/extract/transcript.ts
import { readFileSync as readFileSync3 } from "node:fs";
var blocks = (entry) => {
  const c = entry.message?.content;
  return Array.isArray(c) ? c.filter((b) => typeof b === "object" && b !== null) : [];
};
function readTranscript(path) {
  let raw;
  try {
    raw = readFileSync3(path, "utf8");
  } catch {
    return [];
  }
  const entries = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      if (entry.isSidechain === true) continue;
      entries.push(entry);
    } catch {
    }
  }
  return entries;
}
function toolUses(entry) {
  return blocks(entry).filter((b) => b.type === "tool_use" && typeof b.name === "string").map((b) => ({ id: b.id ?? "", name: b.name, input: b.input ?? {} }));
}
function assistantText(entry) {
  return blocks(entry).filter((b) => b.type === "text" && typeof b.text === "string" && b.text.trim() !== "").map((b) => b.text.trim()).join("\n");
}
function toolResults(entry) {
  return blocks(entry).filter((b) => b.type === "tool_result" && typeof b.tool_use_id === "string").map((b) => ({
    id: b.tool_use_id,
    text: typeof b.content === "string" ? b.content : Array.isArray(b.content) ? b.content.map((c) => c.text ?? "").join("\n") : ""
  }));
}

// src/extract/decisions.ts
var MARKERS2 = [
  // First person only. "the spike assumed X" reports what someone else did
  // and is an ordinary statement, not an assumption this session is making.
  { kind: "assumption", re: /(?:^|\W)(?:assuming\b|(?:I|we)\s+(?:am\s+|are\s+)?assum\w*|(?:my|our|the)\s+assumption\b)/i },
  { kind: "open_item", re: /\b(?:TODO|left (?:out|unfinished)|not addressed)\b/i },
  { kind: "decision", re: /\b(?:because|instead of|rather than|chose|decided|trade-?off)\b/i }
];
var NARRATION = [
  /\blet(?:'s|\s+me|\s+us)\b/i,
  /\bI(?:'ve|\s+have)?\s+just\s+(?:verified|checked|confirmed|tested)\b/i,
  /^(?:first|now|next|then)\b[^.]{0,40}\b(?:verif|check|confirm)/i,
  /^verifying\b/i,
  /^(?:red|green)\b[^.]{0,30}[\u2014-]/i,
  /\b(?:rather than|instead of)\s+(?:my own\s+)?(?:guess|assert|assum|trust|claim|check|verif|memor)/i
];
var isNarration = (s) => NARRATION.some((re) => re.test(s));
var CHANGING_TOOLS = /* @__PURE__ */ new Set(["Edit", "MultiEdit", "Write", "NotebookEdit", "Bash"]);
var MAX_SENTENCE = 320;
var MAX_STATED = 5;
function sentences(text) {
  return text.split("\n").flatMap((line) => line.split(/(?<=[.!?])\s+/)).map((s) => s.trim()).filter((s) => s !== "");
}
function stripEmphasis(s) {
  return s.replace(/\*\*(.+?)\*\*/g, "$1").replace(/(^|\s)\*(\S(?:.*?\S)?)\*(?=\s|$)/g, "$1$2");
}
function truncate(s) {
  return s.length <= MAX_SENTENCE ? s : `${s.slice(0, MAX_SENTENCE - 1).trimEnd()}\u2026`;
}
function markerRe(marker) {
  const esc = marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const lead = /^\w/.test(marker) ? "(?<!\\w)" : "";
  const trail = /\w$/.test(marker) ? "(?!\\w)" : "";
  return new RegExp(`${lead}${esc}${trail}`, "i");
}
function fromStatedRationale(entries, markers) {
  const out = [];
  const seen = /* @__PURE__ */ new Set();
  for (const [i, entry] of entries.entries()) {
    if (!toolUses(entry).some((u) => CHANGING_TOOLS.has(u.name))) continue;
    let text = assistantText(entry);
    for (let j = i - 1; j >= 0 && !text; j--) {
      const prev = entries[j];
      if (!prev || prev.type !== "assistant" || prev.requestId !== entry.requestId) break;
      text = assistantText(prev);
    }
    if (!text) continue;
    for (const sentence of sentences(text)) {
      const hit = markers.find((m) => m.re.test(sentence));
      if (!hit) continue;
      if (isNarration(sentence)) continue;
      const clipped = truncate(stripEmphasis(sentence));
      const key = clipped.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ text: clipped, kind: hit.kind, source: "stated", confidence: "stated", at: entry.timestamp });
      if (out.length >= MAX_STATED) return out;
    }
  }
  return out;
}
function questionsOf(input) {
  const qs = input["questions"];
  if (!Array.isArray(qs)) return [];
  return qs.filter((q) => typeof q === "object" && q !== null).map((q) => ({
    question: typeof q["question"] === "string" ? q["question"] : "",
    header: typeof q["header"] === "string" ? q["header"] : void 0
  })).filter((q) => q.question !== "");
}
function answerFor(result, question) {
  const needle = `"${question}"="`;
  const start = result.indexOf(needle);
  if (start === -1) return void 0;
  const from = start + needle.length;
  const end = result.indexOf('"', from);
  if (end === -1) return void 0;
  const answer = result.slice(from, end).replace(/\s*\(Recommended\)\s*$/i, "").trim();
  return answer === "" ? void 0 : answer;
}
function fromQuestions(entries) {
  const asked = /* @__PURE__ */ new Map();
  const decisions = [];
  for (const entry of entries) {
    for (const use of toolUses(entry)) {
      if (use.name !== "AskUserQuestion") continue;
      asked.set(use.id, { questions: questionsOf(use.input), at: entry.timestamp });
    }
    for (const result of toolResults(entry)) {
      const pending = asked.get(result.id);
      if (!pending) continue;
      asked.delete(result.id);
      for (const q of pending.questions) {
        const answer = answerFor(result.text, q.question);
        if (answer === void 0) continue;
        decisions.push({
          text: `${q.header ?? q.question}: ${answer}`,
          kind: "decision",
          source: "human-answer",
          confidence: "confirmed_by_human",
          at: entry.timestamp ?? pending.at
        });
      }
    }
  }
  return decisions;
}
function extractDecisions(entries, options = {}) {
  const extra = (options.extraMarkers ?? []).filter((m) => m.trim() !== "").map((m) => ({ kind: "decision", re: markerRe(m) }));
  return [...fromQuestions(entries), ...fromStatedRationale(entries, [...MARKERS2, ...extra])];
}

// src/extract/find-transcript.ts
import { readdirSync as readdirSync2, existsSync } from "node:fs";
import { join as join2 } from "node:path";
import { homedir as homedir2 } from "node:os";
var DEFAULT_ROOT = join2(homedir2(), ".claude", "projects");
function findTranscript(sessionId, root = DEFAULT_ROOT) {
  if (!/^[A-Za-z0-9._-]{1,128}$/.test(sessionId) || sessionId.startsWith(".")) return void 0;
  let dirs;
  try {
    dirs = readdirSync2(root);
  } catch {
    return void 0;
  }
  for (const dir of dirs) {
    const candidate = join2(root, dir, `${sessionId}.jsonl`);
    if (existsSync(candidate)) return candidate;
  }
  return void 0;
}

// src/doctor/init.ts
var PDL_MARKER = "pdlManaged";
var LEGACY_PDL_RE = /(?:^|[\s"'/])pdl(?:\.[jt]s)?["']?\s+hook\s*$/;
var isPdlEntry = (h) => h[PDL_MARKER] === true || LEGACY_PDL_RE.test(h.command ?? "");
var TOOL_EVENTS = /* @__PURE__ */ new Set(["PreToolUse", "PostToolUse", "PostToolUseFailure"]);
var isAsync = (event) => event !== "Stop";
function entryFor(event, command2) {
  const entry = { type: "command", command: command2, [PDL_MARKER]: true };
  if (isAsync(event)) entry.async = true;
  return entry;
}
function pdlHookEvents(settings) {
  return Object.entries(settings.hooks ?? {}).filter(([, groups]) => groups.some((g) => (g.hooks ?? []).some((h) => h[PDL_MARKER] === true))).map(([event]) => event);
}
function mergeHooks(settings, command2) {
  const hooks = { ...settings.hooks ?? {} };
  for (const event of REQUIRED_HOOK_EVENTS) {
    const groups = (hooks[event] ?? []).map((g) => ({ ...g, hooks: [...g.hooks ?? []] }));
    for (const group of groups) {
      group.hooks = (group.hooks ?? []).filter((h) => !isPdlEntry(h));
    }
    const target = groups.find((g) => TOOL_EVENTS.has(event) ? g.matcher === "*" : g.matcher === void 0);
    const entry = entryFor(event, command2);
    if (target) {
      target.hooks = [...target.hooks ?? [], entry];
    } else {
      groups.push(TOOL_EVENTS.has(event) ? { matcher: "*", hooks: [entry] } : { hooks: [entry] });
    }
    hooks[event] = groups.filter((g) => (g.hooks ?? []).length > 0);
  }
  return { ...settings, hooks };
}
function removeHooks(settings) {
  if (!settings.hooks) return { settings, removed: 0 };
  let removed = 0;
  const hooks = {};
  for (const [event, groups] of Object.entries(settings.hooks)) {
    const kept = groups.map((g) => {
      const entries = g.hooks ?? [];
      const others = entries.filter((h) => !isPdlEntry(h));
      removed += entries.length - others.length;
      return { ...g, hooks: others };
    }).filter((g) => g.hooks.length > 0);
    if (kept.length > 0) hooks[event] = kept;
  }
  if (removed === 0) return { settings, removed: 0 };
  const { hooks: _dropped, ...rest } = settings;
  return { settings: Object.keys(hooks).length > 0 ? { ...rest, hooks } : rest, removed };
}

// src/doctor/settings.ts
import { mkdirSync as mkdirSync3, readFileSync as readFileSync4, realpathSync, writeFileSync as writeFileSync3 } from "node:fs";
import { dirname as dirname2, join as join3, resolve as resolve2 } from "node:path";
import { homedir as homedir3 } from "node:os";
import { spawnSync as spawnSync3 } from "node:child_process";
function settingsPathFor(scope, repoRoot2) {
  return scope === "user" ? join3(homedir3(), ".claude", "settings.json") : join3(repoRoot2, ".claude", "settings.json");
}
function readSettings(path) {
  try {
    return JSON.parse(readFileSync4(path, "utf8"));
  } catch {
    return {};
  }
}
function settingsExist(path) {
  try {
    readFileSync4(path, "utf8");
    return true;
  } catch {
    return false;
  }
}
function writeSettings(path, settings) {
  mkdirSync3(dirname2(path), { recursive: true });
  writeFileSync3(path, `${JSON.stringify(settings, null, 2)}
`);
}
function hookCommand(entry = process.argv[1] ?? "pdl", scope = "project", root = repoRoot()) {
  const abs = resolve2(entry);
  const prefix = `${resolve2(root)}/`;
  const path = scope === "project" && abs.startsWith(prefix) ? `$CLAUDE_PROJECT_DIR/${abs.slice(prefix.length)}` : abs;
  return `node "${path}" hook`;
}
function ghStatus() {
  const p = spawnSync3("gh", ["auth", "status"], { encoding: "utf8" });
  if (p.error) return "missing";
  return p.status === 0 ? "ok" : "unauthenticated";
}
function repoRoot() {
  const p = spawnSync3("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" });
  return p.status === 0 ? (p.stdout ?? "").trim() : process.cwd();
}
function trustState(root, statePath = join3(homedir3(), ".claude.json")) {
  let projects;
  try {
    projects = JSON.parse(readFileSync4(statePath, "utf8")).projects;
  } catch {
    return "unreadable";
  }
  if (typeof projects !== "object" || projects === null) return "unknown-folder";
  const entry = projects[resolve2(root)];
  if (!entry) return "unknown-folder";
  return entry.hasTrustDialogAccepted === true ? "accepted" : "not-accepted";
}
var PLUGIN_ID_PREFIX = "pr-decision-log@";
var readJson = (path) => {
  try {
    const v = JSON.parse(readFileSync4(path, "utf8"));
    return typeof v === "object" && v !== null ? v : {};
  } catch {
    return {};
  }
};
var real = (p) => {
  try {
    return realpathSync(p);
  } catch {
    return resolve2(p);
  }
};
function pluginHooks(root, installedPath = join3(homedir3(), ".claude", "plugins", "installed_plugins.json"), userSettingsPath = join3(homedir3(), ".claude", "settings.json")) {
  const plugins = readJson(installedPath)["plugins"];
  if (typeof plugins !== "object" || plugins === null) return { active: false, events: [] };
  const settings = [
    userSettingsPath,
    join3(root, ".claude", "settings.json"),
    join3(root, ".claude", "settings.local.json")
  ].map(readJson);
  const enabled = (id) => settings.some((st) => st["enabledPlugins"]?.[id] === true);
  for (const [id, entries] of Object.entries(plugins)) {
    if (!id.startsWith(PLUGIN_ID_PREFIX) || !enabled(id) || !Array.isArray(entries)) continue;
    const entry = entries.find(
      (e) => e.scope === "user" || typeof e.projectPath === "string" && real(e.projectPath) === real(root)
    );
    if (!entry?.installPath) continue;
    const hooks = readJson(join3(entry.installPath, "hooks", "hooks.json"))["hooks"];
    return { active: true, events: typeof hooks === "object" && hooks !== null ? Object.keys(hooks) : [] };
  }
  return { active: false, events: [] };
}

// src/config/config.ts
import { readFileSync as readFileSync5 } from "node:fs";
import { join as join4 } from "node:path";
import { homedir as homedir4 } from "node:os";
var DEFAULT_CONFIG = {
  publish: { mode: "body", max_chars: 12e3, on_pr_create: true },
  extract: { decision_markers: [] },
  tests: { flag_edit_after_failure: true },
  redaction: { extra_patterns: [] },
  store: { dir: join4(homedir4(), ".local", "share", "pdl"), retention_days: 30 },
  problems: []
};
var PUBLISH_MODES = ["body", "comment"];
var isObject = (v) => typeof v === "object" && v !== null && !Array.isArray(v);
function readJson2(path, problems) {
  let text;
  try {
    text = readFileSync5(path, "utf8");
  } catch {
    return {};
  }
  try {
    const parsed = JSON.parse(text);
    if (!isObject(parsed)) {
      problems.push(`${path}: expected a JSON object`);
      return {};
    }
    return parsed;
  } catch {
    problems.push(`${path}: not valid JSON, ignoring it`);
    return {};
  }
}
function expandHome(p) {
  return p.startsWith("~/") ? join4(homedir4(), p.slice(2)) : p;
}
function applySection(name, base, raw, problems) {
  if (raw === void 0) return base;
  if (!isObject(raw)) {
    problems.push(`${name}: expected an object`);
    return base;
  }
  const out = { ...base };
  for (const [key, value] of Object.entries(raw)) {
    if (!(key in base)) {
      problems.push(`${name}.${key}: unknown setting, ignored`);
      continue;
    }
    const expected = base[key];
    const ok = Array.isArray(expected) ? Array.isArray(value) && value.every((v) => typeof v === "string") : typeof value === typeof expected;
    if (!ok) {
      problems.push(`${name}.${key}: expected ${Array.isArray(expected) ? "string[]" : typeof expected}, ignored`);
      continue;
    }
    out[key] = value;
  }
  return out;
}
function merge(base, raw, problems) {
  const known = /* @__PURE__ */ new Set(["publish", "extract", "tests", "redaction", "store", "$schema"]);
  for (const key of Object.keys(raw)) {
    if (!known.has(key)) problems.push(`${key}: unknown section, ignored`);
  }
  const merged = {
    publish: applySection("publish", base.publish, raw["publish"], problems),
    extract: applySection("extract", base.extract, raw["extract"], problems),
    tests: applySection("tests", base.tests, raw["tests"], problems),
    redaction: applySection("redaction", base.redaction, raw["redaction"], problems),
    store: applySection("store", base.store, raw["store"], problems),
    problems
  };
  if (!PUBLISH_MODES.includes(merged.publish.mode)) {
    problems.push(`publish.mode: expected one of ${PUBLISH_MODES.join(", ")}, using ${base.publish.mode}`);
    merged.publish = { ...merged.publish, mode: base.publish.mode };
  }
  const valid = merged.redaction.extra_patterns.filter((p) => {
    try {
      new RegExp(p);
      return true;
    } catch {
      problems.push(`redaction.extra_patterns: ${JSON.stringify(p)} is not a valid regular expression, ignored`);
      return false;
    }
  });
  merged.redaction = { ...merged.redaction, extra_patterns: valid };
  if (!Number.isFinite(merged.store.retention_days) || merged.store.retention_days < 0) {
    problems.push(`store.retention_days: expected 0 or more days, using ${base.store.retention_days}`);
    merged.store = { ...merged.store, retention_days: base.store.retention_days };
  }
  if (merged.publish.max_chars < 1e3) {
    problems.push(`publish.max_chars: below 1000 leaves no room for the log, using ${base.publish.max_chars}`);
    merged.publish = { ...merged.publish, max_chars: base.publish.max_chars };
  }
  merged.store = { ...merged.store, dir: expandHome(merged.store.dir) };
  return merged;
}
function loadConfig(repoRoot2, userDir = join4(homedir4(), ".config", "pdl")) {
  const problems = [];
  const user = readJson2(join4(userDir, "config.json"), problems);
  const repo = readJson2(join4(repoRoot2, "pdl.config.json"), problems);
  return merge(merge(DEFAULT_CONFIG, user, problems), repo, problems);
}

// src/pdl.ts
import { spawnSync as spawnSync4 } from "node:child_process";
import { readFileSync as readFileSync6 } from "node:fs";
import { join as join5 } from "node:path";
process.stdout.on("error", (e) => {
  if (e.code === "EPIPE") process.exit(typeof process.exitCode === "number" ? process.exitCode : 0);
  throw e;
});
function git2(args) {
  const p = spawnSync4("git", args, { encoding: "utf8" });
  return p.status === 0 ? (p.stdout ?? "").trim() : "";
}
function currentBranch() {
  return git2(["symbolic-ref", "--short", "-q", "HEAD"]);
}
function logMeta(branch, base) {
  return {
    repo: git2(["remote", "get-url", "origin"]) || "unknown",
    branch: branch || "detached",
    headSha: git2(["rev-parse", "--short", "HEAD"]),
    repoRoot: repoRoot(),
    diff: diffAgainst(base),
    flagEditAfterFailure: config.tests.flag_edit_after_failure,
    extraRedactions: compileExtraPatterns(config.redaction.extra_patterns)
  };
}
function decisionsIn(transcript) {
  return transcript ? extractDecisions(readTranscript(transcript), { extraMarkers: config.extract.decision_markers }) : [];
}
function renderSession(store2, sessionId) {
  const log = buildLog(store2.read(sessionId), logMeta(currentBranch(), defaultBase()), decisionsIn(findTranscript(sessionId)));
  return render(log, { maxChars: config.publish.max_chars });
}
function renderBranch(store2, root, branch, base) {
  const merged = eventsForBranch(store2, root, branch);
  const seen = /* @__PURE__ */ new Set();
  const decisions = merged.sessions.flatMap(
    (session) => selectForBranch(
      decisionsIn(merged.transcripts.get(session) ?? findTranscript(session)),
      merged.turnsBySession.get(session) ?? [],
      branch
    )
  ).filter((d) => {
    const key = `${d.kind}|${d.text}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const log = buildLog(merged.events, { ...logMeta(branch, base), sessions: merged.sessions }, decisions);
  return render(log, { maxChars: config.publish.max_chars });
}
function build(store2, sessionId) {
  if (sessionId) {
    process.stdout.write(renderSession(store2, sessionId));
    return;
  }
  const branch = currentBranch();
  if (!branch) {
    process.stderr.write("pdl build: detached HEAD; pass a session id instead\n");
    process.exitCode = 2;
    return;
  }
  process.stdout.write(renderBranch(store2, repoRoot(), branch, defaultBase()));
}
async function publishCmd(store2, sessionId, prNumber, dryRun) {
  if (!sessionId || !prNumber) {
    process.stderr.write("usage: pdl publish <session-id> <pr-number> [--dry-run]\n");
    process.exitCode = 2;
    return;
  }
  const result = await publish({
    prNumber: Number(prNumber),
    section: renderSession(store2, sessionId),
    dryRun
  });
  process.stdout.write(`${result.status}${result.error ? `: ${result.error}` : ""}
`);
}
function readStdin() {
  return new Promise((resolve3) => {
    let buf = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (c) => {
      buf += c;
    });
    process.stdin.on("end", () => resolve3(buf));
    process.stdin.on("error", () => resolve3(""));
  });
}
async function hook(store2) {
  const raw = await readStdin();
  try {
    if (isDisabled()) return;
    const payload = raw.trim() ? JSON.parse(raw) : {};
    const event = handleHook(store2, payload);
    const sessionId = typeof payload["session_id"] === "string" ? payload["session_id"] : "";
    const created = config.publish.on_pr_create && event ? detectPrCreation(event) !== null : false;
    const stopped = payload["hook_event_name"] === "Stop";
    if (!sessionId || !(created || stopped)) return;
    const branch = currentBranch();
    if (!branch) return;
    const root = repoRoot();
    const transcript = typeof payload["transcript_path"] === "string" ? payload["transcript_path"] : void 0;
    store2.appendTurn({ session: sessionId, repo: root, branch, at: (/* @__PURE__ */ new Date()).toISOString(), ...transcript ? { transcript } : {} });
    if (stopped) store2.pruneIfDue(config.store.retention_days, Date.now());
    await autoPublish({
      key: `${root}#${branch}`,
      created,
      mode: config.publish.mode,
      defaultBase: defaultBase(),
      state: publishState,
      build: (base) => renderBranch(store2, root, branch, base)
    });
  } catch {
  }
}
function init(scope) {
  const path = settingsPathFor(scope, repoRoot());
  const existed = settingsExist(path);
  const root = repoRoot();
  const merged = mergeHooks(readSettings(path), hookCommand(process.argv[1], scope, root));
  writeSettings(path, merged);
  process.stdout.write(`${existed ? "updated" : "created"} ${path}
`);
  process.stdout.write(`  registered ${pdlHookEvents(merged).length} hook events
`);
  if (pluginHooks(root).active) {
    process.stdout.write(
      "  warning: the pr-decision-log plugin is already active here; every hook will fire twice. Uninstall the plugin or undo this.\n"
    );
  }
  const other = scope === "user" ? "project" : "user";
  if (pdlHookEvents(readSettings(settingsPathFor(other, root))).length > 0) {
    process.stdout.write(
      `  warning: pdl is also registered in ${other} settings (${settingsPathFor(other, root)}); every hook will fire twice. Remove one of them.
`
    );
  }
  if (scope === "project") {
    process.stdout.write("  hooks stay dormant until you accept the trust dialog for this folder\n");
  }
}
var ICON = { ok: "ok  ", warn: "warn", fail: "FAIL", skip: "skip" };
function doctor(store2) {
  const root = repoRoot();
  const projectPath = settingsPathFor("project", root);
  const userPath = settingsPathFor("user", root);
  const project = readSettings(projectPath);
  const user = readSettings(userPath);
  const plugin = pluginHooks(root);
  const events = [.../* @__PURE__ */ new Set([...pdlHookEvents(project), ...pdlHookEvents(user), ...plugin.events])];
  const facts = {
    nodeVersion: process.version,
    hookEvents: events,
    settingsPath: pdlHookEvents(project).length > 0 ? projectPath : pdlHookEvents(user).length > 0 ? userPath : void 0,
    recordedSessions: store2.sessionCount(),
    gh: ghStatus(),
    env: process.env,
    configProblems: config.problems,
    trust: trustState(root),
    hookScopes: [
      ...pdlHookEvents(project).length > 0 ? ["project"] : [],
      ...pdlHookEvents(user).length > 0 ? ["user"] : [],
      ...plugin.active ? ["plugin"] : []
    ]
  };
  const checks = diagnose(facts);
  for (const c of checks) {
    process.stdout.write(`  [${ICON[c.status]}] ${c.name}: ${c.detail}
`);
    if (c.remedy && c.status !== "ok") process.stdout.write(`         -> ${c.remedy}
`);
  }
  const worst = worstStatus(checks);
  process.stdout.write(`
${worst === "ok" ? "all good" : `worst: ${worst}`}
`);
  if (worst === "fail") process.exitCode = 1;
}
async function redactCheck(file) {
  const input = file ? readFileSync6(file, "utf8") : await readStdin();
  const { text, hits } = redact(input);
  process.stdout.write(text.endsWith("\n") ? text : `${text}
`);
  process.stderr.write(
    hits.length === 0 ? "\nno redaction rules matched\n" : `
${hits.length} rule(s) matched: ${[...new Set(hits)].join(", ")}
`
  );
  if (hits.length > 0) process.exitCode = 1;
}
function purge(store2) {
  const n = store2.purge();
  process.stdout.write(`removed ${n} recorded session(s)
`);
}
function printTimeline(label, events) {
  const commands = events.filter((e) => e.kind === "command");
  const edits = events.filter((e) => e.kind === "edit");
  const flags = detectTestEditedAfterFailure(events);
  process.stdout.write(`${label}
`);
  process.stdout.write(`  ${events.length} events: ${commands.length} commands, ${edits.length} edits
`);
  for (const c of commands) {
    if (c.kind !== "command") continue;
    process.stdout.write(`  [${c.classification}] ${c.outcome.padEnd(11)} ${c.command.split("\n")[0]?.slice(0, 60)}
`);
  }
  if (flags.length === 0) {
    process.stdout.write("  no flags\n");
    return;
  }
  process.stdout.write(`
  ${flags.length} flag(s):
`);
  for (const f of flags) process.stdout.write(`  - ${f.code} ${f.file}
      ${f.detail}
`);
}
function show(store2, sessionId) {
  if (sessionId) {
    printTimeline(`session ${sessionId}`, store2.read(sessionId));
    return;
  }
  const branch = currentBranch();
  if (!branch) {
    process.stderr.write("pdl show: detached HEAD; pass a session id (see `pdl sessions`)\n");
    process.exitCode = 2;
    return;
  }
  const merged = eventsForBranch(store2, repoRoot(), branch);
  const n = merged.sessions.length;
  printTimeline(`branch ${branch} (${n} session${n === 1 ? "" : "s"})`, merged.events);
}
var fmtTime = (ms) => {
  const d = new Date(ms);
  const pad = (x) => String(x).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
};
function sessions(store2, all) {
  const list = summariseSessions(store2.sessionsInfo(), store2.turns(), all ? void 0 : repoRoot());
  if (list.length === 0) {
    process.stdout.write(all ? "no sessions recorded\n" : "no sessions recorded for this repository (try --all)\n");
    return;
  }
  for (const s of list) {
    const where = s.branches.length > 0 ? s.branches.join(", ") : "(branch not recorded)";
    const repo = all && s.repo ? `  ${s.repo}` : "";
    process.stdout.write(`${s.id}  ${fmtTime(s.lastActivityMs)}  ${String(s.events).padStart(4)} events  ${where}${repo}
`);
  }
}
function remove(scope) {
  const root = repoRoot();
  const path = settingsPathFor(scope, root);
  const { settings, removed } = removeHooks(readSettings(path));
  if (removed === 0) {
    process.stdout.write(`no pdl hooks in ${path}
`);
  } else {
    writeSettings(path, settings);
    process.stdout.write(`removed ${removed} pdl hook(s) from ${path}
`);
  }
  if (pluginHooks(root).active) {
    process.stdout.write("  the pr-decision-log plugin is still active here; remove it with `/plugin uninstall pr-decision-log@pr-decision-log`\n");
  }
  process.stdout.write("  recorded sessions are kept; `pdl purge` deletes them\n");
}
var config = loadConfig(repoRoot());
var storeRoot = process.env["PDL_HOME"] ?? config.store.dir;
var store = new EventStore(storeRoot);
var publishState = new FilePublishState(join5(storeRoot, "publish-state.json"));
var [command, arg] = process.argv.slice(2);
switch (command) {
  case "hook":
    await hook(store);
    break;
  case "show":
    show(store, arg);
    break;
  case "build":
    build(store, arg);
    break;
  case "publish":
    await publishCmd(store, arg, process.argv[4], process.argv.includes("--dry-run"));
    break;
  case "init":
    init(process.argv.includes("--user") ? "user" : "project");
    break;
  case "doctor":
    doctor(store);
    break;
  case "sessions":
    sessions(store, process.argv.includes("--all"));
    break;
  case "remove":
    remove(process.argv.includes("--user") ? "user" : "project");
    break;
  case "purge":
    purge(store);
    break;
  case "redact-check":
    await redactCheck(arg);
    break;
  default:
    process.stderr.write("usage: pdl <doctor|init|remove|sessions|show|build|publish|purge|redact-check|hook>\n");
    process.exitCode = 2;
}
