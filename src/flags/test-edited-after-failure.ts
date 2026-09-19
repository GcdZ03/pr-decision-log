import type {
  CommandEvent,
  EditEvent,
  TimelineEvent,
} from '../events/types.ts';

export type { CommandEvent, EditEvent, Outcome, TimelineEvent } from '../events/types.ts';

export type Flag = {
  code: 'TEST_EDITED_AFTER_FAILURE';
  severity: 'warn';
  file: string;
  detail: string;
  evidence: string[];
};

const RUNNER =
  /\b(npm|pnpm|yarn|bun)\s+(run\s+)?\S|vitest|jest|pytest|go\s+test|swift\s+test|cargo\s+test|xcodebuild|node\s+--test|rspec|phpunit|dotnet\s+test|gradle|mvn\b/;

// Lines that merely mention a runner (banner echoes, comments) are not invocations.
const NOT_RUNNER = /^\s*(#|echo\b|printf\b)/;

const TEST_DIR = /(^|\/)(tests?|spec|__tests__)\//i;
const TEST_FILE = /\.(test|spec)\.[cm]?[tj]sx?$|_test\.(go|py|rb)$|(^|\/)test_[^/]+\.py$|Tests?\.swift$|Test\.java$/;

/**
 * Editing the source file to fix a failure is the desired behaviour. Only an
 * edit to the test itself is worth a reviewer's attention.
 */
function isTestFile(path: string): boolean {
  return TEST_DIR.test(path) || TEST_FILE.test(path);
}

/**
 * The failing output must actually implicate the edited file. A failure in an
 * unrelated suite is not evidence that this edit was a shortcut.
 */
function failureNamesFile(output: string, path: string): boolean {
  if (!output) return false;
  if (output.includes(path)) return true;
  const base = path.split('/').pop();
  return base ? output.includes(base) : false;
}

/**
 * Adding test cases while fixing a failure is good practice, not a shortcut.
 * Only a non-increasing assertion count is suspicious. When the counts are
 * unknown we do NOT suppress: we cannot prove the edit was additive, and the
 * flag is advisory rather than accusatory.
 */
function isPurelyAdditive(before?: number, after?: number): boolean {
  if (before === undefined || after === undefined) return false;
  return after > before;
}

/**
 * Real commands in a session are frequently whole shell scripts: multi-line,
 * with absolute paths, exported tokens and heredocs. DESIGN section 9 forbids
 * putting those in a PR body. Reduce the command to a recognisable runner
 * fragment: first line only, leading `cd ... &&` stripped, hard length cap.
 */
export function summariseCommand(command: string, max = 80): string {
  const lines = command.split('\n').map((l) => l.trim()).filter(Boolean);
  // Prefer the line that actually invokes a runner; a script's first line is
  // usually `cd <absolute path>`, which is both useless and a path leak.
  const runnerLine = lines.find((l) => RUNNER.test(l) && !NOT_RUNNER.test(l));
  const chosen = runnerLine ?? lines[0] ?? '';
  const withoutCd = chosen.replace(/^cd\s+\S+\s*&&\s*/, '').trim();
  const base = withoutCd || chosen;
  if (base.length <= max) return base;
  return `${base.slice(0, max - 1)}\u2026`;
}

function detail(failure: CommandEvent, first: EditEvent, last: EditEvent): string {
  const counts =
    first.assertionsBefore !== undefined && last.assertionsAfter !== undefined
      ? `; assertion count ${first.assertionsBefore} -> ${last.assertionsAfter}`
      : '';
  const when = first.id === last.id ? `at ${first.at}` : `${first.at}-${last.at}`;
  return `Edited ${when}, after \`${summariseCommand(failure.command)}\` failed at ${failure.at} and before it passed again${counts}.`;
}

export function detectTestEditedAfterFailure(events: TimelineEvent[]): Flag[] {
  const flags: Flag[] = [];
  let openFailure: CommandEvent | null = null;
  // Within one window, collapse repeated edits to the same file into one flag
  // spanning first-seen to last-seen. Counting each edit separately is what
  // inflated the spike's original measurement.
  let window = new Map<string, { first: EditEvent; last: EditEvent }>();

  const emit = (failure: CommandEvent) => {
    for (const { first, last } of window.values()) {
      if (isPurelyAdditive(first.assertionsBefore, last.assertionsAfter)) continue;
      flags.push({
        code: 'TEST_EDITED_AFTER_FAILURE',
        severity: 'warn',
        file: first.path,
        detail: detail(failure, first, last),
        evidence: [failure.id, first.id],
      });
    }
    window = new Map();
  };

  for (const e of events) {
    if (e.kind === 'command') {
      if (e.outcome === 'fail') {
        if (openFailure) emit(openFailure);
        openFailure = e;
      } else if (e.outcome === 'pass' && openFailure && e.command === openFailure.command) {
        // The window closes on green: the failure this command reported is resolved.
        emit(openFailure);
        openFailure = null;
      }
    } else if (e.kind === 'edit' && openFailure) {
      if (!isTestFile(e.path)) continue;
      if (!failureNamesFile(openFailure.output ?? '', e.path)) continue;
      const seen = window.get(e.path);
      if (seen) seen.last = e;
      else window.set(e.path, { first: e, last: e });
    }
  }

  if (openFailure) emit(openFailure);
  return flags;
}
