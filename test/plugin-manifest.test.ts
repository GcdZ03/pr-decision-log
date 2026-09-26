import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { REQUIRED_HOOK_EVENTS } from '../src/doctor/diagnose.ts';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..');
const readJson = (p: string): Record<string, unknown> =>
  JSON.parse(readFileSync(join(repo, p), 'utf8')) as Record<string, unknown>;

test('the plugin manifest is valid JSON with the fields a plugin needs', () => {
  const manifest = readJson('.claude-plugin/plugin.json');

  assert.equal(manifest['name'], 'pr-decision-log');
  for (const field of ['description', 'version', 'license', 'repository']) {
    assert.ok(manifest[field], `missing ${field}`);
  }
});

test('the plugin version matches package.json, so an install is never a different build', () => {
  assert.equal(readJson('.claude-plugin/plugin.json')['version'], readJson('package.json')['version']);
});

test('the plugin registers exactly the events pdl init registers', () => {
  const hooks = readJson('hooks/hooks.json')['hooks'] as Record<string, unknown>;

  assert.deepEqual(Object.keys(hooks).sort(), [...REQUIRED_HOOK_EVENTS].sort());
});

test('plugin hooks resolve through CLAUDE_PLUGIN_ROOT rather than an absolute path', () => {
  const raw = readFileSync(join(repo, 'hooks/hooks.json'), 'utf8');

  assert.match(raw, /\$\{CLAUDE_PLUGIN_ROOT\}/);
  assert.ok(!/\/Users\//.test(raw), 'an absolute home path leaked into the manifest');
});

test('Stop is synchronous in the plugin too, matching what init writes', () => {
  const hooks = readJson('hooks/hooks.json')['hooks'] as Record<string, { hooks: { async?: boolean }[] }[]>;

  assert.notEqual(hooks['Stop']?.[0]?.hooks?.[0]?.async, true);
  assert.equal(hooks['PostToolUse']?.[0]?.hooks?.[0]?.async, true);
});

test('the plugin runs the bundled entry point, which is what npm ships', () => {
  const raw = readFileSync(join(repo, 'hooks/hooks.json'), 'utf8');

  assert.match(raw, /dist\/pdl\.js/);
});

test('the published package includes the plugin manifest and hooks', () => {
  const files = readJson('package.json')['files'] as string[];

  for (const needed of ['dist', '.claude-plugin', 'hooks']) {
    assert.ok(files.includes(needed), `npm would not ship ${needed}`);
  }
});

// The plugin route. Claude Code installs plugins from git (installs record a
// gitCommitSha) and runs no build step, so whatever the hooks execute has to be
// committed. dist/ was gitignored, so a plugin install registered six hooks
// pointing at a file that did not exist.

test('the file the plugin hooks run is committed to git', () => {
  const tracked = execFileSync('git', ['ls-files', '--', 'dist/pdl.js'], { cwd: repo, encoding: 'utf8' }).trim();

  assert.equal(tracked, 'dist/pdl.js', 'dist/pdl.js is not tracked, so a git-based plugin install has no bundle to run');
});

test('the repository is its own marketplace, listing the plugin at its root', () => {
  const market = readJson('.claude-plugin/marketplace.json');
  const plugins = market['plugins'] as { name: string; source: unknown; version?: string }[];

  const entry = plugins.find((p) => p.name === 'pr-decision-log');
  assert.ok(entry, 'marketplace does not list pr-decision-log');
  assert.equal(entry.source, './');
});

test('the marketplace version matches package.json', () => {
  const plugins = readJson('.claude-plugin/marketplace.json')['plugins'] as { name: string; version?: string }[];

  assert.equal(plugins.find((p) => p.name === 'pr-decision-log')?.version, readJson('package.json')['version']);
});
