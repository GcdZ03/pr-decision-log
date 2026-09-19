import type { CommandKind } from './classify-command.ts';

export type Outcome = 'pass' | 'fail' | 'interrupted' | 'unknown';

export type CommandEvent = {
  kind: 'command';
  id: string;
  at: string;
  command: string;
  classification: CommandKind;
  outcome: Outcome;
  /** Combined stdout/stderr on success, or the raw `error` string on failure. Local only, never rendered. */
  output?: string;
  /** Parsed from a leading `Exit code N`; only present on failures. */
  exitCode?: number;
  durationMs?: number;
};

export type EditEvent = {
  kind: 'edit';
  id: string;
  at: string;
  path: string;
  /** Absent when unknowable, e.g. a whole-file Write. Never defaulted to 0. */
  assertionsBefore?: number;
  assertionsAfter?: number;
};

export type TimelineEvent = CommandEvent | EditEvent;
