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

// src/events/command-text.ts
var HEREDOC_RE = /(?<!<)<<(-?)\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\2/g;
function splitHeredocs(command2) {
  const out = [];
  const bodies = [];
  const pending = [];
  for (const line of command2.split("\n")) {
    const open = pending[0];
    if (open) {
      if ((open.tabs ? line.replace(/^\t+/, "") : line) === open.delimiter) {
        bodies.push(open.lines.join("\n"));
        pending.shift();
      } else open.lines.push(line);
      continue;
    }
    out.push(line);
    for (const m of line.matchAll(HEREDOC_RE)) pending.push({ delimiter: m[3] ?? "", tabs: m[1] === "-", lines: [] });
  }
  for (const open of pending) bodies.push(open.lines.join("\n"));
  return { text: out.join("\n"), bodies };
}
function stripHeredocs(command2) {
  return splitHeredocs(command2).text;
}
function blankQuotes(text) {
  let out = "";
  let quote2;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote2) {
      if (c === "\\" && quote2 === '"') {
        i++;
        continue;
      }
      if (c === quote2) {
        quote2 = void 0;
        out += c;
      }
      continue;
    }
    if (c === "\\") {
      out += c + (text[i + 1] ?? "");
      i++;
      continue;
    }
    if (c === '"' || c === "'") quote2 = c;
    out += c;
  }
  return out;
}
function scriptSkeleton(command2) {
  return blankQuotes(stripHeredocs(command2));
}
var NOT_INVOCATION = /^\s*(#|echo\b|printf\b)/;
function commandSegments(command2) {
  return scriptSkeleton(command2).split("\n").filter((l) => l.trim() && !NOT_INVOCATION.test(l)).flatMap((l) => l.replace(/\d*>&\d+|&>/g, ">").split(/&&|\|\||[;|&]/)).map((s) => s.replace(/[()]/g, " ").trim()).filter((s) => s && !NOT_INVOCATION.test(s));
}
var RUNNER_KINDS = {
  test: /\b(?:npm|pnpm|yarn|bun)(?:\s+--?[\w-]+(?:[= ](?!run\b|test\b|e2e\b)[^\s-]\S*)?)*\s+(?:run\s+)?(?:test|e2e)\b|\b(?:npm|pnpm|yarn|bun)\s+run\s+(?:test|e2e):[\w-]+|\bvitest\b|\bjest\b|\bpytest\b|\bplaywright\s+test\b|\bgo\s+test\b|\bswift\s+test\b|\bcargo\s+test\b|\bnode\s+--test\b|\brspec\b|\bphpunit\b|\bdotnet\s+test\b|\bxcodebuild\b[^\n]*\btest\b|\b(?:just|make|task)\s+(?:test|e2e)\b/,
  lint: /\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?lint\b|\beslint\b|\bprettier\b|\bruff\b|\bblack\b|\bcargo\s+(?:clippy|fmt)\b|\bswiftlint\b|\bgolangci-lint\b|\bflake8\b|\bmypy\b|\b(?:just|make|task)\s+lint\b/,
  build: /\b(?:npm|pnpm|yarn|bun)(?:\s+--?[\w-]+(?:[= ](?!run\b|build\b|typecheck\b)[^\s-]\S*)?)*\s+(?:run\s+)?(?:build|typecheck|type-check)\b|\btsc\b|\bpyright\b|\bcargo\s+build\b|\bgo\s+build\b|\bswift\s+build\b|\bxcodebuild\b|\bmake\b|\bgradle\b|\bmvn\b|\bdocker\s+(?:compose\s+)?build\b|\b(?:just|task)\s+(?:build|typecheck)\b/
};
var LAUNCHER_RE = /^(?:(?:[A-Za-z_][A-Za-z0-9_]*=\S*|timeout\s+\S+|time|env|nice|exec|command)\s+)+/;
var WRAPPER_RE = /^(?:npx|bunx|pnpm\s+(?:exec|dlx)|yarn\s+(?:exec|dlx)|uv\s+run|poetry\s+run|pipenv\s+run|bundle\s+exec|python3?\s+-m)(?:\s+--?[\w-]+)*\s+/;
function withoutWrapper(fragment2) {
  return fragment2.replace(LAUNCHER_RE, "").replace(WRAPPER_RE, "");
}
function runsKind(segment, re) {
  const head = segment.replace(LAUNCHER_RE, "");
  const anchored = new RegExp(`^(?:${re.source})`);
  return anchored.test(head) || anchored.test(head.replace(WRAPPER_RE, ""));
}
var SAFE_WORD = /^(?!\/|~|\.\.)[\w@.:,=+%/-]+$/;
var MAX_FRAGMENT = 80;
function runnerFragment(command2) {
  for (const kind of ["test", "lint", "build"]) {
    const segment = commandSegments(command2).find((s) => runsKind(s, RUNNER_KINDS[kind]));
    if (!segment) continue;
    const words = [];
    for (const word of segment.replace(LAUNCHER_RE, "").split(/\s+/)) {
      if (!SAFE_WORD.test(word) || /^\d*>/.test(word)) break;
      if ([...words, word].join(" ").length > MAX_FRAGMENT) break;
      words.push(word);
    }
    if (words.length > 0) return words.join(" ");
  }
  return void 0;
}

// src/events/classify-command.ts
var PATTERNS = [
  ["test", RUNNER_KINDS.test],
  ["lint", RUNNER_KINDS.lint],
  ["build", RUNNER_KINDS.build],
  ["git", /\bgit\s+\w|\bgh\s+\w/]
];
function classifyCommand(command2) {
  const segments = commandSegments(command2);
  for (const [kind, re] of PATTERNS) {
    if (segments.some((l) => runsKind(l, re))) return kind;
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
var FAILING_TEST_LINES = [
  // pytest: FAILED path.py::Class::test_name[param] - message
  { re: /^(?:FAILED|ERROR) (\S+?\.py)::(\S+?)(?:\[[^\]\n]*\])?(?:\s+-\s.*)?$/gm, read: (m) => ({ file: m[1], name: m[2] }) },
  // go: --- FAIL: TestName (0.00s)
  { re: /^\s*--- FAIL: (\S+)/gm, read: (m) => ({ name: m[1] }) },
  // vitest: FAIL  path.test.ts > suite > test
  { re: /^\s*(?:FAIL|×)\s+(\S+\.[cm]?[tj]sx?)\s+>\s+(.+?)\s*$/gm, read: (m) => ({ file: m[1], name: m[2] }) },
  // jest: ● suite › test
  { re: /^\s*● (.+?)\s*$/gm, read: (m) => ({ name: m[1] }) },
  // node:test: ✖ test name (1.2ms)
  { re: /^\s*✖ (.+?) \(\d+(?:\.\d+)?m?s\)\s*$/gm, read: (m) => ({ name: m[1] }) }
];
var MAX_NAME = 100;
var MAX_TESTS = 20;
function failingTests(output) {
  const found = [];
  for (const { re, read } of FAILING_TEST_LINES) {
    for (const m of output.matchAll(re)) {
      const t = read(m);
      const name = t.name.length > MAX_NAME ? `${t.name.slice(0, MAX_NAME - 1)}\u2026` : t.name;
      found.push({ at: m.index, test: { ...t.file ? { file: t.file } : {}, name } });
    }
  }
  const out = [];
  for (const { test } of found.sort((a, b) => a.at - b.at)) {
    if (out.length >= MAX_TESTS) break;
    if (!out.some((t) => t.name === test.name && t.file === test.file)) out.push(test);
  }
  return out;
}

// src/events/location.ts
import { homedir as homedir2 } from "node:os";
import { resolve } from "node:path";
var ASSIGNMENT_RE = /^(?:[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|\S*)\s+)+/;
var PATH_ARG = String.raw`("[^"$\`]*"|'[^']*'|[^\s;&|()"'\`$]+|\$HOME[^\s;&|()]*|\$\{HOME\}[^\s;&|()]*)`;
var CD_RE = new RegExp(String.raw`^(?:cd|pushd)\s+${PATH_ARG}\s*$`);
var GIT_C_RE = new RegExp(String.raw`^git\s+-C\s+${PATH_ARG}\s`);
function unquote(arg2, home) {
  if (arg2.startsWith('"') && arg2.endsWith('"') || arg2.startsWith("'") && arg2.endsWith("'")) arg2 = arg2.slice(1, -1);
  if (arg2 === "~" || arg2.startsWith("~/")) return home + arg2.slice(1);
  return arg2.replace(/^\$\{?HOME\}?/, home);
}
function commandDir(command2, cwd, home = homedir2()) {
  const firstLine = command2.split("\n")[0] ?? "";
  let dir = cwd;
  for (let segment of firstLine.split(/&&|\|\||;/)) {
    segment = segment.trim().replace(/^\(+\s*/, "").replace(/\s*\)+$/, "");
    if (!segment) continue;
    if (/^(?:export|set)\s/.test(segment)) continue;
    segment = segment.replace(ASSIGNMENT_RE, "");
    const cd = CD_RE.exec(segment);
    if (cd?.[1]) {
      if (cd[1] === "-") return cwd;
      dir = resolve(dir, unquote(cd[1], home));
      continue;
    }
    if (/^(?:cd|pushd)\b/.test(segment)) return cwd;
    const gitC = GIT_C_RE.exec(`${segment} `);
    if (gitC?.[1]) return resolve(dir, unquote(gitC[1], home));
    break;
  }
  return dir;
}

// src/events/shell-writes.ts
import { homedir as homedir3 } from "node:os";
import { isAbsolute, resolve as resolve2 } from "node:path";
var SEPARATORS = /* @__PURE__ */ new Set([";", "&&", "||", "|", "&", "(", ")"]);
function tokenize(text) {
  const out = [];
  let word;
  const flush = () => {
    if (word) out.push(word);
    word = void 0;
  };
  const w = () => word ??= { k: "w", v: "", dynamic: false };
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    const rest = text.slice(i);
    if (c === "\n") {
      flush();
      out.push({ k: "op", v: ";" });
      continue;
    }
    if (c === " " || c === "	") {
      flush();
      continue;
    }
    if (c === "#" && !word) {
      while (i + 1 < text.length && text[i + 1] !== "\n") i++;
      continue;
    }
    if (c === "\\") {
      w().v += text[i + 1] ?? "";
      i++;
      continue;
    }
    if (c === "'") {
      const end = text.indexOf("'", i + 1);
      w().v += text.slice(i + 1, end === -1 ? void 0 : end);
      i = end === -1 ? text.length : end;
      continue;
    }
    if (c === '"') {
      const cur = w();
      for (i++; i < text.length && text[i] !== '"'; i++) {
        if (text[i] === "\\") {
          cur.v += text[i + 1] ?? "";
          i++;
          continue;
        }
        if (text[i] === "$" || text[i] === "`") cur.dynamic = true;
        cur.v += text[i];
      }
      continue;
    }
    if (c === "$" || c === "`") {
      const cur = w();
      cur.dynamic = true;
      if (c === "`") {
        const end = text.indexOf("`", i + 1);
        i = end === -1 ? text.length : end;
        continue;
      }
      if (text[i + 1] === "(") {
        let depth = 0;
        for (; i < text.length; i++) {
          if (text[i] === "(") depth++;
          else if (text[i] === ")" && --depth === 0) break;
        }
        continue;
      }
      cur.v += c;
      continue;
    }
    if ((c === ">" || c === "<") && word && /^\d+$/.test(word.v) && !word.dynamic) {
      word = void 0;
      const op2 = rest.startsWith(">>") ? ">>" : rest.startsWith(">&") ? ">&" : c;
      out.push({ k: "op", v: `fd${op2}` });
      i += op2.length - 1;
      continue;
    }
    const op = ["&&", "||", "<<<", "<<-", "<<", ">>", ">|", ">&", "&>", "|", ";", "&", "(", ")", ">", "<"].find((o) => rest.startsWith(o));
    if (op) {
      flush();
      out.push({ k: "op", v: op });
      i += op.length - 1;
      continue;
    }
    w().v += c;
  }
  flush();
  return out;
}
function simpleCommands(tokens, bodies) {
  const out = [];
  let cur = { words: [], outputs: [], piped: false };
  let nextBody = 0;
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.k === "w") {
      cur.words.push(t);
      continue;
    }
    if (SEPARATORS.has(t.v)) {
      out.push(cur);
      cur = { words: [], outputs: [], piped: t.v === "|" };
      continue;
    }
    const target = tokens[i + 1];
    if (target?.k !== "w") continue;
    i++;
    if (t.v === ">" || t.v === ">>" || t.v === ">|") cur.outputs.push({ path: target, append: t.v === ">>" });
    else if (t.v === "<<" || t.v === "<<-") cur.body = bodies[nextBody++];
  }
  out.push(cur);
  return out;
}
var PREFIX_WORDS = /* @__PURE__ */ new Set(["sudo", "env", "command", "exec", "time", "nohup", "nice"]);
function commandName(words) {
  let i = 0;
  while (i < words.length && (/^[A-Za-z_]\w*=/.test(words[i].v) || PREFIX_WORDS.has(words[i].v))) i++;
  return { name: words[i]?.v ?? "", args: words.slice(i + 1) };
}
var operands = (args) => args.filter((a) => !a.v.startsWith("-"));
function sedFiles(args) {
  let inPlace = false;
  let script = false;
  const files = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.v === "-i" || a.v === "-I") {
      inPlace = true;
      const next = args[i + 1];
      if (next && (next.v === "" || /^\.\w+$/.test(next.v))) i++;
    } else if (/^-[iI]\S/.test(a.v) || a.v === "--in-place" || a.v.startsWith("--in-place=")) inPlace = true;
    else if (a.v === "-e" || a.v === "-f" || a.v === "--expression") {
      script = true;
      i++;
    } else if (a.v.startsWith("-")) continue;
    else if (!script) script = true;
    else files.push(a);
  }
  return inPlace ? files : [];
}
function literalAt(text, i) {
  const prefix = /^[rRbBuU]{0,2}/.exec(text.slice(i, i + 2))?.[0] ?? "";
  const raw = /r/i.test(prefix);
  let j = i + prefix.length;
  for (const triple of [`'''`, `"""`]) {
    if (!text.startsWith(triple, j)) continue;
    const end = text.indexOf(triple, j + 3);
    return end < 0 ? void 0 : { value: text.slice(j + 3, end), end: end + 3 };
  }
  const quote2 = text[j];
  if (quote2 !== "'" && quote2 !== '"' && quote2 !== "`") return void 0;
  let value = "";
  for (j += 1; j < text.length; j++) {
    const c = text[j];
    if (c === "\\" && !raw) {
      const next = text[j + 1] ?? "";
      value += next === "n" ? "\n" : next === "t" ? "	" : next;
      j++;
      continue;
    }
    if (c === quote2) return { value, end: j + 1 };
    if (c === "\n" && quote2 !== "`") return void 0;
    if (quote2 === "`" && c === "$" && text[j + 1] === "{") return void 0;
    value += c;
  }
  return void 0;
}
function literalAssignments(body) {
  const out = [];
  for (const m of body.matchAll(/(?:^|[;\n{]|\b(?:const|let|var)\s)\s*([A-Za-z_]\w*)\s*=(?!=)\s*/g)) {
    const lit = literalAt(body, m.index + m[0].length);
    if (lit) out.push({ at: m.index, name: m[1], value: lit.value });
  }
  return out;
}
var UNREADABLE_CHANGE = /\bre\.sub\(|\bsub\(|\+=|\.replaceAll\(|\.format\(|\bf['"]/;
function replacements(segment, at) {
  if (UNREADABLE_CHANGE.test(segment)) return void 0;
  const arg2 = (pos) => {
    const start = pos + (/^\s*/.exec(segment.slice(pos))?.[0].length ?? 0);
    const lit = literalAt(segment, start);
    if (lit) return lit;
    const name = /^[A-Za-z_]\w*/.exec(segment.slice(start))?.[0];
    const value = name ? at(name, start) : void 0;
    return name && value !== void 0 ? { value, end: start + name.length } : void 0;
  };
  const olds = [];
  const news = [];
  for (const m of segment.matchAll(/\.replace\(/g)) {
    const first = arg2(m.index + m[0].length);
    const comma = first ? /^\s*,/.exec(segment.slice(first.end)) : null;
    const second = first && comma ? arg2(first.end + comma[0].length) : void 0;
    const close = second ? /^\s*(?:,\s*\d+\s*)?\)/.exec(segment.slice(second.end)) : null;
    if (!first || !second || !close) return void 0;
    olds.push(first.value);
    news.push(second.value);
  }
  return olds.length > 0 ? { old: olds.join("\n"), new: news.join("\n") } : void 0;
}
function scriptWrites(body) {
  const assignments = literalAssignments(body);
  const valueAt = (name, at) => assignments.filter((a) => a.name === name && a.at < at).at(-1)?.value;
  const found = [];
  for (const m of body.matchAll(/\bopen\(\s*(?:(['"])([^'"\n]+)\1|(\w+))\s*,\s*(['"])([^'"\n]*)\4/g)) {
    const path = m[2] ?? valueAt(m[3], m.index);
    if (path && /[wax]/.test(m[5])) found.push({ at: m.index, path, append: m[5].includes("a") });
  }
  for (const m of body.matchAll(/\bPath\(\s*(['"])([^'"\n]+)\1\s*\)\.write_(?:text|bytes)\(/g)) {
    found.push({ at: m.index, path: m[2], append: false });
  }
  for (const m of body.matchAll(/\b(writeFileSync|appendFileSync|writeFile|appendFile)\(\s*(?:(['"`])([^'"`\n$]+)\2|(\w+))/g)) {
    const path = m[3] ?? valueAt(m[4], m.index);
    if (path) found.push({ at: m.index, path, append: m[1].startsWith("append") });
  }
  found.sort((a, b) => a.at - b.at);
  return found.map((w, i) => {
    const from = i === 0 ? 0 : found[i - 1].at;
    const replaced = replacements(body.slice(from, w.at), (name, pos) => valueAt(name, from + pos));
    return { path: w.path, append: w.append, ...replaced ? { replaced } : {} };
  });
}
var INTERPRETERS = /^(?:python3?(?:\.\d+)?|node|ruby)$/;
function shellWrites(command2, cwd, home = homedir3()) {
  const { text, bodies } = splitHeredocs(command2);
  let dir = cwd;
  const place = (p) => {
    if (p === "" || p.startsWith("/dev/")) return void 0;
    const expanded = p === "~" || p.startsWith("~/") ? home + p.slice(1) : p;
    if (isAbsolute(expanded)) return resolve2(expanded);
    return dir ? resolve2(dir, expanded) : expanded;
  };
  const writes = [];
  const add = (word, append, content, replaced) => {
    if (typeof word !== "string" && word.dynamic) return;
    const raw = typeof word === "string" ? word : word.v;
    if (raw.endsWith("/") || raw === "." || raw === "..") return;
    const path = place(raw);
    if (!path) return;
    const seen = writes.find((x) => x.path === path);
    if (seen) {
      if (!append) seen.append = false;
      const merged = seen.replaced && replaced ? { old: `${seen.replaced.old}
${replaced.old}`, new: `${seen.replaced.new}
${replaced.new}` } : void 0;
      if (merged) seen.replaced = merged;
      else delete seen.replaced;
      return;
    }
    writes.push({ path, append, ...content !== void 0 ? { content } : {}, ...replaced ? { replaced } : {} });
  };
  for (const cmd of simpleCommands(tokenize(text), bodies)) {
    const { name, args } = commandName(cmd.words);
    if ((name === "cd" || name === "pushd") && args[0] && !args[0].dynamic && args[0].v !== "-") {
      dir = place(args[0].v) ?? dir;
      continue;
    }
    const verbatim = name === "cat" && operands(args).length === 0 && !cmd.piped ? cmd.body : void 0;
    for (const o of cmd.outputs) add(o.path, o.append, verbatim);
    if (name === "tee") for (const a of operands(args)) add(a, args.some((x) => x.v === "-a" || x.v === "--append"));
    if (name === "sed") for (const f of sedFiles(args)) add(f, false);
    if (name === "cp" || name === "mv" || name === "install") {
      const ops = operands(args);
      if (ops.length >= 2) add(ops[ops.length - 1], false);
    }
    if (INTERPRETERS.test(name) && cmd.body) for (const s of scriptWrites(cmd.body)) add(s.path, s.append, void 0, s.replaced);
  }
  return writes;
}

// src/events/normalize.ts
import { dirname, isAbsolute as isAbsolute2 } from "node:path";
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
  const cwd = str(payload["cwd"]);
  if (tool === "Bash") {
    const command2 = str(input["command"]) ?? "";
    const classification = classifyCommand(command2);
    const dir = cwd ? { dir: commandDir(command2, cwd) } : {};
    const written = shellWrites(command2, cwd).map((w) => ({
      path: w.path,
      ...w.append ? { append: true } : {},
      ...w.content !== void 0 && !w.append ? { assertionsAfter: countAssertions(w.content) } : {},
      // A scripted replace is counted like an Edit tool edit: what it took out against what it put in.
      ...w.replaced ? { assertionsBefore: countAssertions(w.replaced.old), assertionsAfter: countAssertions(w.replaced.new) } : {}
    }));
    const writes = written.length > 0 ? { writes: written } : {};
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
        durationMs,
        ...dir,
        ...writes
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
      durationMs,
      ...dir,
      ...writes
    };
  }
  if (EDIT_TOOLS.has(tool ?? "") || WRITE_TOOLS.has(tool ?? "")) {
    const path = str(input["file_path"]) ?? str(input["notebook_path"]) ?? "";
    if (!path) return null;
    const dir = isAbsolute2(path) ? { dir: dirname(path) } : {};
    if (WRITE_TOOLS.has(tool ?? "")) {
      return { kind: "edit", id, at: recordedAt, path, ...dir };
    }
    const before = input["old_string"];
    const after = input["new_string"];
    if (typeof before !== "string" || typeof after !== "string") {
      return { kind: "edit", id, at: recordedAt, path, ...dir };
    }
    return {
      kind: "edit",
      id,
      at: recordedAt,
      path,
      ...dir,
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
import { basename } from "node:path";
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
function summariseCommand(command2) {
  return runnerFragment(command2) ?? `(${classifyCommand(command2)} command)`;
}
var hhmm = (at) => /T(\d{2}:\d{2})/.exec(at)?.[1] ?? at;
function gap(from, to) {
  const s = Math.round((Date.parse(to) - Date.parse(from)) / 1e3);
  if (!Number.isFinite(s) || s < 0) return "";
  if (s < 60) return `${s} s`;
  if (s < 3600) return `${Math.round(s / 60)} min`;
  return `${Math.round(s / 3600)} h`;
}
var plural = (n, one) => `${n} ${one}${n === 1 ? "" : "s"}`;
function assertionNote(w) {
  const removed = w.before - w.after;
  if (removed <= 0) return "";
  return w.unknown === 0 ? ` ${plural(removed, "assertion")} removed overall.` : ` The edits pdl could read removed ${plural(removed, "assertion")}.`;
}
function outcome(refails, end) {
  const last = refails[refails.length - 1];
  const again = !last ? "" : refails.length === 1 ? `it failed again at ${hhmm(last.at)}` : `it failed again ${refails.length} more times, last at ${hhmm(last.at)}`;
  const other = end.interruptedBy ? `\`${summariseCommand(end.interruptedBy.command)}\` failed at ${hhmm(end.interruptedBy.at)}` : "";
  if (end.passed) return again ? `${again}, then passed at ${hhmm(end.passed.at)}` : `it passed at ${hhmm(end.passed.at)}`;
  if (other) return again ? `${again}, and did not pass again before ${other}` : `it did not pass again before ${other}`;
  return again ? `${again}, and has not passed since` : "it has not passed since";
}
function testsIn(failures, path) {
  const names = [];
  for (const f of failures) {
    for (const t of failingTests(f.output ?? "")) {
      if (t.file && basename(t.file) !== basename(path)) continue;
      if (!names.includes(t.name)) names.push(t.name);
    }
  }
  return names;
}
var namedTests = (names) => names.length === 0 ? "" : ` (${names.slice(0, 2).map((n) => `\`${n}\``).join(", ")}${names.length > 2 ? ` +${names.length - 2} more` : ""})`;
function detail(failure, w, refails, end, tests) {
  const how = w.viaShell === w.count ? "from the shell" : w.viaShell === 0 ? "with the Edit tool" : "with the Edit tool and from the shell";
  const soon = gap(failure.at, w.first.at);
  const change = w.count === 1 ? `the test was ${how === "from the shell" ? "written from the shell" : `changed ${how}`}${soon ? ` ${soon} later` : ""}` : `the test was changed ${w.count} times ${how}${soon ? `, first ${soon} later` : ""}`;
  return `\`${summariseCommand(failure.command)}\` failed at ${hhmm(failure.at)}${namedTests(tests)}; ${change}; ${outcome(refails, end)}.${assertionNote(w)}`;
}
function sameRun(a, b) {
  if (a.command === b.command) return true;
  const fragment2 = runnerFragment(a.command);
  return fragment2 !== void 0 && fragment2 === runnerFragment(b.command);
}
function detectTestEditedAfterFailure(events) {
  const flags = [];
  let openFailure = null;
  let refails = [];
  let window = /* @__PURE__ */ new Map();
  const emit = (failure, end) => {
    for (const w of window.values()) {
      if (w.unknown === 0 && isPurelyAdditive(w.before, w.after)) continue;
      if (w.first.additive && w.last.additive) continue;
      const tests = testsIn([failure, ...refails], w.first.path);
      flags.push({
        code: "TEST_EDITED_AFTER_FAILURE",
        severity: "warn",
        file: w.first.path,
        detail: detail(failure, w, refails, end, tests),
        evidence: [failure.id, w.first.id],
        ...tests.length > 0 ? { tests } : {}
      });
    }
    window = /* @__PURE__ */ new Map();
    refails = [];
  };
  for (const e of events) {
    if (e.kind === "command") {
      if (classifyCommand(e.command) !== "test") continue;
      if (e.outcome === "fail") {
        if (openFailure && sameRun(e, openFailure)) {
          refails.push(e);
          continue;
        }
        if (openFailure) emit(openFailure, { interruptedBy: e });
        openFailure = e;
      } else if (e.outcome === "pass" && openFailure && sameRun(e, openFailure)) {
        emit(openFailure, { passed: e });
        openFailure = null;
      }
    } else if (e.kind === "edit" && openFailure) {
      if (!isTestFile(e.path)) continue;
      if (![openFailure, ...refails].some((f) => failureNamesFile(f.output ?? "", e.path))) continue;
      const known = e.assertionsBefore !== void 0 && e.assertionsAfter !== void 0;
      const w = window.get(e.path) ?? { first: e, last: e, count: 0, viaShell: 0, before: 0, after: 0, unknown: 0 };
      w.last = e;
      w.count += 1;
      w.viaShell += e.via === "shell" ? 1 : 0;
      if (known) {
        w.before += e.assertionsBefore;
        w.after += e.assertionsAfter;
      } else w.unknown += 1;
      window.set(e.path, w);
    }
  }
  if (openFailure) emit(openFailure, {});
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

// src/render/build-log.ts
import { basename as basename6, isAbsolute as isAbsolute5 } from "node:path";

// src/render/relativize.ts
import { basename as basename2, isAbsolute as isAbsolute3, relative, resolve as resolve3 } from "node:path";
function insideRepo(path, repoRoot2) {
  if (!isAbsolute3(path)) return true;
  const root = resolve3(repoRoot2);
  return [root, root.replace(/^\/private\//, "/"), `/private${root}`].some((base) => {
    const rel = relative(base, path);
    return rel !== "" && !rel.startsWith("..") && !isAbsolute3(rel);
  });
}
function relativize(path, repoRoot2) {
  if (!path) return path;
  if (!isAbsolute3(path)) return path;
  const root = resolve3(repoRoot2);
  const candidates = [root, root.replace(/^\/private\//, "/"), `/private${root}`];
  for (const base of candidates) {
    const rel = relative(base, path);
    if (rel && !rel.startsWith("..") && !isAbsolute3(rel)) return rel;
  }
  return basename2(path);
}
var PRIVATE_ROOTS = "Users|home|tmp|private|var|Volumes|workspaces|root|mnt|opt|srv";
var PATH_CHARS = String.raw`[^\s` + "`" + String.raw`'"()<>[\]{}|,;]`;
var PRIVATE_PATH = new RegExp(String.raw`(?<![\w.~/-])\/+(?:${PRIVATE_ROOTS})(?:\/${PATH_CHARS}*)?`, "g");
var WINDOWS_USER_PATH = new RegExp(String.raw`(?<![\w.-])[A-Za-z]:[\\/]Users(?:[\\/]${PATH_CHARS}*)?`, "g");
var QUOTED_PRIVATE_PATH = new RegExp(String.raw`(["'` + "`" + String.raw`])((?:\/+(?:${PRIVATE_ROOTS})|[A-Za-z]:[\\/]Users)(?:[\\/][^"'` + "`" + String.raw`\n]*)?)\1`, "g");
var FILE_SCHEME = /\bfile:\/\/(?=\/|[A-Za-z]:)/gi;
var nameOf = (path) => path.split(/[\\/]/).filter(Boolean).pop() ?? path;
function reduce(match) {
  const trail = /[.:]+$/.exec(match)?.[0] ?? "";
  return nameOf(match.slice(0, match.length - trail.length)) + trail;
}
var escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
function scrubPaths(text, repoRoot2) {
  let out = text.replace(FILE_SCHEME, "");
  if (repoRoot2) {
    const root = resolve3(repoRoot2);
    const forms = [.../* @__PURE__ */ new Set([`/private${root}`, root, root.replace(/^\/private\//, "/")])].sort((a, b) => b.length - a.length);
    for (const form of forms) out = out.replace(new RegExp(`(?<![\\w.~/-])${escape(form)}/`, "g"), "");
  }
  return out.replace(QUOTED_PRIVATE_PATH, (_m, quote2, path) => `${quote2}${nameOf(path)}${quote2}`).replace(WINDOWS_USER_PATH, reduce).replace(PRIVATE_PATH, reduce);
}

// src/events/expand-writes.ts
import { dirname as dirname2, isAbsolute as isAbsolute4 } from "node:path";
function expandWrites(events) {
  return events.flatMap((e) => {
    if (e.kind !== "command" || !e.writes?.length) return [e];
    const edits = e.writes.map((w, i) => ({
      kind: "edit",
      id: `${e.id}#write${i}`,
      at: e.at,
      path: w.path,
      via: "shell",
      ...isAbsolute4(w.path) ? { dir: dirname2(w.path) } : {},
      ...w.append ? { additive: true } : {},
      ...w.assertionsBefore !== void 0 ? { assertionsBefore: w.assertionsBefore } : {},
      ...w.assertionsAfter !== void 0 ? { assertionsAfter: w.assertionsAfter } : {}
    }));
    return [...edits, e];
  });
}

// src/review/checks.ts
var PACKAGE_MANAGERS = /* @__PURE__ */ new Set(["npm", "pnpm", "yarn", "bun"]);
var OPTION_WITH_VALUE = /* @__PURE__ */ new Set(["--filter", "-F", "--dir", "-C", "--prefix", "--workspace", "--cwd"]);
var TASK_RUNNERS = /* @__PURE__ */ new Set(["just", "make", "task"]);
var SUBCOMMAND_TOOLS = /* @__PURE__ */ new Set(["go", "cargo", "swift", "dotnet", "playwright"]);
function takesValue(word, packageManager) {
  if (OPTION_WITH_VALUE.has(word)) return true;
  if (word === "-w" && packageManager === "npm") return true;
  return false;
}
function toolOf(fragment2) {
  let words = withoutWrapper(fragment2).split(/\s+/).filter(Boolean);
  let first = words[0] ?? "";
  if (first === "docker-compose") {
    first = "docker";
    words = ["docker", "compose", ...words.slice(1)];
  }
  if (first === "yarn" && words[1] === "workspace" && words[2]) {
    for (let i = 3; i < words.length; i++) {
      const w = words[i];
      if (takesValue(w, "yarn")) {
        i++;
        continue;
      }
      if (w.startsWith("-") || w === "run") continue;
      return `yarn ${w}`;
    }
    return "yarn";
  }
  if (PACKAGE_MANAGERS.has(first)) {
    for (let i = 1; i < words.length; i++) {
      const w = words[i];
      if (takesValue(w, first)) {
        i++;
        continue;
      }
      if (w.startsWith("-") || w === "run") continue;
      return `${first} ${w}`;
    }
    return first;
  }
  if (TASK_RUNNERS.has(first)) return words[1] && !words[1].startsWith("-") ? `${first} ${words[1]}` : first;
  if (first === "node" && words[1] === "--test") return "node --test";
  if (first === "cargo" && words[1]?.startsWith("+")) {
    for (let i = 2; i < words.length; i++) {
      const w = words[i];
      if (takesValue(w, "cargo")) {
        i++;
        continue;
      }
      if (w.startsWith("-") || w === "run") continue;
      return `cargo ${w}`;
    }
    return "cargo";
  }
  if (first === "docker") {
    const optionsWithValue = /* @__PURE__ */ new Set(["-f", "--file", "-p", "--project-name"]);
    const filtered = [];
    for (let i = 1; i < words.length; i++) {
      const w = words[i];
      if (optionsWithValue.has(w)) {
        i++;
        continue;
      }
      if (w.startsWith("-")) continue;
      filtered.push(w);
    }
    return ["docker", ...filtered.slice(0, filtered[0] === "build" ? 1 : 2)].join(" ");
  }
  if (SUBCOMMAND_TOOLS.has(first) && words[1] && !words[1].startsWith("-")) return `${first} ${words[1]}`;
  return first;
}
function isFixer(fragment2) {
  const words = fragment2.split(/\s+/);
  if (words.includes("--check") || words.includes("--diff")) return false;
  if (words.some((w) => w === "--write" || w === "--fix" || w.startsWith("--fix="))) return true;
  const tool = toolOf(fragment2);
  if (words.includes("-w") && tool === "gofmt") return true;
  if (tool === "cargo fmt" || tool === "black" || tool === "rustfmt" || tool === "swiftformat" || tool === "gofmt") return true;
  if (tool === "ruff" && withoutWrapper(fragment2).startsWith("ruff format")) return true;
  return false;
}
function summariseChecks(events) {
  const byCommand = /* @__PURE__ */ new Map();
  for (const e of events) {
    if (e.kind !== "command") continue;
    const kind = classifyCommand(e.command);
    if (kind !== "test" && kind !== "build" && kind !== "lint") continue;
    const command2 = runnerFragment(e.command);
    if (!command2) continue;
    const failed = e.outcome === "fail" ? 1 : 0;
    const seen = byCommand.get(command2);
    if (seen) {
      seen.runs += 1;
      seen.failures += failed;
      seen.last = e.outcome;
      seen.lastAt = e.at;
    } else {
      byCommand.set(command2, {
        command: command2,
        kind,
        tool: toolOf(command2),
        runs: 1,
        failures: failed,
        last: e.outcome,
        lastAt: e.at,
        fixer: isFixer(command2)
      });
    }
  }
  return [...byCommand.values()];
}
var RANK = { pass: 0, unknown: 1, interrupted: 2, fail: 3 };
function toolStatuses(checks) {
  const out = [];
  for (const c of checks) {
    if (c.fixer) continue;
    const t = out.find((x) => x.tool === c.tool);
    if (!t) out.push({ tool: c.tool, status: c.last });
    else if (RANK[c.last] > RANK[t.status]) t.status = c.last;
  }
  return out;
}

// src/review/risky.ts
import { basename as basename3 } from "node:path";
var LOCKFILES = /* @__PURE__ */ new Set([
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "bun.lockb",
  "uv.lock",
  "poetry.lock",
  "Pipfile.lock",
  "Cargo.lock",
  "go.sum",
  "Gemfile.lock",
  "Package.resolved"
]);
var isLockfile = (path) => LOCKFILES.has(basename3(path));
var isMigration = (path) => /(^|\/)(?:migrations|alembic\/versions|prisma\/migrations|db\/migrate)\//.test(path) && !/\.(?:md|txt|rst|example|sample)$/.test(path);
var AUTH_SEGMENT = /^(?:auth|authn|authz|security|permissions|iam)$/;
var RULES2 = [
  ["CI and automation", (p) => /^\.github\/(?:workflows|actions)\//.test(p) || p === ".gitlab-ci.yml" || p.startsWith(".circleci/")],
  ["Ownership and policy", (p) => /^(?:\.github\/|docs\/)?CODEOWNERS$/.test(p) || /(^|\/)SECURITY\.md$/.test(p)],
  ["Migrations", isMigration],
  ["Dependencies", isLockfile],
  ["Secrets and environment", (p) => /(^|\/)\.env(?:\.|$)/.test(p) && !/\.env\.(?:example|sample|template)$/.test(p) || /\.(?:pem|key)$/.test(p) || /(^|\/)secrets\//.test(p)],
  // A segment, or a file's name without its extension: `auth/`, `auth.py`.
  ["Auth", (p) => p.split("/").some((seg) => AUTH_SEGMENT.test(seg.replace(/\.[^.]+$/, "")))]
];
function riskyFiles(paths2) {
  const groups = [];
  for (const path of paths2) {
    const rule = RULES2.find(([, matches]) => matches(path));
    if (!rule) continue;
    const group = groups.find((g) => g.category === rule[0]);
    if (group) group.paths.push(path);
    else groups.push({ category: rule[0], paths: [path] });
  }
  return RULES2.map(([c]) => groups.find((g) => g.category === c)).filter((g) => g !== void 0);
}

// src/review/never-run.ts
var DOCKER_FILE = /(^|\/)(?:Dockerfile[^/]*|[^/]+\.dockerfile|docker-compose[^/]*\.ya?ml|compose[^/]*\.ya?ml)$/i;
function isDockerFile(path) {
  if (!/\.(?:md|txt|rst|example|sample)$/.test(path) === false) return false;
  if (/composer\.\w+$/.test(path)) return false;
  return DOCKER_FILE.test(path);
}
var NEVER_RUN_RULES = [
  {
    check: "docker build",
    because: "a Docker file changed",
    touches: isDockerFile,
    satisfiedBy: /docker(?:-compose|\s+compose)?(?:\s+-\S+(?:\s+[^\s-]\S*)?)*\s+(?:image\s+|buildx\s+)?build\b|docker(?:-compose|\s+compose)(?:\s+-\S+(?:\s+[^\s-]\S*)?)*\s+up\b.*--build/
  },
  {
    check: "migrations",
    because: "a migration changed",
    touches: isMigration,
    satisfiedBy: /(?:alembic(?:\s+-\S+(?:\s+[^\s-]\S*)?)*\s+)?upgrade\b|(?:python3?\s+)?(?:\.\/)?(?:bin\/)?manage\.py\s+migrate\b|(?:bin\/)?rails\s+db:migrate\b|(?:pnpm\s+)?prisma\s+migrate\b|(?:just|make)\s+migrate\b|docker\s+compose\s+(?:run|exec)(?:\s+-\S+(?:\s+[^\s-]\S*)?)*\s+\S+\s+(?:alembic(?:\s+-\S+(?:\s+[^\s-]\S*)?)*\s+)?upgrade\b|docker\s+compose\s+(?:run|exec)(?:\s+-\S+(?:\s+[^\s-]\S*)?)*\s+\S+\s+(?:python3?\s+)?(?:\.\/)?(?:bin\/)?manage\.py\s+migrate\b|docker\s+compose\s+(?:run|exec)(?:\s+-\S+(?:\s+[^\s-]\S*)?)*\s+\S+\s+(?:bin\/)?rails\s+db:migrate\b/
  }
];
function neverRun(paths2, commands) {
  const segments = commands.flatMap(commandSegments);
  return NEVER_RUN_RULES.filter((r) => paths2.some(r.touches) && !segments.some((s) => runsKind(s, r.satisfiedBy))).map(({ check, because }) => ({ check, because }));
}

// src/review/scope.ts
var CONTAINERS = /* @__PURE__ */ new Set(["apps", "packages", "services", "libs", "crates", "cmd", "internal"]);
var GENERATED = /\.min\.(?:js|css)$|(^|\/)(?:dist|build|vendor)\//;
var MAX_AREAS = 6;
function areaOf(path) {
  const segs = path.split("/");
  if (segs.length === 1) return "(root)";
  if (CONTAINERS.has(segs[0]) && segs.length > 2) return `${segs[0]}/${segs[1]}`;
  return segs[0];
}
function summariseScope(files) {
  const lines = (x) => x.added + x.removed;
  const byArea = /* @__PURE__ */ new Map();
  for (const x of files) byArea.set(areaOf(x.path), (byArea.get(areaOf(x.path)) ?? 0) + lines(x));
  const ranked = [...byArea.entries()].sort((a, b) => b[1] - a[1]).map(([area]) => area);
  const tests = files.filter((x) => isTestFile(x.path));
  return {
    added: files.reduce((n, x) => n + x.added, 0),
    removed: files.reduce((n, x) => n + x.removed, 0),
    files: files.length,
    created: files.filter((x) => x.status === "added").length,
    deleted: files.filter((x) => x.status === "deleted").length,
    renamed: files.filter((x) => x.status === "renamed").length,
    areas: ranked.slice(0, MAX_AREAS),
    moreAreas: Math.max(0, ranked.length - MAX_AREAS),
    testsChanged: tests.length,
    testsAdded: tests.filter((x) => x.status === "added").length,
    largest: files.filter((x) => !x.binary && !isLockfile(x.path) && !GENERATED.test(x.path) && lines(x) > 0).sort((a, b) => lines(b) - lines(a)).slice(0, 2).map((x) => ({ path: x.path, lines: lines(x) }))
  };
}

// src/flags/diff-signals.ts
import { basename as basename4 } from "node:path";
function parse(diff) {
  const files = [];
  let current;
  let inHunk = false;
  for (const line of diff.split("\n")) {
    if (line.startsWith("diff --git ")) {
      current = { path: /^diff --git a\/.+? b\/(.+)$/.exec(line)?.[1] ?? "", deleted: false, added: [], removed: [], context: [] };
      files.push(current);
      inHunk = false;
      continue;
    }
    if (!current) continue;
    if (!inHunk) {
      if (line.startsWith("deleted file mode") || line === "+++ /dev/null") current.deleted = true;
      else if (line.startsWith("new file mode") || line === "--- /dev/null") current.created = true;
      else if (line.startsWith("rename to ")) {
        current.path = line.slice(10);
        current.renamed = true;
      } else if (line.startsWith("--- a/")) current.path = line.slice(6);
      else if (line.startsWith("+++ b/")) current.path = line.slice(6);
      else if (line.startsWith("Binary files ")) current.binary = true;
      else if (line.startsWith("@@")) inHunk = true;
      continue;
    }
    if (line.startsWith("@@")) continue;
    if (line.startsWith("+")) current.added.push(line.slice(1));
    else if (line.startsWith("-")) current.removed.push(line.slice(1));
    else if (line.startsWith(" ")) current.context.push(line.slice(1));
  }
  return files;
}
var escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
function testOrigin(diff, path, testName) {
  const file = parse(diff).find((f) => f.path === path || f.path.endsWith(`/${path}`) || path.endsWith(`/${f.path}`));
  if (!file) return void 0;
  if (file.created) return "added";
  const last = testName.split(/::|›|>/).pop()?.trim() ?? testName;
  if (!last) return "existing";
  const re = new RegExp(`(?<![\\w])${escapeRe(last)}(?![\\w])`);
  const inOld = [...file.context, ...file.removed].some((l) => re.test(l));
  const inNew = file.added.some((l) => re.test(l));
  return inNew && !inOld ? "added" : "existing";
}
var MAX_QUOTE = 100;
var quote = (line) => {
  const t = line.trim();
  return t.length > MAX_QUOTE ? `${t.slice(0, MAX_QUOTE - 1)}\u2026` : t;
};
function assertionChanges(diff, path) {
  const out = [];
  let inFile = false;
  let inHunk = false;
  let removed = [];
  let added = [];
  const flush = () => {
    const r = removed.filter((l) => countAssertions(l) > 0);
    const a = added.filter((l) => countAssertions(l) > 0);
    r.forEach((line, i) => out.push({ removed: quote(line), ...a[i] !== void 0 ? { added: quote(a[i]) } : {} }));
    removed = [];
    added = [];
  };
  const matches = (p) => p === path || p.endsWith(`/${path}`) || path.endsWith(`/${p}`);
  for (const line of diff.split("\n")) {
    if (line.startsWith("diff --git ")) {
      flush();
      inFile = matches(/^diff --git a\/.+? b\/(.+)$/.exec(line)?.[1] ?? "");
      inHunk = false;
      continue;
    }
    if (!inFile) continue;
    if (line.startsWith("@@")) {
      flush();
      inHunk = true;
      continue;
    }
    if (!inHunk) continue;
    if (line.startsWith("-")) {
      if (added.length > 0) flush();
      removed.push(line.slice(1));
    } else if (line.startsWith("+")) added.push(line.slice(1));
    else flush();
  }
  flush();
  return out;
}
function changedFiles(diff) {
  return parse(diff).filter((f) => f.path).map((f) => ({
    path: f.path,
    status: f.deleted ? "deleted" : f.created ? "added" : f.renamed ? "renamed" : "modified",
    added: f.added.length,
    removed: f.removed.length,
    binary: f.binary === true
  }));
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
  return basename4(path).replace(/\.(?:test|spec)\.[cm]?[tj]sx?$/, "").replace(/^test_(.+)\.py$/, "$1").replace(/_test\.(?:go|py|rb)$/, "").replace(/Tests?\.(?:swift|java)$/, "");
}
var moduleName = (path) => basename4(path).replace(/\.[^.]+$/, "");
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

// src/review/coverage.ts
import { basename as basename5 } from "node:path";
var CODE = /\.(?:[cm]?[tj]sx?|py|go|rs|swift|java|kt|rb|php|cs|c|cc|cpp|h|hpp|m|scala|vue|svelte)$/;
var NOT_UNIT = /(?:^|\/)__init__\.py$|\.d\.ts$/;
var isSourceCode = (path) => !isTestFile(path) && CODE.test(path) && !NOT_UNIT.test(path);
var sourceStem = (path) => basename5(path).replace(/\.[^.]+$/, "");
function language(path) {
  const ext = /\.([^.]+)$/.exec(path)?.[1] ?? "";
  if (/^[cm]?[tj]sx?$|^vue$|^svelte$/.test(ext)) return "js";
  if (/^(?:c|cc|cpp|h|hpp|m)$/.test(ext)) return "c";
  return ext;
}
function pointsAt(test, source) {
  if (language(test) !== language(source)) return false;
  const t = stemOf(test).toLowerCase();
  const s = sourceStem(source).toLowerCase();
  return t === s || t.endsWith(`_${s}`) || t.endsWith(`-${s}`);
}
function pairTests(files) {
  const present = files.filter((f) => f.status !== "deleted");
  const tests = present.filter((f) => isTestFile(f.path)).map((f) => f.path);
  const sources = present.filter((f) => isSourceCode(f.path)).map((f) => f.path);
  const pairs = [];
  const untested = [];
  for (const source of sources) {
    const matched = tests.filter((t) => pointsAt(t, source));
    if (matched.length > 0) pairs.push({ source, tests: matched });
    else untested.push(source);
  }
  return { pairs, untested };
}

// src/render/build-log.ts
function buildLog(recorded, meta, decisions = []) {
  const events = expandWrites(recorded);
  const rules = /* @__PURE__ */ new Set();
  const clean = (s) => {
    const { text, hits } = redact(s, meta.extraRedactions);
    for (const h of hits) rules.add(h);
    return text;
  };
  const fromDiff = meta.diff ? changedFiles(meta.diff) : [];
  const diffPaths = fromDiff.map((f) => f.path).sort((a, b) => b.length - a.length);
  const rel = (p) => {
    if (meta.repoRoot) return relativize(p, meta.repoRoot);
    if (!isAbsolute5(p)) return p;
    return diffPaths.find((d) => p.endsWith(`/${d}`)) ?? basename6(p);
  };
  const verification = [];
  let otherCommands = 0;
  const edits = /* @__PURE__ */ new Map();
  const viaShellOnly = /* @__PURE__ */ new Set();
  for (const e of events) {
    if (e.kind === "command") {
      const kind = classifyCommand(e.command);
      if (kind !== "test" && kind !== "build" && kind !== "lint") {
        otherCommands += 1;
        continue;
      }
      verification.push({
        at: e.at,
        kind,
        command: clean(summariseCommand(e.command)),
        outcome: e.outcome,
        ...e.exitCode !== void 0 ? { exitCode: e.exitCode } : {},
        ...e.durationMs !== void 0 ? { durationMs: e.durationMs } : {}
      });
    } else {
      if (meta.repoRoot && !insideRepo(e.path, meta.repoRoot)) continue;
      const file = rel(e.path);
      if (e.via === "shell" && !edits.has(file)) viaShellOnly.add(file);
      if (e.via !== "shell") viaShellOnly.delete(file);
      edits.set(file, (edits.get(file) ?? 0) + 1);
    }
  }
  const role = (file) => isTestFile(file) ? "test" : "source";
  const changes = fromDiff.length > 0 ? [
    ...fromDiff.map((f) => ({ file: f.path, edits: edits.get(f.path) ?? 0, role: role(f.path), status: f.status })),
    // A file only ever written from the shell and absent from the diff is
    // a log, a scratch file or build output, not part of the change.
    ...[...edits].filter(([file]) => !fromDiff.some((f) => f.path === file) && !viaShellOnly.has(file)).map(([file, n]) => ({ file, edits: n, role: role(file), status: "not in diff" }))
  ] : [...edits].map(([file, n]) => ({ file, edits: n, role: role(file) }));
  const testRuns = events.filter((e) => e.kind === "command" && classifyCommand(e.command) === "test");
  const lastTest = testRuns[testRuns.length - 1];
  const after = lastTest ? events.filter((e) => e.kind === "edit" && e.at > lastTest.at && (!meta.repoRoot || insideRepo(e.path, meta.repoRoot)) && isSourceCode(rel(e.path))) : [];
  const changedAfterTests = lastTest && after.length > 0 ? { files: [...new Set(after.map((e) => rel(e.path)))], lastTestAt: lastTest.at, lastEditAt: after.map((e) => e.at).sort().at(-1) } : void 0;
  const committing = events.filter((e) => e.kind === "command" && /(?:^|[\s;&|(])(?:git\s+(?:-C\s+\S+\s+)?(?:commit|merge|rebase|cherry-pick|am|revert|pull)|gh\s+pr\s+merge)\b/.test(scriptSkeleton(e.command)));
  const covered = (at) => committing.some((e) => {
    const t = Date.parse(at);
    const end = Date.parse(e.at);
    const start = end - (e.kind === "command" ? e.durationMs ?? 0 : 0) - 12e4;
    return t >= start && t <= end + 6e4;
  });
  const outsideCommits = events.length > 0 && meta.commits ? meta.commits.filter((c) => !covered(c.at)) : [];
  const checks = summariseChecks(events).map((c) => ({ ...c, command: clean(c.command), tool: clean(c.tool) }));
  const present = fromDiff.filter((f) => f.status !== "deleted").map((f) => f.path);
  const commandTexts = events.flatMap((e) => e.kind === "command" ? [e.command] : []);
  const missing = fromDiff.length > 0 ? neverRun(present, commandTexts) : [];
  const risky = riskyFiles(fromDiff.map((f) => f.path));
  const scope = fromDiff.length > 0 ? summariseScope(fromDiff) : void 0;
  const unlisted = [...edits.keys()].filter((file) => !fromDiff.some((f) => f.path === file));
  const strayWrites = fromDiff.length > 0 && meta.repoRoot ? meta.notIgnored ? meta.notIgnored(unlisted) : unlisted : [];
  const timeline = meta.flagEditAfterFailure === false ? [] : detectTestEditedAfterFailure(events);
  const flags = timeline.map((f) => {
    const file = rel(f.file);
    const named = meta.diff ? (f.tests?.length ? f.tests : [""]).map((name) => ({ name, origin: testOrigin(meta.diff, file, name) })) : [];
    const known = named.filter((n) => n.origin !== void 0);
    const kinds = new Set(known.map((n) => n.origin));
    const origin = known.length === 0 ? void 0 : kinds.size === 2 ? "mixed" : known[0].origin;
    return {
      ...f,
      file,
      detail: clean(scrubPaths(f.file ? f.detail.replaceAll(f.file, file) : f.detail, meta.repoRoot)),
      ...f.tests ? { tests: f.tests.map((t) => clean(scrubPaths(t, meta.repoRoot))) } : {},
      ...origin ? { origin } : {},
      ...(() => {
        const changes2 = meta.diff && f.code === "TEST_EDITED_AFTER_FAILURE" ? assertionChanges(meta.diff, file) : [];
        const safe = (t) => clean(scrubPaths(t, meta.repoRoot));
        return changes2.length > 0 ? { assertionDiff: changes2.map((c) => ({ removed: safe(c.removed), ...c.added !== void 0 ? { added: safe(c.added) } : {} })) } : {};
      })(),
      ...origin === "mixed" ? { testOrigins: known.map((n) => ({ ...n, name: clean(scrubPaths(n.name, meta.repoRoot)) })) } : {}
    };
  });
  const ranATest = verification.some((v) => v.kind === "test");
  if (changes.length > 0 && !ranATest) {
    flags.push({
      code: "NO_TEST_RUN",
      severity: "warn",
      file: "",
      detail: `${changes.length} ${changes.length === 1 ? "file" : "files"} changed and no test command was recorded in this session.`,
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
    otherCommands,
    changes,
    flags,
    checks,
    neverRun: missing,
    risky,
    ...scope ? { scope } : {},
    strayWrites,
    ...fromDiff.length > 0 ? { coverage: pairTests(fromDiff) } : {},
    ...changedAfterTests ? { changedAfterTests } : {},
    ...outsideCommits.length > 0 ? { outsideCommits } : {},
    // Links go into the PR body, so only a plain github.com pull request URL is kept.
    ...meta.prUrl && /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+$/.test(meta.prUrl) ? { prUrl: meta.prUrl } : {},
    // Model text, so it passes through the same redactor as everything else.
    decisions: decisions.map((d) => ({ ...d, text: clean(scrubPaths(d.text, meta.repoRoot)) })),
    redaction: { hits: rules.size, rules: [...rules] }
  };
}

// src/render/render.ts
import { createHash as createHash2 } from "node:crypto";
var MARKER_START = "<!-- pdl:start";
var MARKER_END = "<!-- pdl:end -->";
var VISIBLE_ITEMS = 3;
var LISTED_PATHS = 3;
var LISTED_STRAY = 10;
var SCOPE = "Scope";
var CONFIRMED = "Decisions you confirmed";
var LOOK = "Look here";
var LABEL = {
  TEST_EDITED_AFTER_FAILURE: "Test changed after it failed",
  NO_TEST_RUN: "No test was run",
  TEST_ONLY_CHANGE: "Only tests changed",
  ASSERTIONS_REMOVED: "Assertions removed",
  TEST_SKIPPED: "Test skipped",
  TEST_DELETED: "Tests deleted",
  EXPECTATION_LOOSENED: "Expected value changed"
};
var WARNING_ORDER = [
  "TEST_EDITED_AFTER_FAILURE",
  "TEST_SKIPPED",
  "ASSERTIONS_REMOVED",
  "TEST_DELETED",
  "EXPECTATION_LOOSENED",
  "TEST_ONLY_CHANGE",
  "NO_TEST_RUN"
];
var MARK = { pass: "\u2713", fail: "\u2717 (failed, not re-run)", interrupted: "\u2717 (interrupted)", unknown: "?" };
var code = (s) => s.includes("`") ? `\`\`${s}\`\`` : `\`${s}\``;
var cell = (s) => s.replace(/\|/g, "\\|");
var hhmm2 = (iso) => /T(\d{2}:\d{2})/.exec(iso)?.[1] ?? iso;
var count2 = (n, one, many = `${one}s`) => `${num(n)} ${n === 1 ? one : many}`;
var num = (n) => n.toLocaleString("en-US");
var paths = (list, max = LISTED_PATHS) => list.slice(0, max).map(code).join(", ") + (list.length > max ? ` +${list.length - max} more` : "");
var category = (name) => name.toLowerCase().replace(/\bci\b/, "CI");
function fileRef(log, path) {
  if (!log.prUrl) return code(path);
  return `[${code(path)}](${log.prUrl}/files#diff-${createHash2("sha256").update(path).digest("hex")})`;
}
var fileRefs = (log, list, max = LISTED_PATHS) => list.slice(0, max).map((p) => fileRef(log, p)).join(", ") + (list.length > max ? ` +${list.length - max} more` : "");
var ORIGIN = { added: " *(a test this PR added)*", existing: " *(an existing test)*" };
function mixedOrigin(f) {
  const of = (o) => (f.testOrigins ?? []).filter((t) => t.origin === o).map((t) => t.name);
  const list = (names) => names.slice(0, 2).map(code).join(", ") + (names.length > 2 ? ` +${names.length - 2} more` : "");
  return ` *(${list(of("added"))} added by this PR; ${list(of("existing"))} existed)*`;
}
function flagLine(log, f, note = false) {
  const where = f.file ? ` ${fileRef(log, f.file)}` : "";
  const origin = f.origin === "mixed" ? mixedOrigin(f) : f.origin ? ORIGIN[f.origin] ?? "" : "";
  const changes = f.assertionDiff ?? [];
  const diffNote = changes.length === 0 ? "" : ` Diff: ${changes.slice(0, 2).map((c) => c.added !== void 0 ? `${code(c.removed)} \u2192 ${code(c.added)}` : `${code(c.removed)} removed`).join("; ")}${changes.length > 2 ? ` +${changes.length - 2} more` : ""}.`;
  return `- **${LABEL[f.code]}**${origin}${note ? " *(note)*" : ""}${where}: ${f.detail}${diffNote}`;
}
function checksLine(log) {
  const tools = toolStatuses(log.checks);
  if (tools.length === 0) return "**Checks:** none were run.";
  return `**Checks (last run):** ${tools.map((t) => `${t.tool} ${MARK[t.status]}`).join(" \xB7 ")}`;
}
function contextLine(log) {
  const parts = [];
  const never = log.neverRun.map((x) => `${x.check} (${x.because})`).join(" \xB7 ");
  if (never) parts.push(`**Never run:** ${never}`);
  const stale = log.changedAfterTests;
  if (stale) {
    const later = gap2(stale.lastTestAt, stale.lastEditAt);
    parts.push(`**Changed after the last test run:** ${paths(stale.files)}${later ? ` (${later} later)` : ""}`);
  }
  const outside = log.outsideCommits ?? [];
  if (outside.length > 0) {
    const ref = (c) => log.prUrl ? `[${code(c.sha.slice(0, 7))}](${log.prUrl}/commits/${c.sha})` : code(c.sha.slice(0, 7));
    const list = outside.slice(0, LISTED_PATHS).map(ref).join(", ") + (outside.length > LISTED_PATHS ? ` +${outside.length - LISTED_PATHS} more` : "");
    parts.push(`**Not covered by this log:** ${count2(outside.length, "commit")} made outside the recorded sessions: ${list}`);
  }
  return parts.join(" \xB7 ");
}
function gap2(from, to) {
  const s = Math.round((Date.parse(to) - Date.parse(from)) / 1e3);
  if (!Number.isFinite(s) || s < 0) return "";
  if (s < 60) return `${s} s`;
  if (s < 3600) return `${Math.round(s / 60)} min`;
  return `${Math.round(s / 3600)} h`;
}
function lookHere(log) {
  const warnings = log.flags.filter((f) => f.severity === "warn");
  const items = WARNING_ORDER.flatMap((c) => warnings.filter((f) => f.code === c).map((f) => flagLine(log, f)));
  if (log.risky.length > 0) {
    items.push(`- **Privileged or risky files:** ${log.risky.map((g) => `${category(g.category)}: ${fileRefs(log, g.paths)}`).join(" \xB7 ")}`);
  }
  return items;
}
function scopeLines(log, s) {
  const statuses = [
    s.created ? `${s.created} added` : "",
    s.deleted ? `${s.deleted} deleted` : "",
    s.renamed ? `${s.renamed} renamed` : ""
  ].filter(Boolean);
  const areas = s.areas.join(" \xB7 ") + (s.moreAreas > 0 ? ` +${s.moreAreas} more` : "");
  const first = `+${num(s.added)} \u2212${num(s.removed)} lines \xB7 ${count2(s.files, "file")}` + (statuses.length ? ` (${statuses.join(", ")})` : "") + (areas ? ` \xB7 ${areas}` : "");
  const second = [
    s.testsChanged > 0 ? `Tests: ${count2(s.testsChanged, "file")} changed${s.testsAdded ? ` (${s.testsAdded} added)` : ""}` : "",
    log.coverage && log.coverage.untested.length > 0 ? `no matching test change: ${count2(log.coverage.untested.length, "source file")}` : ""
  ].filter(Boolean).join(" \xB7 ");
  return second ? [first, second] : [first];
}
function capped(items, restInDetails) {
  if (items.length <= VISIBLE_ITEMS) return items;
  const rest = items.length - VISIBLE_ITEMS;
  return [...items.slice(0, VISIBLE_ITEMS), restInDetails ? `- *\u2026and ${rest} more in the details below.*` : `- *\u2026and ${rest} more, cut to fit the PR body.*`];
}
var LEVELS = [
  { checks: true, extras: true, moreLook: true, moreConfirmed: true },
  { checks: true, extras: false, moreLook: true, moreConfirmed: true },
  { checks: false, extras: false, moreLook: true, moreConfirmed: true },
  { checks: false, extras: false, moreLook: true, moreConfirmed: false },
  { checks: false, extras: false, moreLook: false, moreConfirmed: false }
];
function details(log, moreLook, moreConfirmed, level) {
  const parts = [];
  const summary = [];
  const failed = log.checks.filter((c) => !c.fixer && c.failures > 0);
  if (failed.length > 0 && level.checks) {
    const rows = failed.map((c) => `| ${cell(code(c.command))} | ${c.runs} | ${c.failures} | ${c.last} | ${hhmm2(c.lastAt)} |`);
    parts.push(`#### Checks that failed

| Check | Runs | Failures | Last result | Last run |
| --- | --- | --- | --- | --- |
${rows.join("\n")}`);
    summary.push(`checks that failed (${failed.length})`);
  }
  if (moreLook.length > 0 && level.moreLook) {
    parts.push(`#### More to look at
${moreLook.join("\n")}`);
    summary.push(`more to look at (${moreLook.length})`);
  }
  if (moreConfirmed.length > 0 && level.moreConfirmed) {
    parts.push(`#### More decisions you confirmed
${moreConfirmed.join("\n")}`);
    summary.push(`more decisions (${moreConfirmed.length})`);
  }
  const notes = log.flags.filter((f) => f.severity === "info");
  if (notes.length > 0 && level.extras) {
    parts.push(`#### Notes
${notes.map((f) => flagLine(log, f, true)).join("\n")}`);
    summary.push(`notes (${notes.length})`);
  }
  const cov = log.coverage;
  if (cov && (cov.pairs.length > 0 || cov.untested.length > 0) && level.extras) {
    const pairs = cov.pairs.map((p) => `- ${code(p.source)} \u2194 ${p.tests.map(code).join(", ")}`);
    const untested = cov.untested.length > 0 ? `Changed with no matching test change: ${paths(cov.untested, LISTED_STRAY)}` : "";
    parts.push(`#### Code and tests${pairs.length ? `
${pairs.join("\n")}` : ""}${untested ? `${pairs.length ? "\n\n" : "\n"}${untested}` : ""}`);
    summary.push("code and tests");
  }
  if (log.strayWrites.length > 0 && level.extras) {
    parts.push(`Written during the session but not in the diff: ${count2(log.strayWrites.length, "file")}: ${paths(log.strayWrites, LISTED_STRAY)}`);
    summary.push(`written but not in the diff (${log.strayWrites.length})`);
  }
  if (parts.length === 0) return "";
  return `
<details><summary>${summary.join(" \xB7 ") || "details"}</summary>

${parts.join("\n\n")}

</details>
`;
}
var listed = (names) => names.length <= 1 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
function cutNote(detailsCut, blocks2) {
  const named = blocks2.length > 0 ? `the ${listed(blocks2)} ${blocks2.length > 1 ? "blocks" : "block"}` : "";
  if (detailsCut === "none" && !named) return "";
  const subject = detailsCut === "some" ? "Some details" : detailsCut === "all" ? named ? `Details and ${named}` : "Details" : named.replace(/^t/, "T");
  const verb = detailsCut === "none" && blocks2.length === 1 ? "was" : "were";
  return `*${subject} ${verb} cut to fit the PR body.*`;
}
function render(log, options = {}) {
  const max = options.maxChars ?? 12e3;
  const tool = options.toolUrl ?? "https://github.com/GcdZ03/pr-decision-log";
  const header = `${MARKER_START} v=1 sha=${log.repo.headSha ?? "unknown"} -->
## Decision log
`;
  const from = log.sessions.length > 1 ? `${log.sessions.length} agent sessions` : "the agent session";
  const footer = `
<sub>Recorded from ${from} on ${code(log.branch)}: observed from tool events, not the model's own account; times are UTC. [What this is](${tool})</sub>
${MARKER_END}
`;
  const look = lookHere(log);
  const confirmed = log.decisions.filter((d) => d.confidence === "confirmed_by_human").map((d) => `- ${d.text}`);
  const moreLook = look.slice(VISIBLE_ITEMS);
  const moreConfirmed = confirmed.slice(VISIBLE_ITEMS);
  const anyDetails = details(log, moreLook, moreConfirmed, LEVELS[0]) !== "";
  const body = (level, levelIndex, dropped) => {
    const detailsText = details(log, moreLook, moreConfirmed, level);
    const detailsCut = levelIndex === 0 || !anyDetails ? "none" : detailsText ? "some" : "all";
    const note = cutNote(detailsCut, dropped);
    const second = [contextLine(log), note].filter(Boolean).join(" ");
    const blocks2 = [`
${checksLine(log)}${second ? `
${second}` : ""}
`];
    if (confirmed.length > 0 && !dropped.includes(CONFIRMED)) {
      blocks2.push(`
### Decisions you confirmed
${capped(confirmed, level.moreConfirmed).join("\n")}
`);
    }
    if (look.length > 0 && !dropped.includes(LOOK)) blocks2.push(`
### Look here
${capped(look, level.moreLook).join("\n")}
`);
    if (log.scope && !dropped.includes(SCOPE)) blocks2.push(`
### Scope
${scopeLines(log, log.scope).join("\n")}
`);
    return header + blocks2.join("") + detailsText + footer;
  };
  for (const [i, level] of LEVELS.entries()) {
    const md = body(level, i, []);
    if (md.length <= max) return md;
  }
  const none = LEVELS[LEVELS.length - 1];
  const droppable = [SCOPE, CONFIRMED, LOOK].filter((b) => b === SCOPE && log.scope || b === CONFIRMED && confirmed.length > 0 || b === LOOK && look.length > 0);
  for (let n = 1; n <= droppable.length; n++) {
    const md = body(none, LEVELS.length - 1, droppable.slice(0, n));
    if (md.length <= max) return md;
  }
  const minimal = `${header}
${checksLine(log)}
*The log was cut to fit the PR body.*
${MARKER_END}
`;
  if (minimal.length <= max) return minimal;
  return `${header.slice(0, Math.max(0, max - MARKER_END.length - 1))}
${MARKER_END}
`;
}

// src/publish/publish.ts
import { spawnSync } from "node:child_process";

// src/publish/splice.ts
import { createHash as createHash3 } from "node:crypto";
var BLOCK = /<!-- pdl:start[\s\S]*?<!-- pdl:end -->/;
function sectionHash(section) {
  return createHash3("sha256").update(section).digest("hex").slice(0, 12);
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
var realGh = (args, stdin) => ghIn(void 0)(args, stdin);
var ghIn = (cwd) => (args, stdin) => {
  const proc = spawnSync("gh", args, { input: stdin, encoding: "utf8", ...cwd ? { cwd } : {} });
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
import { dirname as dirname3 } from "node:path";

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
      mkdirSync2(dirname3(this.path), { recursive: true, mode: 448 });
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
      repo: /github\.com\/([^/\s]+\/[^/\s]+)\/pull\//.exec(url)?.[1],
      ...url ? { url } : {}
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
    const sectionFor = (base2, url) => {
      if (built?.base !== base2 || built.url !== url) built = { base: base2, url, section: o.build(base2, url) };
      return built.section;
    };
    if (!o.created && st.pr !== void 0 && st.lastHash !== void 0 && st.mode === mode) {
      if (sectionHash(sectionFor(st.base ?? o.defaultBase, st.url)) === st.lastHash) return { status: "unchanged", body: "" };
    }
    const view = await gh(["pr", "view", "--json", "number,body,baseRefName,url"]);
    const pr = view.ok ? parseView(view.stdout) : null;
    if (!pr) {
      o.state.set(o.key, { noPrUntil: now + NO_PR_TTL_MS });
      return skipped(view.ok ? "could not parse gh pr view output" : view.stderr || "no pull request for the current branch");
    }
    const base = pr.baseRefName ?? st.base ?? o.defaultBase;
    const section = sectionFor(base, pr.url);
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
    o.state.set(o.key, { pr: pr.number, base, mode, ...pr.url ? { url: pr.url } : {}, ...published ? { lastHash: sectionHash(section) } : {} });
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
function notIgnoredIn(cwd, paths2) {
  if (paths2.length === 0) return [];
  const p = spawnSync2("git", ["check-ignore", "--stdin"], { cwd, input: paths2.join("\n"), encoding: "utf8" });
  if (p.status !== 0 && p.status !== 1) return paths2;
  const ignored = new Set((p.stdout ?? "").split("\n").filter(Boolean));
  return paths2.filter((x) => !ignored.has(x));
}
function commitsSince(base, cwd = process.cwd()) {
  for (const ref of [`origin/${base}`, base]) {
    const r = git(["log", "--format=%H%x09%cI", `${ref}..HEAD`], cwd);
    if (!r.ok) continue;
    return r.out.trim().split("\n").filter(Boolean).map((line) => {
      const [sha = "", at = ""] = line.split("	");
      return { sha, at };
    });
  }
  return [];
}

// src/events/branch.ts
var samePlace = (a, b) => a.repo === b.repo && a.branch === b.branch;
function ownerTurn(item, turns) {
  const last = turns[turns.length - 1];
  if (item.at === void 0) return last;
  return turns.find((t) => t.at >= item.at) ?? last;
}
function placeOf(item, turns) {
  const owner = ownerTurn(item, turns);
  if (!owner) return void 0;
  return (item.dir !== void 0 ? owner.places?.[item.dir] : void 0) ?? { repo: owner.repo, branch: owner.branch };
}
function selectForBranch(items, turns, target) {
  return items.filter((item) => {
    const place = placeOf(item, turns);
    return place !== void 0 && samePlace(place, target);
  });
}
function sessionsForBranch(turns, repo, branch) {
  const target = { repo, branch };
  const out = [];
  for (const t of turns) {
    const here = samePlace(t, target) || Object.values(t.places ?? {}).some((p) => samePlace(p, target));
    if (here && !out.includes(t.session)) out.push(t.session);
  }
  return out;
}
function planTurn(events, home, resolve5) {
  const resolved = /* @__PURE__ */ new Map();
  for (const e of events) {
    if (e.dir === void 0 || resolved.has(e.dir)) continue;
    const p = resolve5(e.dir);
    if (p && !samePlace(p, home)) resolved.set(e.dir, p);
  }
  const touched = [];
  for (const e of events) {
    const p = (e.dir !== void 0 ? resolved.get(e.dir) : void 0) ?? home;
    if (!touched.some((t) => samePlace(t, p))) touched.push(p);
  }
  const primary = touched.length === 1 && touched[0] ? touched[0] : home;
  const places = {};
  for (const [dir, p] of resolved) if (!samePlace(p, primary)) places[dir] = p;
  const publishable = (touched.length === 0 ? [home] : touched).filter((p) => p.branch !== "");
  return { primary, places, touched: publishable };
}
function eventsForBranch(store2, repo, branch) {
  const all = store2.turns();
  const sessions2 = sessionsForBranch(all, repo, branch);
  const events = [];
  const transcripts = /* @__PURE__ */ new Map();
  const turnsBySession = /* @__PURE__ */ new Map();
  for (const session of sessions2) {
    const turns = all.filter((t) => t.session === session).sort((a, b) => a.at.localeCompare(b.at));
    turnsBySession.set(session, turns);
    const transcript = [...turns].reverse().find((t) => t.transcript)?.transcript;
    if (transcript) transcripts.set(session, transcript);
    events.push(...selectForBranch(store2.read(session), turns, { repo, branch }));
  }
  events.sort((a, b) => a.at.localeCompare(b.at));
  return { events, sessions: sessions2, transcripts, turnsBySession };
}
function summariseSessions(infos, turns, repo) {
  return infos.map((i) => {
    const own = turns.filter((t) => t.session === i.id);
    const places = own.flatMap((t) => [t, ...Object.values(t.places ?? {})]);
    const branches = [];
    for (const p of places) if (p.branch && !branches.includes(p.branch)) branches.push(p.branch);
    const repos = new Set(places.map((p) => p.repo));
    return { id: i.id, repo: own[own.length - 1]?.repo, repos, branches, lastActivityMs: i.mtimeMs, events: i.events };
  }).filter((s) => repo === void 0 || s.repos.has(repo)).map(({ repos: _repos, ...s }) => s).sort((a, b) => b.lastActivityMs - a.lastActivityMs);
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
function userPrompts(entries) {
  const out = [];
  for (const e of entries) {
    if (e.type !== "user" || e.isMeta || e.isSidechain) continue;
    const c = e.message?.content;
    const text = typeof c === "string" ? c : Array.isArray(c) && c.every((b) => b.type === "text") ? c.map((b) => b.text ?? "").join("\n") : "";
    if (!text.trim() || text.trimStart().startsWith("<")) continue;
    out.push({ ...e.timestamp ? { at: e.timestamp } : {}, text });
  }
  return out;
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
var withoutHint = (label) => label.replace(/\s*\(Recommended\)\s*$/i, "").trim();
function isOfferedAnswer(answer, labels) {
  if (labels.length === 0) return false;
  const fits = (rest) => labels.some((l) => rest === l || rest.startsWith(`${l}, `) && fits(rest.slice(l.length + 2)));
  return fits(answer);
}
function questionsOf(input) {
  const qs = input["questions"];
  if (!Array.isArray(qs)) return [];
  return qs.filter((q) => typeof q === "object" && q !== null).map((q) => ({
    question: typeof q["question"] === "string" ? q["question"] : "",
    header: typeof q["header"] === "string" ? q["header"] : void 0,
    labels: (Array.isArray(q["options"]) ? q["options"] : []).map((o) => typeof o === "object" && o !== null ? o["label"] : void 0).filter((l) => typeof l === "string").map(withoutHint)
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
        const shown = isOfferedAnswer(answer, q.labels) ? answer : "answered in the session";
        decisions.push({
          text: `${q.header ?? q.question}: ${shown}`,
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
import { homedir as homedir4 } from "node:os";
var DEFAULT_ROOT = join2(homedir4(), ".claude", "projects");
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
import { dirname as dirname4, join as join3, resolve as resolve4 } from "node:path";
import { homedir as homedir5 } from "node:os";
import { spawnSync as spawnSync3 } from "node:child_process";
function settingsPathFor(scope, repoRoot2) {
  return scope === "user" ? join3(homedir5(), ".claude", "settings.json") : join3(repoRoot2, ".claude", "settings.json");
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
  mkdirSync3(dirname4(path), { recursive: true });
  writeFileSync3(path, `${JSON.stringify(settings, null, 2)}
`);
}
function hookCommand(entry = process.argv[1] ?? "pdl", scope = "project", root = repoRoot()) {
  const abs = resolve4(entry);
  const prefix = `${resolve4(root)}/`;
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
function trustState(root, statePath = join3(homedir5(), ".claude.json")) {
  let projects;
  try {
    projects = JSON.parse(readFileSync4(statePath, "utf8")).projects;
  } catch {
    return "unreadable";
  }
  if (typeof projects !== "object" || projects === null) return "unknown-folder";
  const entry = projects[resolve4(root)];
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
    return resolve4(p);
  }
};
function pluginHooks(root, installedPath = join3(homedir5(), ".claude", "plugins", "installed_plugins.json"), userSettingsPath = join3(homedir5(), ".claude", "settings.json")) {
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
import { homedir as homedir6 } from "node:os";
var DEFAULT_CONFIG = {
  publish: { mode: "body", max_chars: 12e3, on_pr_create: true },
  extract: { decision_markers: [] },
  tests: { flag_edit_after_failure: true },
  redaction: { extra_patterns: [] },
  store: { dir: join4(homedir6(), ".local", "share", "pdl"), retention_days: 30 },
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
  return p.startsWith("~/") ? join4(homedir6(), p.slice(2)) : p;
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
function loadConfig(repoRoot2, userDir = join4(homedir6(), ".config", "pdl")) {
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
function git2(args, cwd) {
  const p = spawnSync4("git", args, { encoding: "utf8", ...cwd ? { cwd } : {} });
  return p.status === 0 ? (p.stdout ?? "").trim() : "";
}
function currentBranch(cwd) {
  return git2(["symbolic-ref", "--short", "-q", "HEAD"], cwd);
}
function placeIn(dir) {
  const repo = git2(["rev-parse", "--show-toplevel"], dir);
  return repo ? { repo, branch: currentBranch(dir) } : void 0;
}
function placeResolver() {
  const found = [];
  return (dir) => {
    const known = found.find((p2) => dir === p2.repo || dir.startsWith(`${p2.repo}/`));
    if (known) return known;
    const p = placeIn(dir);
    if (p) found.push(p);
    return p;
  };
}
function logMeta(place, base, prUrl) {
  return {
    ...prUrl ? { prUrl } : {},
    repo: git2(["remote", "get-url", "origin"], place.repo) || "unknown",
    branch: place.branch || "detached",
    headSha: git2(["rev-parse", "--short", "HEAD"], place.repo),
    repoRoot: place.repo,
    diff: diffAgainst(base, place.repo),
    commits: commitsSince(base, place.repo),
    flagEditAfterFailure: config.tests.flag_edit_after_failure,
    extraRedactions: compileExtraPatterns(config.redaction.extra_patterns),
    notIgnored: (paths2) => notIgnoredIn(place.repo, paths2)
  };
}
function decisionsIn(transcript) {
  return transcript ? extractDecisions(readTranscript(transcript), { extraMarkers: config.extract.decision_markers }) : [];
}
function renderSession(store2, sessionId) {
  const log = buildLog(store2.read(sessionId), logMeta({ repo: repoRoot(), branch: currentBranch() }, defaultBase()), decisionsIn(findTranscript(sessionId)));
  return render(log, { maxChars: config.publish.max_chars });
}
function renderBranch(store2, place, base, prUrl) {
  const merged = eventsForBranch(store2, place.repo, place.branch);
  const seen = /* @__PURE__ */ new Set();
  const decisions = merged.sessions.flatMap(
    (session) => selectForBranch(
      decisionsIn(merged.transcripts.get(session) ?? findTranscript(session)),
      merged.turnsBySession.get(session) ?? [],
      place
    )
  ).filter((d) => {
    const key = `${d.kind}|${d.text}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const log = buildLog(merged.events, { ...logMeta(place, base, prUrl), sessions: merged.sessions }, decisions);
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
  process.stdout.write(renderBranch(store2, { repo: repoRoot(), branch }, defaultBase()));
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
  return new Promise((resolve5) => {
    let buf = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (c) => {
      buf += c;
    });
    process.stdin.on("end", () => resolve5(buf));
    process.stdin.on("error", () => resolve5(""));
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
    const home = { repo: repoRoot(), branch: currentBranch() };
    const turns = store2.turns().filter((t) => t.session === sessionId);
    const since = turns[turns.length - 1]?.at ?? "";
    const plan = planTurn(store2.read(sessionId).filter((e) => e.at > since), home, placeResolver());
    const transcript = typeof payload["transcript_path"] === "string" ? payload["transcript_path"] : void 0;
    const turn = {
      session: sessionId,
      ...plan.primary,
      at: (/* @__PURE__ */ new Date()).toISOString(),
      ...transcript ? { transcript } : {},
      ...Object.keys(plan.places).length > 0 ? { places: plan.places } : {}
    };
    store2.appendTurn(turn);
    if (stopped) store2.pruneIfDue(config.store.retention_days, Date.now());
    const createdAt = created && event ? placeOf(event, [turn]) : void 0;
    const targets = createdAt ? [createdAt].filter((p) => p.branch !== "") : plan.touched;
    for (const place of targets) {
      await autoPublish({
        key: `${place.repo}#${place.branch}`,
        created,
        mode: config.publish.mode,
        defaultBase: defaultBase(place.repo),
        state: publishState,
        gh: ghIn(place.repo),
        build: (base, url) => renderBranch(store2, place, base, url)
      });
    }
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
function printTimeline(label, recorded) {
  const events = expandWrites(recorded);
  const commands = events.filter((e) => e.kind === "command");
  const edits = events.filter((e) => e.kind === "edit");
  const flags = detectTestEditedAfterFailure(events);
  process.stdout.write(`${label}
`);
  process.stdout.write(`  ${events.length} events: ${commands.length} commands, ${edits.length} edits
`);
  for (const c of commands) {
    if (c.kind !== "command") continue;
    process.stdout.write(`  [${classifyCommand(c.command)}] ${c.outcome.padEnd(11)} ${c.command.split("\n")[0]?.slice(0, 60)}
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
function printPrompts(transcripts) {
  const prompts = transcripts.flatMap((t) => t ? userPrompts(readTranscript(t)) : []);
  if (prompts.length === 0) return;
  process.stdout.write("\n  Prompts (local only, never published):\n");
  for (const p of prompts) {
    const first = p.text.split("\n")[0]?.slice(0, 120) ?? "";
    process.stdout.write(`  ${p.at ? /T(\d{2}:\d{2})/.exec(p.at)?.[1] ?? "" : "     "}  ${first}
`);
  }
}
function show(store2, sessionId) {
  if (sessionId) {
    printTimeline(`session ${sessionId}`, store2.read(sessionId));
    printPrompts([findTranscript(sessionId)]);
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
  printPrompts(merged.sessions.map((s) => merged.transcripts.get(s) ?? findTranscript(s)));
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
var USAGE = `usage: pdl <command>

  doctor                   check the install, with a remedy for each problem
  init [--user]            register hooks in this repo's .claude/settings.json, or ~/.claude/settings.json
  remove [--user]          take pdl's hooks back out of that settings file
  sessions [--all]         list recorded sessions for this repository, newest first
  show [session]           print the recorded timeline and flags: the branch's, or one session's
  build [session]          print the log without publishing: the branch's, or one session's
  publish <session> <pr> [--dry-run]
                           publish one session's log to a pull request by hand
  purge                    delete every recorded session
  redact-check [file]      run text through the redactor and report what matched
  hook                     record one hook payload from stdin (run by Claude Code)
`;
var COMMANDS = ["doctor", "init", "remove", "sessions", "show", "build", "publish", "purge", "redact-check", "hook"];
var FLAGS = { init: ["--user"], remove: ["--user"], sessions: ["--all"], publish: ["--dry-run"] };
function preflight() {
  const args = process.argv.slice(3);
  const help = (a) => a === "--help" || a === "-h";
  if (command === "help" || help(command) || command !== void 0 && COMMANDS.includes(command) && args.some(help)) {
    process.stdout.write(USAGE);
    return false;
  }
  if (command === void 0 || !COMMANDS.includes(command)) return true;
  const unknown = args.find((a) => a.startsWith("-") && !(FLAGS[command] ?? []).includes(a));
  if (unknown) {
    process.stderr.write(`pdl ${command}: unknown option ${unknown}

${USAGE}`);
    process.exitCode = 2;
    return false;
  }
  return true;
}
if (preflight()) switch (command) {
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
    process.stderr.write(USAGE);
    process.exitCode = 2;
}
