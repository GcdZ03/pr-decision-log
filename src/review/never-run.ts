import { commandSegments, runsKind } from '../events/command-text.ts';
import { isMigration } from './risky.ts';

export type NeverRun = { check: string; because: string };

type Rule = { check: string; because: string; touches: (path: string) => boolean; satisfiedBy: RegExp };

const DOCKER_FILE = /(^|\/)(?:Dockerfile[^/]*|[^/]+\.dockerfile|docker-compose[^/]*\.ya?ml|compose[^/]*\.ya?ml)$/i;

/** Check if a path is a Docker file, excluding documentation and composer.* files. */
function isDockerFile(path: string): boolean {
  if (!/\.(?:md|txt|rst|example|sample)$/.test(path) === false) return false;
  if (/composer\.\w+$/.test(path)) return false;
  return DOCKER_FILE.test(path);
}

/**
 * A change whose own check never ran. Deliberately few: each rule is a claim
 * that a reviewer would otherwise have to find for themselves, and a wrong
 * one at the top of the log costs more than a missing one.
 */
export const NEVER_RUN_RULES: readonly Rule[] = [
  {
    check: 'docker build', because: 'a Docker file changed',
    touches: isDockerFile,
    satisfiedBy: /docker(?:-compose|\s+compose)?(?:\s+-\S+(?:\s+[^\s-]\S*)?)*\s+(?:image\s+|buildx\s+)?build\b|docker(?:-compose|\s+compose)(?:\s+-\S+(?:\s+[^\s-]\S*)?)*\s+up\b.*--build/,
  },
  {
    check: 'migrations', because: 'a migration changed',
    touches: isMigration,
    satisfiedBy: /(?:alembic(?:\s+-\S+(?:\s+[^\s-]\S*)?)*\s+)?upgrade\b|(?:python3?\s+)?(?:\.\/)?(?:bin\/)?manage\.py\s+migrate\b|(?:bin\/)?rails\s+db:migrate\b|(?:pnpm\s+)?prisma\s+migrate\b|(?:just|make)\s+migrate\b|docker\s+compose\s+(?:run|exec)(?:\s+-\S+(?:\s+[^\s-]\S*)?)*\s+\S+\s+(?:alembic(?:\s+-\S+(?:\s+[^\s-]\S*)?)*\s+)?upgrade\b|docker\s+compose\s+(?:run|exec)(?:\s+-\S+(?:\s+[^\s-]\S*)?)*\s+\S+\s+(?:python3?\s+)?(?:\.\/)?(?:bin\/)?manage\.py\s+migrate\b|docker\s+compose\s+(?:run|exec)(?:\s+-\S+(?:\s+[^\s-]\S*)?)*\s+\S+\s+(?:bin\/)?rails\s+db:migrate\b/,
  },
];

/** `paths`: the PR's changed files that still exist. `commands`: every command text the sessions ran. */
export function neverRun(paths: string[], commands: string[]): NeverRun[] {
  const segments = commands.flatMap(commandSegments);
  return NEVER_RUN_RULES
    .filter((r) => paths.some(r.touches) && !segments.some((s) => runsKind(s, r.satisfiedBy)))
    .map(({ check, because }) => ({ check, because }));
}
