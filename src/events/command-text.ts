/** `<<EOF`, `<<'EOF'`, `<<"EOF"`, `<<-EOF`: the delimiter that ends a heredoc body. Not `<<<`, a here-string. */
const HEREDOC_RE = /(?<!<)<<(-?)\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\2/g;

/**
 * The command with heredoc bodies taken out, and the bodies, in the order
 * their `<<` operators appear. The `<<` lines themselves are kept.
 */
export function splitHeredocs(command: string): { text: string; bodies: string[] } {
  const out: string[] = [];
  const bodies: string[] = [];
  const pending: { delimiter: string; tabs: boolean; lines: string[] }[] = [];

  for (const line of command.split('\n')) {
    const open = pending[0];
    if (open) {
      if ((open.tabs ? line.replace(/^\t+/, '') : line) === open.delimiter) {
        bodies.push(open.lines.join('\n'));
        pending.shift();
      } else open.lines.push(line);
      continue;
    }
    out.push(line);
    for (const m of line.matchAll(HEREDOC_RE)) pending.push({ delimiter: m[3] ?? '', tabs: m[1] === '-', lines: [] });
  }
  // An unterminated heredoc runs to the end of the script, as in the shell.
  for (const open of pending) bodies.push(open.lines.join('\n'));
  return { text: out.join('\n'), bodies };
}

function stripHeredocs(command: string): string {
  return splitHeredocs(command).text;
}

/**
 * Empty every quoted string, keeping the quotes. A quoted argument can span
 * lines (`gh pr create --body "..."`), and its lines would otherwise be read
 * as commands; it can also hold a `|` or `;` that is not a separator.
 */
function blankQuotes(text: string): string {
  let out = '';
  let quote: string | undefined;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quote) {
      if (c === '\\' && quote === '"') { i++; continue; }
      if (c === quote) { quote = undefined; out += c; }
      continue;
    }
    if (c === '\\') { out += c + (text[i + 1] ?? ''); i++; continue; }
    if (c === '"' || c === "'") quote = c;
    out += c;
  }
  return out;
}

/**
 * The shell that actually runs, with heredoc bodies and quoted strings
 * emptied out.
 *
 * Agents write files with `cat > f <<'EOF'` and pass PR bodies as quoted
 * multi-line arguments, so the text of a command is often mostly file
 * contents. Reading those as commands misclassified a script that wrote a
 * Dockerfile as a test run, and once published a test file's import line as
 * the command that ran. Everything that inspects a command's text for what it
 * runs reads this instead.
 */
export function scriptSkeleton(command: string): string {
  return blankQuotes(stripHeredocs(command));
}

/** Lines that merely mention a runner (comments, banner echoes) are not invocations. */
const NOT_INVOCATION = /^\s*(#|echo\b|printf\b)/;

/** The script's command segments, split at separators, comments and echoes dropped. */
export function commandSegments(command: string): string[] {
  return scriptSkeleton(command)
    .split('\n')
    .filter((l) => l.trim() && !NOT_INVOCATION.test(l))
    .flatMap((l) => l.replace(/\d*>&\d+|&>/g, '>').split(/&&|\|\||[;|&]/))
    .map((s) => s.replace(/[()]/g, ' ').trim())
    .filter((s) => s && !NOT_INVOCATION.test(s));
}

/**
 * Invocations of a test, lint or build runner. Kept beside the classifier's
 * patterns so a run that is classified always yields a fragment.
 */
export const RUNNER_KINDS = {
  test:
    /\b(?:npm|pnpm|yarn|bun)(?:\s+--?[\w-]+(?:[= ](?!run\b|test\b|e2e\b)[^\s-]\S*)?)*\s+(?:run\s+)?(?:test|e2e)\b|\b(?:npm|pnpm|yarn|bun)\s+run\s+(?:test|e2e):[\w-]+|\bvitest\b|\bjest\b|\bpytest\b|\bplaywright\s+test\b|\bgo\s+test\b|\bswift\s+test\b|\bcargo\s+test\b|\bnode\s+--test\b|\brspec\b|\bphpunit\b|\bdotnet\s+test\b|\bxcodebuild\b[^\n]*\btest\b|\b(?:just|make|task)\s+(?:test|e2e)\b/,
  lint:
    /\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?lint\b|\beslint\b|\bprettier\b|\bruff\b|\bblack\b|\bcargo\s+(?:clippy|fmt)\b|\bswiftlint\b|\bgolangci-lint\b|\bflake8\b|\bmypy\b|\b(?:just|make|task)\s+lint\b/,
  build:
    /\b(?:npm|pnpm|yarn|bun)(?:\s+--?[\w-]+(?:[= ](?!run\b|build\b|typecheck\b)[^\s-]\S*)?)*\s+(?:run\s+)?(?:build|typecheck|type-check)\b|\btsc\b|\bpyright\b|\bcargo\s+build\b|\bgo\s+build\b|\bswift\s+build\b|\bxcodebuild\b|\bmake\b|\bgradle\b|\bmvn\b|\bdocker\s+(?:compose\s+)?build\b|\b(?:just|task)\s+(?:build|typecheck)\b/,
} as const;

/** Wrappers that only change how a runner is launched; the fragment starts after them. */
const LAUNCHER_RE = /^(?:(?:[A-Za-z_][A-Za-z0-9_]*=\S*|timeout\s+\S+|time|env|nice|exec|command)\s+)+/;

/** Tools that run another tool: the runner is the word after them. Kept in the fragment. */
const WRAPPER_RE = /^(?:npx|bunx|pnpm\s+(?:exec|dlx)|yarn\s+(?:exec|dlx)|uv\s+run|poetry\s+run|pipenv\s+run|bundle\s+exec|python3?\s+-m)(?:\s+--?[\w-]+)*\s+/;

/**
 * Whether a command segment runs a `kind` runner. The runner has to be the
 * command being run, after any launcher or wrapper: `cat > vitest.config.ts`
 * mentions vitest but runs `cat`.
 */
export function runsKind(segment: string, re: RegExp): boolean {
  const head = segment.replace(LAUNCHER_RE, '');
  const anchored = new RegExp(`^(?:${re.source})`);
  return anchored.test(head) || anchored.test(head.replace(WRAPPER_RE, ''));
}

/** A word that is safe to publish: no absolute or home path, variable, quote, redirect or glob. */
const SAFE_WORD = /^(?!\/|~|\.\.)[\w@.:,=+%/-]+$/;

const MAX_FRAGMENT = 80;

/**
 * The runner invocation a command made, as it may appear in a pull request:
 * `pnpm test`, `uv run pytest -q tests/test_api.py`. Undefined when the command
 * ran no test, lint or build runner.
 *
 * The published form is deliberately an allowlist, not the command with bits
 * removed: words are kept only while they are plain, and the first absolute
 * path, variable, quoted string or redirect ends the fragment.
 */
export function runnerFragment(command: string): string | undefined {
  for (const kind of ['test', 'lint', 'build'] as const) {
    const segment = commandSegments(command).find((s) => runsKind(s, RUNNER_KINDS[kind]));
    if (!segment) continue;

    const words: string[] = [];
    for (const word of segment.replace(LAUNCHER_RE, '').split(/\s+/)) {
      if (!SAFE_WORD.test(word) || /^\d*>/.test(word)) break;
      if ([...words, word].join(' ').length > MAX_FRAGMENT) break;
      words.push(word);
    }
    if (words.length > 0) return words.join(' ');
  }
  return undefined;
}
