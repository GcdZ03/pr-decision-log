import { test } from 'node:test';
import assert from 'node:assert/strict';
import { diagnose, worstStatus, type Facts } from '../src/doctor/diagnose.ts';

const healthy: Facts = {
  nodeVersion: 'v22.12.0',
  hookEvents: ['PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'UserPromptSubmit', 'Stop', 'SubagentStop'],
  settingsPath: '/repo/.claude/settings.json',
  recordedSessions: 3,
  gh: 'ok',
  env: {},
};

const find = (facts: Facts, name: string) => {
  const check = diagnose(facts).find((c) => c.name === name);
  assert.ok(check, `no check named ${name}`);
  return check;
};

test('a healthy install reports every check ok', () => {
  const checks = diagnose(healthy);

  assert.equal(worstStatus(checks), 'ok');
});

test('hooks registered but nothing ever recorded warns about the trust dialog', () => {
  const check = find({ ...healthy, recordedSessions: 0 }, 'hooks firing');

  assert.equal(check.status, 'warn');
  assert.match(check.remedy ?? '', /trust/i);
});

test('the trust warning does not fire when no hooks are registered, because the cause is different', () => {
  const check = find({ ...healthy, hookEvents: [], settingsPath: undefined, recordedSessions: 0 }, 'hooks firing');

  assert.equal(check.status, 'skip');
});

test('unregistered hooks fail and point at pdl init', () => {
  const check = find({ ...healthy, hookEvents: [], settingsPath: undefined }, 'hooks registered');

  assert.equal(check.status, 'fail');
  assert.match(check.remedy ?? '', /pdl init/);
});

test('a partial hook registration warns and names the missing events', () => {
  const check = find({ ...healthy, hookEvents: ['PostToolUse'] }, 'hooks registered');

  assert.equal(check.status, 'warn');
  assert.match(check.detail, /PostToolUseFailure/);
});

test('PDL_DISABLE set warns, because recording is silently off', () => {
  const check = find({ ...healthy, env: { PDL_DISABLE: '1' } }, 'kill switch');

  assert.equal(check.status, 'warn');
});

test('PDL_DISABLE=0 is reported as off rather than warned about', () => {
  const check = find({ ...healthy, env: { PDL_DISABLE: '0' } }, 'kill switch');

  assert.equal(check.status, 'ok');
});

test('node below the supported major fails', () => {
  const check = find({ ...healthy, nodeVersion: 'v20.11.0' }, 'node');

  assert.equal(check.status, 'fail');
});

test('a missing gh warns rather than fails, because recording still works without it', () => {
  const check = find({ ...healthy, gh: 'missing' }, 'gh');

  assert.equal(check.status, 'warn');
});

test('an unauthenticated gh names auth in the remedy', () => {
  const check = find({ ...healthy, gh: 'unauthenticated' }, 'gh');

  assert.equal(check.status, 'warn');
  assert.match(check.remedy ?? '', /gh auth login/);
});

test('worstStatus reports the most severe status present', () => {
  assert.equal(worstStatus([{ name: 'a', status: 'ok', detail: '' }, { name: 'b', status: 'warn', detail: '' }]), 'warn');
  assert.equal(worstStatus([{ name: 'a', status: 'warn', detail: '' }, { name: 'b', status: 'fail', detail: '' }]), 'fail');
  assert.equal(worstStatus([{ name: 'a', status: 'skip', detail: '' }]), 'ok');
});
