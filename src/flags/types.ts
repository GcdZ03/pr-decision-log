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
};
