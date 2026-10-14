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
