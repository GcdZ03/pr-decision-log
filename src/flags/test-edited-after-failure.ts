import type {
  CommandEvent,
  EditEvent,
  TimelineEvent,
} from '../events/types.ts';

export type { CommandEvent, EditEvent, Outcome, TimelineEvent } from '../events/types.ts';
export type { Flag, FlagCode } from './types.ts';

import type { Flag } from './types.ts';
import { isTestFile } from './test-files.ts';
import { runnerFragment } from '../events/command-text.ts';
import { classifyCommand } from '../events/classify-command.ts';


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
 * with absolute paths, exported tokens and heredocs full of file contents.
 * DESIGN section 9 forbids putting those in a PR body, so only the runner
 * fragment is ever published (see events/command-text.ts), and a command that
 * ran no runner is named by its kind alone.
 */
export function summariseCommand(command: string): string {
  return runnerFragment(command) ?? `(${classifyCommand(command)} command)`;
}

function detail(failure: CommandEvent, first: EditEvent, last: EditEvent): string {
  // The count covers only the edited fragment, so an unchanged one says
  // nothing and "0 -> 0" reads as an empty test. Shown only when it moved.
  const counts =
    first.assertionsBefore !== undefined &&
    last.assertionsAfter !== undefined &&
    first.assertionsBefore !== last.assertionsAfter
      ? `; assertion count ${first.assertionsBefore} -> ${last.assertionsAfter}`
      : '';
  const when = first.id === last.id ? `at ${first.at}` : `${first.at}-${last.at}`;
  return `Edited ${when}, after \`${summariseCommand(failure.command)}\` failed at ${failure.at} and before it passed again${counts}.`;
}

/**
 * Whether a passing command re-ran the failing one. Agents pipe the same run
 * differently each time (`pnpm test | tail`, then `pnpm test`), so the runner
 * fragment decides, not the exact text.
 */
function sameRun(a: CommandEvent, b: CommandEvent): boolean {
  if (a.command === b.command) return true;
  const fragment = runnerFragment(a.command);
  return fragment !== undefined && fragment === runnerFragment(b.command);
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
      if (first.additive && last.additive) continue; // Appends only: nothing was taken out.
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
      // Only a test run opens or closes a window. A failing `sed` or `ls` in
      // the middle says nothing about the tests, and once split one real
      // window into two flags.
      if (classifyCommand(e.command) !== 'test') continue;
      if (e.outcome === 'fail') {
        if (openFailure) emit(openFailure);
        openFailure = e;
      } else if (e.outcome === 'pass' && openFailure && sameRun(e, openFailure)) {
        // The window closes on green: the failure this command reported is resolved.
        emit(openFailure);
        openFailure = null;
      }
    } else if (e.kind === 'edit' && openFailure) {
      // Editing the source file to fix a failure is the desired behaviour. Only
      // an edit to the test itself is worth a reviewer's attention.
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
