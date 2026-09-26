/**
 * Second-layer defence for free text.
 *
 * The primary defence is structural: the renderer never receives raw tool
 * output (DESIGN section 9). This pass exists because agent prose can quote a
 * secret it read, and prose is the one thing that does reach a PR body.
 *
 * Deliberately biased toward false positives on secret-shaped strings and away
 * from touching ordinary prose, file paths, or git SHAs.
 */
export type RedactionRule = { name: string; pattern: RegExp; replace?: (m: RegExpMatchArray) => string };

const REDACTED = (rule: string) => `[redacted:${rule}]`;

const RULES: RedactionRule[] = [
  { name: 'github_token', pattern: /\b(gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g },
  { name: 'aws_access_key', pattern: /\b(A3T[A-Z0-9]|AKIA|ASIA|ABIA|ACCA)[A-Z0-9]{16}\b/g },
  { name: 'slack_token', pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g },
  { name: 'stripe_key', pattern: /\b(sk|rk)_(live|test)_[A-Za-z0-9]{16,}\b/g },
  { name: 'google_api_key', pattern: /\bAIza[A-Za-z0-9_-]{35}\b/g },
  { name: 'jwt', pattern: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g },
  {
    name: 'private_key_block',
    pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  },
  {
    // Keep the key name: it is useful context and is not itself a secret.
    name: 'secret_assignment',
    pattern: /\b([A-Z0-9_]*(?:SECRET|TOKEN|PASSWORD|PASSWD|API_KEY|PRIVATE_KEY|ACCESS_KEY)[A-Z0-9_]*)\s*[=:]\s*("[^"]+"|'[^']+'|\S+)/g,
    replace: (m) => `${m[1]}=${REDACTED('secret_assignment')}`,
  },
  {
    // Strip only the credentials, leaving the host and path readable.
    name: 'url_credentials',
    pattern: /\b([a-z][a-z0-9+.-]*:\/\/)([^/\s:@]+):([^/\s@]+)@/gi,
    replace: (m) => `${m[1]}${REDACTED('url_credentials')}@`,
  },
];

/**
 * Rules from `redaction.extra_patterns`. They are added to the built-in set,
 * never substituted for it: there is deliberately no setting that turns the
 * built-in rules off, since the repo's config wins and one committed file
 * would otherwise disable secret redaction for every contributor.
 *
 * Patterns are validated when config loads; one that still fails to compile
 * is skipped rather than allowed to break publishing.
 */
export function compileExtraPatterns(patterns: string[]): RedactionRule[] {
  const rules: RedactionRule[] = [];
  patterns.forEach((p, i) => {
    try {
      rules.push({ name: `custom_${i + 1}`, pattern: new RegExp(p, 'g') });
    } catch {
      // Reported by the config loader; nothing to add here.
    }
  });
  return rules;
}

export function redact(input: string, extra: RedactionRule[] = []): { text: string; hits: string[] } {
  let text = input;
  const hits: string[] = [];

  for (const rule of [...RULES, ...extra]) {
    rule.pattern.lastIndex = 0;
    if (!rule.pattern.test(text)) continue;
    rule.pattern.lastIndex = 0;
    hits.push(rule.name);
    text = text.replace(rule.pattern, (...args) => {
      const m = args.slice(0, -2) as unknown as RegExpMatchArray;
      return rule.replace ? rule.replace(m) : REDACTED(rule.name);
    });
  }

  return { text, hits };
}
