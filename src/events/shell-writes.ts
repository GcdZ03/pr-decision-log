import { homedir } from 'node:os';
import { isAbsolute, resolve } from 'node:path';
import { splitHeredocs } from './command-text.ts';

/** A file a shell command wrote. `content` is known only for a heredoc written straight to the file. */
export type ShellWrite = { path: string; append: boolean; content?: string };

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

/**
 * Files a Python or Node script writes, where the path is a literal or a
 * variable assigned one: `open(p, 'w')`, `Path('x').write_text`,
 * `fs.writeFileSync('x', ...)`. Agents edit with exactly these scripts.
 */
function scriptWrites(body: string): { path: string; append: boolean }[] {
  // Assignments in order, so a write resolves a variable to its value at that point.
  const assignments = [...body.matchAll(/(?:^|[;\n]|\b(?:const|let|var)\s)\s*(\w+)\s*=\s*(['"])([^'"\n]+)\2/g)]
    .map((m) => ({ at: m.index, name: m[1]!, value: m[3]! }));
  const valueAt = (name: string, at: number) => assignments.filter((a) => a.name === name && a.at < at).at(-1)?.value;

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
  return found.sort((a, b) => a.at - b.at).map(({ path, append }) => ({ path, append }));
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
  const add = (word: Word | string, append: boolean, content?: string) => {
    if (typeof word !== 'string' && word.dynamic) return;
    const raw = typeof word === 'string' ? word : word.v;
    if (raw.endsWith('/') || raw === '.' || raw === '..') return;
    const path = place(raw);
    if (!path) return;
    const seen = writes.find((x) => x.path === path);
    if (seen) { if (!append) seen.append = false; return; }
    writes.push({ path, append, ...(content !== undefined ? { content } : {}) });
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
    if (INTERPRETERS.test(name) && cmd.body) for (const s of scriptWrites(cmd.body)) add(s.path, s.append);
  }
  return writes;
}
