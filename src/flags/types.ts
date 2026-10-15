/** Flag codes the log can carry. Advisory, never a merge gate (DESIGN section 8). */
export type FlagCode =
  | 'TEST_EDITED_AFTER_FAILURE'
  | 'NO_TEST_RUN'
  | 'TEST_ONLY_CHANGE'
  | 'ASSERTIONS_REMOVED'
  | 'TEST_SKIPPED'
  | 'TEST_DELETED'
  | 'EXPECTATION_LOOSENED';

export type Flag = {
  code: FlagCode;
  /** Never `error`: a false accusation costs more than a miss (DESIGN section 11). */
  severity: 'warn' | 'info';
  file: string;
  detail: string;
  /** Tool-use ids a reviewer could trace back. */
  evidence: string[];
  /** For a test-edit flag: the failing tests the runner named in this file. */
  tests?: string[];
  /** For a test-edit flag: whether those tests were added by this PR or already existed (from the diff); `mixed` lists each. */
  origin?: 'added' | 'existing' | 'mixed';
  /** For a `mixed` origin: each named test and where it came from. */
  testOrigins?: { name: string; origin: 'added' | 'existing' }[];
};
