type CommentSyntax = { line?: string[]; block?: [string, string] };

/** Comment syntax by file extension; a language not listed has none we can rely on. */
function syntaxOf(path: string): CommentSyntax {
  const ext = /\.([^.]+)$/.exec(path)?.[1]?.toLowerCase() ?? '';
  if (/^(?:py|rb|sh|bash|zsh|ya?ml|toml)$/.test(ext)) return { line: ['#'] };
  if (/^(?:[cm]?[tj]sx?|go|swift|rs|java|kt|kts|c|cc|cpp|h|hpp|cs|scala|dart)$/.test(ext)) return { line: ['//'], block: ['/*', '*/'] };
  if (ext === 'php') return { line: ['//', '#'], block: ['/*', '*/'] };
  return {};
}

/**
 * Code with comments removed and whitespace collapsed, leaving string
 * literals intact: `"#a"` is a string, not a comment, so a change inside it
 * is still a change.
 */
function codeOnly(text: string, syntax: CommentSyntax): string {
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (c === '"' || c === "'" || c === '`') {
      const triple = text.startsWith(c.repeat(3), i) ? c.repeat(3) : c;
      let j = i + triple.length;
      while (j < text.length && !text.startsWith(triple, j)) j += text[j] === '\\' ? 2 : 1;
      out += text.slice(i, j + triple.length);
      i = j + triple.length - 1;
      continue;
    }
    if (syntax.block && text.startsWith(syntax.block[0], i)) {
      const end = text.indexOf(syntax.block[1], i + syntax.block[0].length);
      i = end === -1 ? text.length : end + syntax.block[1].length - 1;
      out += ' ';
      continue;
    }
    if (syntax.line?.some((m) => text.startsWith(m, i))) {
      while (i < text.length && text[i] !== '\n') i++;
      out += '\n';
      continue;
    }
    out += c;
  }
  return out.replace(/\s+/g, ' ').trim();
}

/**
 * Whether an edit changed only comments and whitespace. Such an edit does
 * not change what a test checks: two of three new test-edit flags in real
 * sessions were `# noqa` comments added to quiet a linter.
 */
export function isCosmeticChange(before: string, after: string, path: string): boolean {
  const syntax = syntaxOf(path);
  return codeOnly(before, syntax) === codeOnly(after, syntax);
}
