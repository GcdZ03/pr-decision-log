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
  /** The directory it ran in: a leading `cd`, else the session's. Absent on events recorded before this existed. */
  dir?: string;
  /**
   * Files the command wrote, read from its text (events/shell-writes.ts). Paths
   * and assertion counts only: what was written is never stored.
   */
  writes?: CommandWrite[];
};

export type CommandWrite = {
  path: string;
  /** `>>`, `tee -a`, an append-mode open: it can only add. */
  append?: true;
  /** For a heredoc written straight to the file, the assertions in what was written. */
  assertionsAfter?: number;
};

export type EditEvent = {
  kind: 'edit';
  id: string;
  at: string;
  path: string;
  /** Absent when unknowable, e.g. a whole-file Write. Never defaulted to 0. */
  assertionsBefore?: number;
  assertionsAfter?: number;
  /** The edited file's directory, for attributing the edit to a repository. */
  dir?: string;
  /** Written by a shell command rather than an edit tool; expanded from `CommandEvent.writes`. */
  via?: 'shell';
  /** An append: whatever it wrote, it removed nothing. */
  additive?: true;
};

export type TimelineEvent = CommandEvent | EditEvent;
