import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isLockfile, isMigration, riskyFiles } from '../src/review/risky.ts';

test('each category is recognised', () => {
  assert.deepEqual(riskyFiles([
    '.github/workflows/ci.yml', '.github/actions/setup/action.yml', '.gitlab-ci.yml',
    'CODEOWNERS', '.github/CODEOWNERS', 'SECURITY.md',
    'services/api/migrations/versions/0004_imports.py', 'prisma/migrations/2026_init/migration.sql',
    'uv.lock', 'apps/web/pnpm-lock.yaml', 'go.sum',
    '.env', '.env.production', 'certs/server.pem', 'secrets/db.txt',
    'services/api/src/auth.py', 'src/permissions/roles.ts',
  ]), [
    { category: 'CI and automation', paths: ['.github/workflows/ci.yml', '.github/actions/setup/action.yml', '.gitlab-ci.yml'] },
    { category: 'Ownership and policy', paths: ['CODEOWNERS', '.github/CODEOWNERS', 'SECURITY.md'] },
    { category: 'Migrations', paths: ['services/api/migrations/versions/0004_imports.py', 'prisma/migrations/2026_init/migration.sql'] },
    { category: 'Dependencies', paths: ['uv.lock', 'apps/web/pnpm-lock.yaml', 'go.sum'] },
    { category: 'Secrets and environment', paths: ['.env', '.env.production', 'certs/server.pem', 'secrets/db.txt'] },
    { category: 'Auth', paths: ['services/api/src/auth.py', 'src/permissions/roles.ts'] },
  ]);
});

test('ordinary files, example env files and look-alike names are not risky', () => {
  assert.deepEqual(riskyFiles(['src/app.ts', '.env.example', '.env.sample', 'docs/authoring.md', 'src/author.ts', 'package.json']), []);
});

test('a path is listed under its first matching category only', () => {
  assert.deepEqual(riskyFiles(['auth/migrations/0001.py']), [{ category: 'Migrations', paths: ['auth/migrations/0001.py'] }]);
});

test('lockfiles and migrations are recognised on their own', () => {
  assert.equal(isLockfile('a/b/package-lock.json'), true);
  assert.equal(isLockfile('package.json'), false);
  assert.equal(isMigration('db/migrate/20260101_add.rb'), true);
  assert.equal(isMigration('src/migrate.ts'), false);
});
