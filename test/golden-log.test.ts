import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { buildLog } from '../src/render/build-log.ts';
import { render } from '../src/render/render.ts';
import type { TimelineEvent } from '../src/events/types.ts';

// One fixed session and diff, rendered to exact markdown. A layout change
// shows up as a diff of this file in review, rather than as prose. To accept
// a deliberate change: PDL_UPDATE_GOLDEN=1 node --test test/golden-log.test.ts
const GOLDEN = new URL('./fixtures/golden-log.md', import.meta.url);

const events: TimelineEvent[] = [
  { kind: 'command', id: 'c1', at: '2026-10-03T06:17:00Z', command: 'cd /repo && uv run pytest services/api -q', classification: 'test', outcome: 'pass' },
  { kind: 'command', id: 'c2', at: '2026-10-03T06:18:32Z', command: 'uv run pytest services/api/tests/test_parsing.py -q 2>&1 | tail', classification: 'test', outcome: 'fail', output: 'FAILED services/api/tests/test_parsing.py::test_csv' },
  { kind: 'command', id: 'w1', at: '2026-10-03T06:18:40Z', command: "python3 - <<'EOF'\nx\nEOF", classification: 'other', outcome: 'pass', writes: [{ path: '/repo/services/api/tests/test_parsing.py' }] },
  { kind: 'command', id: 'c3', at: '2026-10-03T06:18:55Z', command: 'uv run pytest services/api/tests/test_parsing.py -q', classification: 'test', outcome: 'pass' },
  { kind: 'command', id: 'c4', at: '2026-10-03T06:20:00Z', command: 'uv run ruff check --fix .', classification: 'lint', outcome: 'pass' },
  { kind: 'command', id: 'c5', at: '2026-10-03T06:21:00Z', command: 'pnpm --filter @app/web test', classification: 'test', outcome: 'pass' },
  { kind: 'command', id: 'c6', at: '2026-10-03T06:22:00Z', command: 'ls -la', classification: 'other', outcome: 'pass' },
];

const file = (path: string, added: number, isNew = false) => [
  `diff --git a/${path} b/${path}`, ...(isNew ? ['new file mode 100644', '--- /dev/null'] : [`--- a/${path}`]), `+++ b/${path}`,
  '@@ -1 +1 @@', ...Array.from({ length: added }, (_, i) => `+l${i}`),
].join('\n');

const diff = [
  file('services/api/src/parsing.py', 41, true),
  file('services/api/tests/test_parsing.py', 27, true),
  file('services/api/Dockerfile', 2),
  file('apps/web/src/lib/imports.ts', 26, true),
  file('.github/workflows/ci.yml', 3),
  file('uv.lock', 12),
].join('\n');

test('a fixed session renders to the golden markdown', () => {
  const md = render(buildLog(events, {
    repo: 'github.com/acme/app', branch: 'feat/imports', headSha: 'abc1234', generatedAt: '2026-10-03T07:00:00Z',
    repoRoot: '/repo', diff, sessions: ['s1'], prUrl: 'https://github.com/acme/app/pull/12',
  }, [{ text: 'Upload storage: Local volume', kind: 'decision', source: 'human-answer', confidence: 'confirmed_by_human' }]));

  if (process.env['PDL_UPDATE_GOLDEN'] === '1') writeFileSync(GOLDEN, md);
  assert.equal(md, readFileSync(GOLDEN, 'utf8'));
});
