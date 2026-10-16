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
import { failingTests } from '../events/runner-output.ts';
import { basename } from 'node:path';
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

/** How an episode ended: the check passed, another check failed first, or the timeline ran out. */
type EpisodeEnd = { passed?: CommandEvent; interruptedBy?: CommandEvent };

/**
 * One test file's edits within an episode. Assertion counts are summed over
 * the edits whose counts are known: each edit's count covers only the text it
 * replaced, so comparing the first edit's "before" with the last edit's
 * "after" compares unrelated fragments, and once printed "4 -> 0" for two
 * edits that together added an assertion.
 */
type FileEdits = { first: EditEvent; last: EditEvent; count: number; viaShell: number; before: number; after: number; unknown: number; cosmetic: number };

const plural = (n: number, one: string): string => `${n} ${one}${n === 1 ? '' : 's'}`;

/** The net assertion change, said only as far as it is known. */
function assertionNote(w: FileEdits): string {
  const removed = w.before - w.after;
  if (removed <= 0) return '';
  return w.unknown === 0
    ? ` ${plural(removed, 'assertion')} removed overall.`
    : ` The edits pdl could read removed ${plural(removed, 'assertion')}.`;
}

/** What happened after the test changed, without claiming more than the timeline shows. */
function outcome(refails: CommandEvent[], end: EpisodeEnd): string {
  const last = refails[refails.length - 1];
  const again = !last ? '' : refails.length === 1
    ? `it failed again at ${hhmm(last.at)}`
    : `it failed again ${refails.length} more times, last at ${hhmm(last.at)}`;
  const other = end.interruptedBy ? `\`${summariseCommand(end.interruptedBy.command)}\` failed at ${hhmm(end.interruptedBy.at)}` : '';
  if (end.passed) return again ? `${again}, then passed at ${hhmm(end.passed.at)}` : `it passed at ${hhmm(end.passed.at)}`;
  if (other) return again ? `${again}, and did not pass again before ${other}` : `it did not pass again before ${other}`;
  return again ? `${again}, and has not passed since` : 'it has not passed since';
}

/**
 * One sentence a reviewer can act on: what failed, how the test was changed
 * and how soon, and what happened next. The assertion count is added only
 * when it moved, since an unchanged count says nothing.
 */
/** The failing tests the episode's runs named in this file, in order, each once. */
function testsIn(failures: CommandEvent[], path: string): string[] {
  const names: string[] = [];
  for (const f of failures) {
    for (const t of failingTests(f.output ?? '')) {
      if (t.file && basename(t.file) !== basename(path)) continue;
      if (!names.includes(t.name)) names.push(t.name);
    }
  }
  return names;
}

const namedTests = (names: string[]): string =>
  names.length === 0 ? '' : ` (${names.slice(0, 2).map((n) => `\`${n}\``).join(', ')}${names.length > 2 ? ` +${names.length - 2} more` : ''})`;

function detail(failure: CommandEvent, w: FileEdits, refails: CommandEvent[], end: EpisodeEnd, tests: string[]): string {
  const how = w.viaShell === w.count ? 'from the shell' : w.viaShell === 0 ? 'with the Edit tool' : 'with the Edit tool and from the shell';
  const soon = gap(failure.at, w.first.at);
  const change = w.count === 1
    ? `the test was ${how === 'from the shell' ? 'written from the shell' : `changed ${how}`}${soon ? ` ${soon} later` : ''}`
    : `the test was changed ${w.count} times ${how}${soon ? `, first ${soon} later` : ''}`;
  return `\`${summariseCommand(failure.command)}\` failed at ${hhmm(failure.at)}${namedTests(tests)}; ${change}; ${outcome(refails, end)}.${assertionNote(w)}`;
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

/**
 * Flag test files changed while a test check is failing.
 *
 * An episode runs from a check's first failure until that same check passes.
 * The same check failing again inside it is part of the episode, not a new
 * one: agents iterate, and splitting each attempt into its own flag once
 * produced two bullets for one fix and a false "has not passed since". A
 * different check failing ends the episode, said as such.
 */
export function detectTestEditedAfterFailure(events: TimelineEvent[]): Flag[] {
  const flags: Flag[] = [];
  let openFailure: CommandEvent | null = null;
  let refails: CommandEvent[] = [];
  // Within one episode, collapse repeated edits to the same file into one flag
  // spanning first-seen to last-seen. Counting each edit separately is what
  // inflated the spike's original measurement.
  let window = new Map<string, FileEdits>();

  const emit = (failure: CommandEvent, end: EpisodeEnd) => {
    for (const w of window.values()) {
      if (w.unknown === 0 && isPurelyAdditive(w.before, w.after)) continue;
      if (w.cosmetic === w.count) continue; // Comments only: what the test checks did not change.
      if (w.first.additive && w.last.additive) continue; // Appends only: nothing was taken out.
      const tests = testsIn([failure, ...refails], w.first.path);
      flags.push({
        code: 'TEST_EDITED_AFTER_FAILURE',
        severity: 'warn',
        file: w.first.path,
        detail: detail(failure, w, refails, end, tests),
        evidence: [failure.id, w.first.id],
        ...(tests.length > 0 ? { tests } : {}),
      });
    }
    window = new Map();
    refails = [];
  };

  for (const e of events) {
    if (e.kind === 'command') {
      // Only a test run opens or closes an episode. A failing `sed` or `ls` in
      // the middle says nothing about the tests, and once split one real
      // window into two flags.
      if (classifyCommand(e.command) !== 'test') continue;
      if (e.outcome === 'fail') {
        if (openFailure && sameRun(e, openFailure)) {
          refails.push(e);
          continue;
        }
        if (openFailure) emit(openFailure, { interruptedBy: e });
        openFailure = e;
      } else if (e.outcome === 'pass' && openFailure && sameRun(e, openFailure)) {
        // The episode closes on green: the failure this check reported is resolved.
        emit(openFailure, { passed: e });
        openFailure = null;
      }
    } else if (e.kind === 'edit' && openFailure) {
      // Editing the source file to fix a failure is the desired behaviour. Only
      // an edit to the test itself is worth a reviewer's attention, and only
      // when one of the episode's failures named it.
      if (!isTestFile(e.path)) continue;
      if (![openFailure, ...refails].some((f) => failureNamesFile(f.output ?? '', e.path))) continue;
      const known = e.assertionsBefore !== undefined && e.assertionsAfter !== undefined;
      const w = window.get(e.path) ?? { first: e, last: e, count: 0, viaShell: 0, before: 0, after: 0, unknown: 0, cosmetic: 0 };
      w.last = e;
      w.count += 1;
      w.viaShell += e.via === 'shell' ? 1 : 0;
      w.cosmetic += e.cosmetic ? 1 : 0;
      if (known) { w.before += e.assertionsBefore!; w.after += e.assertionsAfter!; } else w.unknown += 1;
      window.set(e.path, w);
    }
  }

  if (openFailure) emit(openFailure, {});
  return flags;
}
