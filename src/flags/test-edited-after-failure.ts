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

const hhmm = (at: string): string => /T(\d{2}:\d{2})/.exec(at)?.[1] ?? at;

function gap(from: string, to: string): string {
  const s = Math.round((Date.parse(to) - Date.parse(from)) / 1000);
  if (!Number.isFinite(s) || s < 0) return '';
  if (s < 60) return `${s} s`;
  if (s < 3600) return `${Math.round(s / 60)} min`;
  return `${Math.round(s / 3600)} h`;
}

/**
 * One sentence a reviewer can act on: what failed, how the test was changed
 * and how soon, and whether the failure was resolved. The assertion count is
 * added only when it moved, since an unchanged count says nothing.
 */
function detail(failure: CommandEvent, w: { first: EditEvent; last: EditEvent; count: number; viaShell: number }, passed?: CommandEvent): string {
  const how = w.viaShell === w.count ? 'from the shell' : w.viaShell === 0 ? 'with the Edit tool' : 'with the Edit tool and from the shell';
  const soon = gap(failure.at, w.first.at);
  const change = w.count === 1
    ? `the test was ${how === 'from the shell' ? 'written from the shell' : `changed ${how}`}${soon ? ` ${soon} later` : ''}`
    : `the test was changed ${w.count} times ${how}${soon ? `, first ${soon} later` : ''}`;
  const after = passed ? `it passed at ${hhmm(passed.at)}` : 'it has not passed since';
  const counts =
    w.first.assertionsBefore !== undefined && w.last.assertionsAfter !== undefined && w.first.assertionsBefore !== w.last.assertionsAfter
      ? ` Assertion count ${w.first.assertionsBefore} -> ${w.last.assertionsAfter}.`
      : '';
  return `\`${summariseCommand(failure.command)}\` failed at ${hhmm(failure.at)}; ${change}; ${after}.${counts}`;
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
  let window = new Map<string, { first: EditEvent; last: EditEvent; count: number; viaShell: number }>();

  const emit = (failure: CommandEvent, passed?: CommandEvent) => {
    for (const w of window.values()) {
      if (isPurelyAdditive(w.first.assertionsBefore, w.last.assertionsAfter)) continue;
      if (w.first.additive && w.last.additive) continue; // Appends only: nothing was taken out.
      flags.push({
        code: 'TEST_EDITED_AFTER_FAILURE',
        severity: 'warn',
        file: w.first.path,
        detail: detail(failure, w, passed),
        evidence: [failure.id, w.first.id],
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
        emit(openFailure, e);
        openFailure = null;
      }
    } else if (e.kind === 'edit' && openFailure) {
      // Editing the source file to fix a failure is the desired behaviour. Only
      // an edit to the test itself is worth a reviewer's attention.
      if (!isTestFile(e.path)) continue;
      if (!failureNamesFile(openFailure.output ?? '', e.path)) continue;
      const seen = window.get(e.path);
      const shell = e.via === 'shell' ? 1 : 0;
      if (seen) { seen.last = e; seen.count += 1; seen.viaShell += shell; }
      else window.set(e.path, { first: e, last: e, count: 1, viaShell: shell });
    }
  }

  if (openFailure) emit(openFailure);
  return flags;
}
