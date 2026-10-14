import { commandSegments, runsKind } from '../events/command-text.ts';
import { isMigration } from './risky.ts';

export type NeverRun = { check: string; because: string };

type Rule = { check: string; because: string; touches: (path: string) => boolean; satisfiedBy: RegExp };

const DOCKER_FILE = /(^|\/)(?:Dockerfile[^/]*|[^/]+\.dockerfile|docker-compose[^/]*\.ya?ml|compose[^/]*\.ya?ml)$/i;

/**
 * A change whose own check never ran. Deliberately few: each rule is a claim
 * that a reviewer would otherwise have to find for themselves, and a wrong
 * one at the top of the log costs more than a missing one.
 */
export const NEVER_RUN_RULES: readonly Rule[] = [
  {
    check: 'docker build', because: 'a Docker file changed',
    touches: (p) => DOCKER_FILE.test(p),
    satisfiedBy: /docker\s+(?:compose\s+|buildx\s+)?build\b/,
  },
  {
    check: 'migrations', because: 'a migration changed',
    touches: isMigration,
    satisfiedBy: /(?:alembic\s+upgrade|prisma\s+migrate|rails\s+db:migrate|(?:python3?\s+)?manage\.py\s+migrate|(?:just|make)\s+migrate)\b/,
  },
];

/** `paths`: the PR's changed files that still exist. `commands`: every command text the sessions ran. */
export function neverRun(paths: string[], commands: string[]): NeverRun[] {
  const segments = commands.flatMap(commandSegments);
  return NEVER_RUN_RULES
    .filter((r) => paths.some(r.touches) && !segments.some((s) => runsKind(s, r.satisfiedBy)))
    .map(({ check, because }) => ({ check, because }));
}
