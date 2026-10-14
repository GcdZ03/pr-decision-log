import { test } from 'node:test';
import assert from 'node:assert/strict';
import { neverRun } from '../src/review/never-run.ts';

test('a changed Dockerfile with no build run is reported', () => {
  assert.deepEqual(neverRun(['services/api/Dockerfile', 'src/a.ts'], ['pnpm test']), [{ check: 'docker build', because: 'a Docker file changed' }]);
  assert.deepEqual(neverRun(['docker-compose.yml'], []), [{ check: 'docker build', because: 'a Docker file changed' }]);
});

test('any docker build form satisfies the rule, wherever it appears in a script', () => {
  for (const c of ['docker build -t x .', 'cd /w && docker compose build web 2>&1 | tail', 'docker buildx build .']) {
    assert.deepEqual(neverRun(['Dockerfile'], [c]), [], c);
  }
});

test('a changed migration with no migrate run is reported, and a migrate run satisfies it', () => {
  const paths = ['services/api/migrations/versions/0004_imports.py'];

  assert.deepEqual(neverRun(paths, ['uv run pytest -q']), [{ check: 'migrations', because: 'a migration changed' }]);
  for (const c of ['uv run alembic upgrade head', 'just migrate', 'python manage.py migrate', 'npx prisma migrate dev']) {
    assert.deepEqual(neverRun(paths, [c]), [], c);
  }
});

test('a Dockerfile only mentioned in a heredoc or an echo is not a build', () => {
  assert.deepEqual(neverRun(['Dockerfile'], ["cat > notes.md <<'EOF'\ndocker build .\nEOF", 'echo "docker build later"']),
    [{ check: 'docker build', because: 'a Docker file changed' }]);
});

test('nothing matching means nothing reported', () => {
  assert.deepEqual(neverRun(['src/a.ts', 'README.md'], []), []);
});

test('documentation files do not trigger docker build or migrations checks', () => {
  assert.deepEqual(neverRun(['docs/migrations/guide.md'], ['pnpm test']), []);
  assert.deepEqual(neverRun(['migrations/README.md'], ['pnpm test']), []);
  assert.deepEqual(neverRun(['Dockerfile.md'], ['pnpm test']), []);
  assert.deepEqual(neverRun(['docs/Dockerfile.example'], ['pnpm test']), []);
  assert.deepEqual(neverRun(['composer.yml'], ['pnpm test']), []);
  assert.deepEqual(neverRun(['composer.json'], ['pnpm test']), []);
});

test('additional docker build forms satisfy the rule', () => {
  for (const c of ['docker compose -f f.yml build', 'docker-compose build web', 'docker compose up --build', 'docker image build .']) {
    assert.deepEqual(neverRun(['Dockerfile'], [c]), [], c);
  }
});

test('additional migration forms satisfy the rule', () => {
  const paths = ['services/api/migrations/versions/0004_imports.py'];

  for (const c of ['docker compose run --rm api alembic upgrade head', 'docker compose exec web python manage.py migrate', './manage.py migrate', 'bin/rails db:migrate', 'pnpm prisma migrate dev', 'alembic -c alembic.ini upgrade head']) {
    assert.deepEqual(neverRun(paths, [c]), [], c);
  }
});
