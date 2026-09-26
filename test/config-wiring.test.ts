import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { DEFAULT_CONFIG } from '../src/config/config.ts';

const src = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? sources(p) : p.endsWith('.ts') ? [p] : [];
  });
}

// Guards the bug found while briefing the project: config accepted and
// validated settings that no code ever read, so the tool said one thing and
// did another. Every setting must be read somewhere outside the loader.
const code = sources(src)
  .filter((p) => !p.includes(`${join('src', 'config')}`))
  .map((p) => readFileSync(p, 'utf8'))
  .join('\n');

for (const [section, values] of Object.entries(DEFAULT_CONFIG)) {
  if (section === 'problems') continue;
  for (const key of Object.keys(values as object)) {
    test(`config ${section}.${key} is actually used`, () => {
      assert.match(code, new RegExp(`\\b${section}\\.${key}\\b`), `${section}.${key} is accepted but never read`);
    });
  }
}
