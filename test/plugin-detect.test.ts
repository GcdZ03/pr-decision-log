import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pluginHooks } from '../src/doctor/settings.ts';

// Fixture shapes copied from a real local-scope install of this plugin:
// installed_plugins.json records scope and projectPath, enabledPlugins lives
// in the settings file for that scope, and hooks.json sits in installPath.

type Entry = { scope: string; projectPath?: string };

function withInstall(entry: Entry | null, enabledIn: 'user' | 'project' | 'local' | null, fn: (a: { root: string; installed: string; userSettings: string }) => void) {
  const dir = mkdtempSync(join(tmpdir(), 'pdl-plugin-'));
  try {
    const root = join(dir, 'repo');
    const installPath = join(dir, 'cache', 'pr-decision-log', '0.1.0');
    mkdirSync(join(root, '.claude'), { recursive: true });
    mkdirSync(join(installPath, 'hooks'), { recursive: true });
    writeFileSync(join(installPath, 'hooks', 'hooks.json'), JSON.stringify({ hooks: { PostToolUse: [], Stop: [], SubagentStop: [] } }));

    const installed = join(dir, 'installed_plugins.json');
    if (entry) {
      writeFileSync(installed, JSON.stringify({
        version: 2,
        plugins: { 'pr-decision-log@pr-decision-log': [{ ...entry, installPath, version: '0.1.0', projectPath: entry.projectPath === 'ROOT' ? root : entry.projectPath }] },
      }));
    }

    const userSettings = join(dir, 'user-settings.json');
    const enabled = JSON.stringify({ enabledPlugins: { 'pr-decision-log@pr-decision-log': true } });
    if (enabledIn === 'user') writeFileSync(userSettings, enabled);
    if (enabledIn === 'project') writeFileSync(join(root, '.claude', 'settings.json'), enabled);
    if (enabledIn === 'local') writeFileSync(join(root, '.claude', 'settings.local.json'), enabled);

    fn({ root, installed, userSettings });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('a user-scope install enabled in user settings is active, with the events its hooks.json declares', () => {
  withInstall({ scope: 'user' }, 'user', ({ root, installed, userSettings }) => {
    const p = pluginHooks(root, installed, userSettings);

    assert.equal(p.active, true);
    assert.deepEqual(p.events.sort(), ['PostToolUse', 'Stop', 'SubagentStop']);
  });
});

test('a local-scope install for this project is active', () => {
  withInstall({ scope: 'local', projectPath: 'ROOT' }, 'local', ({ root, installed, userSettings }) => {
    assert.equal(pluginHooks(root, installed, userSettings).active, true);
  });
});

test('a local-scope install for a different project does not apply here', () => {
  withInstall({ scope: 'local', projectPath: '/somewhere/else' }, 'local', ({ root, installed, userSettings }) => {
    assert.equal(pluginHooks(root, installed, userSettings).active, false);
  });
});

test('an installed but disabled plugin is not active', () => {
  withInstall({ scope: 'user' }, null, ({ root, installed, userSettings }) => {
    assert.equal(pluginHooks(root, installed, userSettings).active, false);
  });
});

test('no plugin index at all reads as not installed', () => {
  withInstall(null, null, ({ root, installed, userSettings }) => {
    assert.deepEqual(pluginHooks(root, installed, userSettings), { active: false, events: [] });
  });
});
