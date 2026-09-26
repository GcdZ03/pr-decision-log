import { test } from 'node:test';
import assert from 'node:assert/strict';
import { redact, compileExtraPatterns } from '../src/render/redact.ts';

test('redacts GitHub tokens of every prefix', () => {
  for (const t of ['ghp_', 'gho_', 'ghu_', 'ghs_', 'ghr_']) {
    const secret = `${t}${'a1B2c3D4e5'.repeat(4)}`;
    const { text, hits } = redact(`token is ${secret} ok`);
    assert.ok(!text.includes(secret), `leaked ${t}`);
    assert.equal(hits.length, 1);
  }
});

test('redacts a github_pat token', () => {
  const secret = `github_pat_${'A1b2C3d4E5'.repeat(8)}`;
  assert.ok(!redact(secret).text.includes(secret));
});

test('redacts AWS access keys and Slack and Stripe tokens', () => {
  const cases = ['AKIAIOSFODNN7EXAMPLE', 'xoxb-123456789012-abcdefghijklmnop', 'sk_live_abcdefghijklmnopqrstuvwx'];
  for (const secret of cases) {
    const { text } = redact(`value=${secret}`);
    assert.ok(!text.includes(secret), `leaked ${secret}`);
  }
});

test('redacts secret-shaped env assignments but keeps the key name', () => {
  const { text } = redact('export API_TOKEN=hunter2supersecretvalue');
  assert.ok(!text.includes('hunter2supersecretvalue'));
  assert.ok(text.includes('API_TOKEN'), 'the key name is useful context and is not a secret');
});

test('redacts credentials embedded in a URL', () => {
  const { text } = redact('cloning https://gerald:s3cr3tpassword@github.com/x/y.git');
  assert.ok(!text.includes('s3cr3tpassword'));
  assert.ok(text.includes('github.com/x/y.git'), 'the host and path stay readable');
});

test('redacts a PEM private key block', () => {
  const pem = '-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA\n-----END RSA PRIVATE KEY-----';
  assert.ok(!redact(pem).text.includes('MIIEpAIBAAKCAQEA'));
});

test('leaves ordinary prose untouched', () => {
  const prose = 'Retry at the job level because the client is shared with interactive requests.';
  const { text, hits } = redact(prose);
  assert.equal(text, prose);
  assert.deepEqual(hits, []);
});

test('does not redact a git SHA or a normal identifier', () => {
  // 40-char hex looks high-entropy but is public and useful.
  const sha = '9f3c2ab1d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9';
  assert.equal(redact(`head is ${sha}`).text, `head is ${sha}`);
  assert.equal(redact('src/jobs/sync.test.ts').text, 'src/jobs/sync.test.ts');
});

test('reports which rules fired, for the redaction summary', () => {
  const { hits } = redact(`ghp_${'a1B2c3D4e5'.repeat(4)} and AKIAIOSFODNN7EXAMPLE`);
  assert.equal(hits.length, 2);
  assert.ok(hits.includes('github_token'));
  assert.ok(hits.includes('aws_access_key'));
});

test('a configured extra pattern is redacted and named in the hits', () => {
  const extra = compileExtraPatterns(['INTERNAL-[A-Z0-9]{8}']);
  const { text, hits } = redact('ticket INTERNAL-AB12CD34 fixed', extra);

  assert.ok(!text.includes('INTERNAL-AB12CD34'));
  assert.deepEqual(hits, ['custom_1']);
});

test('extra patterns add to the built-in rules rather than replacing them', () => {
  const { text } = redact('AKIAIOSFODNN7EXAMPLE', compileExtraPatterns(['NOPE']));

  assert.ok(!text.includes('AKIAIOSFODNN7EXAMPLE'));
});
