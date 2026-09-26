const TEST_DIR = /(^|\/)(tests?|spec|__tests__)\//i;
const TEST_FILE = /\.(test|spec)\.[cm]?[tj]sx?$|_test\.(go|py|rb)$|(^|\/)test_[^/]+\.py$|Tests?\.swift$|Test\.java$/;

/**
 * Whether a path is a test rather than code under test.
 *
 * One definition for every rule: the timeline detector, the change summary and
 * the diff analysers must agree on what a test is, or the same file can be
 * flagged by one and counted as source by another.
 */
export function isTestFile(path: string): boolean {
  return TEST_DIR.test(path) || TEST_FILE.test(path);
}
