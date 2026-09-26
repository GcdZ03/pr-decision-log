import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, DEFAULT_CONFIG } from '../src/config/config.ts';

function withDirs(fn: (repo: string, user: string) => void) {
  const root = mkdtempSync(join(tmpdir(), 'pdl-cfg-'));
  const repo = join(root, 'repo');
  const user = join(root, 'user');
  mkdirSync(repo, { recursive: true });
  mkdirSync(user, { recursive: true });
  try { fn(repo, user); } finally { rmSync(root, { recursive: true, force: true }); }
}

const writeRepo = (repo: string, cfg: unknown) =>
  writeFileSync(join(repo, 'pdl.config.json'), typeof cfg === 'string' ? cfg : JSON.stringify(cfg));
const writeUser = (user: string, cfg: unknown) =>
  writeFileSync(join(user, 'config.json'), typeof cfg === 'string' ? cfg : JSON.stringify(cfg));

test('with no config files the defaults are used', () => {
  withDirs((repo, user) => {
    assert.deepEqual(loadConfig(repo, user).publish, DEFAULT_CONFIG.publish);
  });
});

test('a repo config overrides the default', () => {
  withDirs((repo, user) => {
    writeRepo(repo, { publish: { mode: 'comment' } });

    assert.equal(loadConfig(repo, user).publish.mode, 'comment');
  });
});

test('a partial override keeps its sibling defaults', () => {
  withDirs((repo, user) => {
    writeRepo(repo, { publish: { mode: 'comment' } });

    assert.equal(loadConfig(repo, user).publish.max_chars, DEFAULT_CONFIG.publish.max_chars);
  });
});

test('the repo config wins over the user config, because the team policy is shared', () => {
  withDirs((repo, user) => {
    writeUser(user, { publish: { mode: 'comment' } });
    writeRepo(repo, { publish: { mode: 'body' } });

    assert.equal(loadConfig(repo, user).publish.mode, 'body');
  });
});

test('a user config applies where the repo says nothing', () => {
  withDirs((repo, user) => {
    writeUser(user, { publish: { max_chars: 5000 } });

    assert.equal(loadConfig(repo, user).publish.max_chars, 5000);
  });
});

test('malformed JSON falls back to defaults rather than crashing a hook', () => {
  withDirs((repo, user) => {
    writeRepo(repo, '{ not json');

    const cfg = loadConfig(repo, user);
    assert.equal(cfg.publish.mode, DEFAULT_CONFIG.publish.mode);
    assert.match(cfg.problems.join(' '), /pdl\.config\.json/);
  });
});

test('an unknown publish mode is refused rather than passed through', () => {
  withDirs((repo, user) => {
    writeRepo(repo, { publish: { mode: 'carrier-pigeon' } });

    const cfg = loadConfig(repo, user);
    assert.equal(cfg.publish.mode, DEFAULT_CONFIG.publish.mode);
    assert.match(cfg.problems.join(' '), /mode/);
  });
});

test('a non-numeric max_chars is refused', () => {
  withDirs((repo, user) => {
    writeRepo(repo, { publish: { max_chars: 'lots' } });

    assert.equal(loadConfig(repo, user).publish.max_chars, DEFAULT_CONFIG.publish.max_chars);
  });
});

test('unknown keys are reported but do not stop the rest of the config loading', () => {
  withDirs((repo, user) => {
    writeRepo(repo, { publish: { mode: 'comment' }, nonsense: true });

    const cfg = loadConfig(repo, user);
    assert.equal(cfg.publish.mode, 'comment');
    assert.match(cfg.problems.join(' '), /nonsense/);
  });
});

test('a tilde in the store directory is expanded to the home directory', () => {
  withDirs((repo, user) => {
    writeRepo(repo, { store: { dir: '~/somewhere/pdl' } });

    assert.equal(loadConfig(repo, user).store.dir, join(homedir(), 'somewhere/pdl'));
  });
});

test('extra redaction patterns are loaded', () => {
  withDirs((repo, user) => {
    writeRepo(repo, { redaction: { extra_patterns: ['INTERNAL-[A-Z0-9]{8}'] } });

    assert.deepEqual(loadConfig(repo, user).redaction.extra_patterns, ['INTERNAL-[A-Z0-9]{8}']);
  });
});

test('an extra pattern that is not a valid regex is dropped and reported', () => {
  withDirs((repo, user) => {
    writeRepo(repo, { redaction: { extra_patterns: ['GOOD-[0-9]+', '(unclosed'] } });

    const cfg = loadConfig(repo, user);
    assert.deepEqual(cfg.redaction.extra_patterns, ['GOOD-[0-9]+']);
    assert.match(cfg.problems.join(' '), /\(unclosed/);
  });
});

test('settings for features that do not exist are reported as unknown', () => {
  withDirs((repo, user) => {
    writeRepo(repo, {
      publish: { on_push: true },
      extract: { model_summary: true, min_decisions_to_publish: 1 },
      redaction: { builtin_rules: false, publish_tool_output: true },
    });

    const problems = loadConfig(repo, user).problems.join(' ');
    for (const key of ['on_push', 'model_summary', 'min_decisions_to_publish', 'builtin_rules', 'publish_tool_output']) {
      assert.match(problems, new RegExp(key), `${key} was silently accepted`);
    }
  });
});

test('a negative retention is refused', () => {
  withDirs((repo, user) => {
    writeRepo(repo, { store: { retention_days: -3 } });

    const cfg = loadConfig(repo, user);
    assert.equal(cfg.store.retention_days, DEFAULT_CONFIG.store.retention_days);
    assert.match(cfg.problems.join(' '), /retention_days/);
  });
});

test('a max_chars too small to hold any log is refused', () => {
  withDirs((repo, user) => {
    writeRepo(repo, { publish: { max_chars: 500 } });

    const cfg = loadConfig(repo, user);
    assert.equal(cfg.publish.max_chars, DEFAULT_CONFIG.publish.max_chars);
    assert.match(cfg.problems.join(' '), /max_chars/);
  });
});
