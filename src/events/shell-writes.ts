import { homedir } from 'node:os';
import { isAbsolute, resolve } from 'node:path';
import { splitHeredocs } from './command-text.ts';

/** A file a shell command wrote. `content` is known only for a heredoc written straight to the file. */
/**
 * A file a shell command wrote. `content` is known only for a heredoc written
 * straight to the file; `replaced` only for a script whose every change to
 * the file was a `replace(old, new)` with readable literals.
 */
export type ShellWrite = { path: string; append: boolean; content?: string; replaced?: { old: string; new: string } };

type Word = { k: 'w'; v: string; dynamic: boolean };
type Op = { k: 'op'; v: string };
type Token = Word | Op;

const SEPARATORS = new Set([';', '&&', '||', '|', '&', '(', ')']);

/** Shell tokens, quotes removed, with words built from `$` expansions marked as unknowable. */
function tokenize(text: string): Token[] {
  const out: Token[] = [];
  let word: Word | undefined;
  const flush = () => { if (word) out.push(word); word = undefined; };
  const w = (): Word => (word ??= { k: 'w', v: '', dynamic: false });

  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    const rest = text.slice(i);

    if (c === '\n') { flush(); out.push({ k: 'op', v: ';' }); continue; }
    if (c === ' ' || c === '\t') { flush(); continue; }
    if (c === '#' && !word) { while (i + 1 < text.length && text[i + 1] !== '\n') i++; continue; }
    if (c === '\\') { w().v += text[i + 1] ?? ''; i++; continue; }

    if (c === "'") {
      const end = text.indexOf("'", i + 1);
      w().v += text.slice(i + 1, end === -1 ? undefined : end);
      i = end === -1 ? text.length : end;
      continue;
    }
    if (c === '"') {
      const cur = w();
      for (i++; i < text.length && text[i] !== '"'; i++) {
        if (text[i] === '\\') { cur.v += text[i + 1] ?? ''; i++; continue; }
        if (text[i] === '$' || text[i] === '`') cur.dynamic = true;
        cur.v += text[i];
      }
      continue;
    }
    if (c === '$' || c === '`') {
      const cur = w();
      cur.dynamic = true;
      if (c === '`') { const end = text.indexOf('`', i + 1); i = end === -1 ? text.length : end; continue; }
      if (text[i + 1] === '(') {
        let depth = 0;
        for (; i < text.length; i++) {
          if (text[i] === '(') depth++;
          else if (text[i] === ')' && --depth === 0) break;
        }
        continue;
      }
      cur.v += c;
      continue;
    }

    // A file descriptor number directly before a redirect: `2>`, `2>>`.
    if ((c === '>' || c === '<') && word && /^\d+$/.test(word.v) && !word.dynamic) {
      word = undefined;
      const op = rest.startsWith('>>') ? '>>' : rest.startsWith('>&') ? '>&' : c;
      out.push({ k: 'op', v: `fd${op}` });
      i += op.length - 1;
      continue;
    }

    const op = ['&&', '||', '<<<', '<<-', '<<', '>>', '>|', '>&', '&>', '|', ';', '&', '(', ')', '>', '<'].find((o) => rest.startsWith(o));
    if (op) { flush(); out.push({ k: 'op', v: op }); i += op.length - 1; continue; }

    w().v += c;
  }
  flush();
  return out;
}

type Simple = { words: Word[]; outputs: { path: Word; append: boolean }[]; body?: string; piped: boolean };

/** Split tokens into simple commands, with their output redirects and heredoc body. */
function simpleCommands(tokens: Token[], bodies: string[]): Simple[] {
  const out: Simple[] = [];
  let cur: Simple = { words: [], outputs: [], piped: false };
  let nextBody = 0;

  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!;
    if (t.k === 'w') { cur.words.push(t); continue; }
    if (SEPARATORS.has(t.v)) {
      out.push(cur);
      cur = { words: [], outputs: [], piped: t.v === '|' };
      continue;
    }
    const target = tokens[i + 1];
    if (target?.k !== 'w') continue;
    i++;
    if (t.v === '>' || t.v === '>>' || t.v === '>|') cur.outputs.push({ path: target, append: t.v === '>>' });
    else if (t.v === '<<' || t.v === '<<-') cur.body = bodies[nextBody++];
    // `<`, `<<<`, `fd>`, `>&`, `&>`: input, or output that is not a file the code lives in.
  }
  out.push(cur);
  return out;
}

const PREFIX_WORDS = new Set(['sudo', 'env', 'command', 'exec', 'time', 'nohup', 'nice']);

function commandName(words: Word[]): { name: string; args: Word[] } {
  let i = 0;
  while (i < words.length && (/^[A-Za-z_]\w*=/.test(words[i]!.v) || PREFIX_WORDS.has(words[i]!.v))) i++;
  return { name: words[i]?.v ?? '', args: words.slice(i + 1) };
}

const operands = (args: Word[]): Word[] => args.filter((a) => !a.v.startsWith('-'));

/** `sed -i[suffix] [-e script | script] file...`: the files. macOS takes the suffix as a separate, often empty, word. */
function sedFiles(args: Word[]): Word[] {
  let inPlace = false;
  let script = false;
  const files: Word[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a.v === '-i' || a.v === '-I') {
      inPlace = true;
      const next = args[i + 1];
      if (next && (next.v === '' || /^\.\w+$/.test(next.v))) i++;
    } else if (/^-[iI]\S/.test(a.v) || a.v === '--in-place' || a.v.startsWith('--in-place=')) inPlace = true;
    else if (a.v === '-e' || a.v === '-f' || a.v === '--expression') { script = true; i++; }
    else if (a.v.startsWith('-')) continue;
    else if (!script) script = true;
    else files.push(a);
  }
  return inPlace ? files : [];
}

/** A string literal starting at `i` (Python, including triple-quoted, or JS): its value and where it ends. */
function literalAt(text: string, i: number): { value: string; end: number } | undefined {
  const prefix = /^[rRbBuU]{0,2}/.exec(text.slice(i, i + 2))?.[0] ?? '';
  const raw = /r/i.test(prefix);
  let j = i + prefix.length;
  for (const triple of [`'''`, `"""`]) {
    if (!text.startsWith(triple, j)) continue;
    const end = text.indexOf(triple, j + 3);
    return end < 0 ? undefined : { value: text.slice(j + 3, end), end: end + 3 };
  }
  const quote = text[j];
  if (quote !== "'" && quote !== '"' && quote !== '`') return undefined;
  let value = '';
  for (j += 1; j < text.length; j++) {
    const c = text[j]!;
    if (c === '\\' && !raw) {
      const next = text[j + 1] ?? '';
      value += next === 'n' ? '\n' : next === 't' ? '\t' : next;
      j++;
      continue;
    }
    if (c === quote) return { value, end: j + 1 };
    if (c === '\n' && quote !== '`') return undefined;
    if (quote === '`' && c === '$' && text[j + 1] === '{') return undefined; // An interpolation: not a literal.
    value += c;
  }
  return undefined;
}

/** Variables assigned a literal, in order, so a use resolves to the value it had there. */
function literalAssignments(body: string): { at: number; name: string; value: string }[] {
  const out: { at: number; name: string; value: string }[] = [];
  for (const m of body.matchAll(/(?:^|[;\n{]|\b(?:const|let|var)\s)\s*([A-Za-z_]\w*)\s*=(?!=)\s*/g)) {
    const lit = literalAt(body, m.index + m[0].length);
    if (lit) out.push({ at: m.index, name: m[1]!, value: lit.value });
  }
  return out;
}

/** Ways a script changes text that cannot be read off literally. Any of them makes the counts unknown. */
const UNREADABLE_CHANGE = /\bre\.sub\(|\bsub\(|\.replaceAll\(|\.format\(|\bf['"]/;

type Pair = [string, string];

/**
 * The script with every string literal's contents removed and its quotes
 * and prefix kept, so the unreadable-change check looks at the script's own
 * code, not at the test code it inserts: new test code full of f-strings is
 * still a plain replace.
 */
function withoutLiteralText(segment: string): string {
  let out = '';
  for (let i = 0; i < segment.length; i++) {
    const c = segment[i]!;
    if (c === '"' || c === "'" || c === '`') {
      const lit = literalAt(segment, i);
      if (lit) { out += `${c}${c}`; i = lit.end - 1; continue; }
    }
    out += c;
  }
  return out;
}

/** A list of two-literal tuples starting at `[`: `[('a', 'b'), ("""c""", """d""")]`. Undefined when any entry is not. */
function pairListAt(text: string, i: number): { pairs: Pair[]; end: number } | undefined {
  if (text[i] !== '[') return undefined;
  const pairs: Pair[] = [];
  const ws = (j: number) => j + (/^[\s,]*/.exec(text.slice(j))?.[0].length ?? 0);
  let j = ws(i + 1);
  while (text[j] !== ']') {
    if (text[j] !== '(') return undefined;
    const first = literalAt(text, j + 1 + (/^\s*/.exec(text.slice(j + 1))?.[0].length ?? 0));
    if (!first) return undefined;
    const comma = /^\s*,\s*/.exec(text.slice(first.end));
    const second = comma ? literalAt(text, first.end + comma[0].length) : undefined;
    const close = second ? /^\s*,?\s*\)/.exec(text.slice(second.end)) : null;
    if (!second || !close) return undefined;
    pairs.push([first.value, second.value]);
    j = ws(second.end + close[0].length);
    if (j >= text.length) return undefined;
  }
  return { pairs, end: j + 1 };
}

/** Lists of replacement pairs assigned to a name, in order: `reps = [(old, new), ...]`. */
function pairListAssignments(body: string): { at: number; name: string; pairs: Pair[] }[] {
  const out: { at: number; name: string; pairs: Pair[] }[] = [];
  for (const m of body.matchAll(/(?:^|[;\n])\s*([A-Za-z_]\w*)\s*=\s*(?=\[)/g)) {
    const list = pairListAt(body, m.index + m[0].length);
    if (list) out.push({ at: m.index, name: m[1]!, pairs: list.pairs });
  }
  return out;
}

/**
 * The text a script segment takes out and puts in: its `replace(old, new)`
 * calls, replacement pairs applied in a `for a, b in pairs:` loop, and
 * literals appended with `+=`. Undefined when the segment changes the text
 * in any way that is not one of those with readable literals: a half-read
 * edit would give a count that looks exact and is not.
 */
function replacements(
  segment: string,
  at: (name: string, pos: number) => string | undefined,
  pairsAt: (name: string, pos: number) => Pair[] | undefined,
): { old: string; new: string } | undefined {
  if (UNREADABLE_CHANGE.test(withoutLiteralText(segment))) return undefined;
  const arg = (pos: number): { value: string; end: number; name?: string } | undefined => {
    const start = pos + (/^\s*/.exec(segment.slice(pos))?.[0].length ?? 0);
    const lit = literalAt(segment, start);
    if (lit) return lit;
    const name = /^[A-Za-z_]\w*/.exec(segment.slice(start))?.[0];
    if (!name) return undefined;
    return { value: at(name, start) ?? '', end: start + name.length, name };
  };

  // `for a, b in reps:` / `for a, b in [(...), ...]:` — the loop variables stand for every pair.
  const loops: { first: string; second: string; pairs?: Pair[] }[] = [];
  for (const m of segment.matchAll(/\bfor\s+([A-Za-z_]\w*)\s*,\s*([A-Za-z_]\w*)\s+in\s+/g)) {
    const pos = m.index + m[0].length;
    const inline = pairListAt(segment, pos);
    const named = /^[A-Za-z_]\w*/.exec(segment.slice(pos))?.[0];
    loops.push({ first: m[1]!, second: m[2]!, pairs: inline?.pairs ?? (named ? pairsAt(named, pos) : undefined) });
  }

  const changes: { at: number; old: string; new: string }[] = [];
  for (const m of segment.matchAll(/\.replace\(/g)) {
    const first = arg(m.index + m[0].length);
    const comma = first ? /^\s*,/.exec(segment.slice(first.end)) : null;
    const second = first && comma ? arg(first.end + comma[0].length) : undefined;
    const close = second ? /^\s*(?:,\s*\d+\s*)?\)/.exec(segment.slice(second.end)) : null;
    if (!first || !second || !close) return undefined;
    const loop = first.name && second.name ? loops.find((l) => l.first === first.name && l.second === second.name) : undefined;
    if (loop) {
      if (!loop.pairs) return undefined;
      for (const [o, n] of loop.pairs) changes.push({ at: m.index, old: o, new: n });
      continue;
    }
    // A name that is not a literal it can resolve leaves the edit unknown.
    if ((first.name && at(first.name, m.index) === undefined) || (second.name && at(second.name, m.index) === undefined)) return undefined;
    changes.push({ at: m.index, old: first.value, new: second.value });
  }
  for (const m of segment.matchAll(/\b[A-Za-z_]\w*\s*\+=\s*/g)) {
    const lit = literalAt(segment, m.index + m[0].length);
    if (!lit) return undefined;
    changes.push({ at: m.index, old: '', new: lit.value });
  }

  if (changes.length === 0) return undefined;
  changes.sort((a, b) => a.at - b.at);
  return { old: changes.map((c) => c.old).join('\n'), new: changes.map((c) => c.new).join('\n') };
}

/**
 * Files a Python or Node script writes, where the path is a literal or a
 * variable assigned one: `open(p, 'w')`, `Path('x').write_text`,
 * `fs.writeFileSync('x', ...)`. Agents edit with exactly these scripts. Each
 * write also carries the `replace` texts of the script since the previous
 * write, which is how such scripts edit one file after another.
 */
function scriptWrites(body: string): { path: string; append: boolean; replaced?: { old: string; new: string } }[] {
  const assignments = literalAssignments(body);
  const valueAt = (name: string, at: number) => assignments.filter((a) => a.name === name && a.at < at).at(-1)?.value;
  const lists = pairListAssignments(body);
  const pairsAt = (name: string, at: number) => lists.filter((l) => l.name === name && l.at < at).at(-1)?.pairs;

  const found: { at: number; path: string; append: boolean }[] = [];
  for (const m of body.matchAll(/\bopen\(\s*(?:(['"])([^'"\n]+)\1|(\w+))\s*,\s*(['"])([^'"\n]*)\4/g)) {
    const path = m[2] ?? valueAt(m[3]!, m.index);
    if (path && /[wax]/.test(m[5]!)) found.push({ at: m.index, path, append: m[5]!.includes('a') });
  }
  for (const m of body.matchAll(/\bPath\(\s*(['"])([^'"\n]+)\1\s*\)\.write_(?:text|bytes)\(/g)) {
    found.push({ at: m.index, path: m[2]!, append: false });
  }
  for (const m of body.matchAll(/\b(writeFileSync|appendFileSync|writeFile|appendFile)\(\s*(?:(['"`])([^'"`\n$]+)\2|(\w+))/g)) {
    const path = m[3] ?? valueAt(m[4]!, m.index);
    if (path) found.push({ at: m.index, path, append: m[1]!.startsWith('append') });
  }

  found.sort((a, b) => a.at - b.at);
  return found.map((w, i) => {
    const from = i === 0 ? 0 : found[i - 1]!.at;
    const replaced = replacements(body.slice(from, w.at), (name, pos) => valueAt(name, from + pos), (name, pos) => pairsAt(name, from + pos));
    return { path: w.path, append: w.append, ...(replaced ? { replaced } : {}) };
  });
}

const INTERPRETERS = /^(?:python3?(?:\.\d+)?|node|ruby)$/;

/**
 * Files a Bash command wrote, read from the command text alone.
 *
 * Most file writes in real sessions go through the shell rather than the edit
 * tools (73% across the stored sessions), so the test-edit flag, which watches
 * edits to test files after a failure, was blind to most of them. This finds
 * output redirects, `tee`, `sed -i`, `cp` and `mv` destinations, and the files
 * a Python or Node heredoc script opens for writing. A target that comes from
 * a variable or command substitution is skipped rather than guessed. A `cd`
 * earlier in the script moves later relative targets, as it would when run.
 */
export function shellWrites(command: string, cwd: string | undefined, home: string = homedir()): ShellWrite[] {
  const { text, bodies } = splitHeredocs(command);
  let dir = cwd;
  const place = (p: string): string | undefined => {
    if (p === '' || p.startsWith('/dev/')) return undefined;
    const expanded = p === '~' || p.startsWith('~/') ? home + p.slice(1) : p;
    if (isAbsolute(expanded)) return resolve(expanded);
    return dir ? resolve(dir, expanded) : expanded;
  };

  const writes: ShellWrite[] = [];
  const add = (word: Word | string, append: boolean, content?: string, replaced?: { old: string; new: string }) => {
    if (typeof word !== 'string' && word.dynamic) return;
    const raw = typeof word === 'string' ? word : word.v;
    if (raw.endsWith('/') || raw === '.' || raw === '..') return;
    const path = place(raw);
    if (!path) return;
    const seen = writes.find((x) => x.path === path);
    if (seen) {
      if (!append) seen.append = false;
      // A second write to the same file: its edits add up, and one unreadable write makes both unknown.
      const merged = seen.replaced && replaced ? { old: `${seen.replaced.old}\n${replaced.old}`, new: `${seen.replaced.new}\n${replaced.new}` } : undefined;
      if (merged) seen.replaced = merged;
      else delete seen.replaced;
      return;
    }
    writes.push({ path, append, ...(content !== undefined ? { content } : {}), ...(replaced ? { replaced } : {}) });
  };

  for (const cmd of simpleCommands(tokenize(text), bodies)) {
    const { name, args } = commandName(cmd.words);

    if ((name === 'cd' || name === 'pushd') && args[0] && !args[0].dynamic && args[0].v !== '-') {
      dir = place(args[0].v) ?? dir;
      continue;
    }

    // A heredoc's text is what reaches the file only when `cat` passes it straight through.
    const verbatim = name === 'cat' && operands(args).length === 0 && !cmd.piped ? cmd.body : undefined;
    for (const o of cmd.outputs) add(o.path, o.append, verbatim);

    if (name === 'tee') for (const a of operands(args)) add(a, args.some((x) => x.v === '-a' || x.v === '--append'));
    if (name === 'sed') for (const f of sedFiles(args)) add(f, false);
    if (name === 'cp' || name === 'mv' || name === 'install') {
      const ops = operands(args);
      if (ops.length >= 2) add(ops[ops.length - 1]!, false);
    }
    if (INTERPRETERS.test(name) && cmd.body) for (const s of scriptWrites(cmd.body)) add(s.path, s.append, undefined, s.replaced);
  }
  return writes;
}
