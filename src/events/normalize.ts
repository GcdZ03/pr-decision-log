import { classifyCommand, type CommandKind } from './classify-command.ts';
import type { TimelineEvent } from './types.ts';
import { countAssertions } from '../flags/assertions.ts';
import { exitStatusMaskable, outputShowsFailure } from './runner-output.ts';
import { commandDir } from './location.ts';
import { dirname, isAbsolute } from 'node:path';

const EDIT_TOOLS = new Set(['Edit', 'MultiEdit', 'NotebookEdit']);
const WRITE_TOOLS = new Set(['Write']);


/**
 * Bash failures arrive as a string whose first line is `Exit code N`. The docs
 * warn to key on that line only and treat the rest as display text.
 */
export function parseExitCode(error: unknown): number | undefined {
  if (typeof error !== 'string') return undefined;
  const m = /^Exit code (\d+)/m.exec(error);
  return m?.[1] !== undefined ? Number(m[1]) : undefined;
}

type Payload = Record<string, unknown>;

const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
const obj = (v: unknown): Payload | undefined =>
  typeof v === 'object' && v !== null ? (v as Payload) : undefined;

/**
 * Turn one hook payload into a timeline event, or null when the payload is not
 * something the log records.
 *
 * Only settled events are recorded. `PreToolUse` fires before an outcome
 * exists, so it is dropped; the matching `PostToolUse` or `PostToolUseFailure`
 * carries the same `tool_use_id` and the result.
 */
export function normalize(payload: Payload, recordedAt: string): TimelineEvent | null {
  const event = str(payload['hook_event_name']);
  const tool = str(payload['tool_name']);
  const id = str(payload['tool_use_id']) ?? '';
  const input = obj(payload['tool_input']) ?? {};
  const durationMs = typeof payload['duration_ms'] === 'number' ? (payload['duration_ms'] as number) : undefined;

  if (event !== 'PostToolUse' && event !== 'PostToolUseFailure') return null;
  const cwd = str(payload['cwd']);

  if (tool === 'Bash') {
    const command = str(input['command']) ?? '';
    const classification: CommandKind = classifyCommand(command);
    // Where it ran, for attributing it to a repository and branch at the end
    // of the turn; see events/location.ts.
    const dir = cwd ? { dir: commandDir(command, cwd) } : {};

    if (event === 'PostToolUseFailure') {
      const error = str(payload['error']) ?? '';
      return {
        kind: 'command', id, at: recordedAt, command, classification,
        outcome: 'fail', output: error, exitCode: parseExitCode(error), durationMs, ...dir,
      };
    }

    const response = obj(payload['tool_response']) ?? {};
    const interrupted = response['interrupted'] === true;
    const stdout = str(response['stdout']) ?? '';
    const stderr = str(response['stderr']) ?? '';
    const output = [stdout, stderr].filter(Boolean).join('\n');

    // Bash reports success whenever the shell exited 0, and `npm test | tail`
    // exits 0 however the tests went. Recording that as a pass silently
    // disabled TEST_EDITED_AFTER_FAILURE for the most common way agents run
    // tests, so a masked test run is re-read from its own output.
    const masked = classification === 'test' && exitStatusMaskable(command) && outputShowsFailure(output);

    return {
      kind: 'command', id, at: recordedAt, command, classification,
      outcome: interrupted ? 'interrupted' : masked ? 'fail' : 'pass',
      output,
      durationMs,
      ...dir,
    };
  }

  if (EDIT_TOOLS.has(tool ?? '') || WRITE_TOOLS.has(tool ?? '')) {
    const path = str(input['file_path']) ?? str(input['notebook_path']) ?? '';
    if (!path) return null;
    const dir = isAbsolute(path) ? { dir: dirname(path) } : {};

    // A Write replaces the whole file, so there is no "before" to count.
    // Reporting 0 would make every Write look like an assertion removal.
    if (WRITE_TOOLS.has(tool ?? '')) {
      return { kind: 'edit', id, at: recordedAt, path, ...dir };
    }
    const before = input['old_string'];
    const after = input['new_string'];
    if (typeof before !== 'string' || typeof after !== 'string') {
      return { kind: 'edit', id, at: recordedAt, path, ...dir };
    }
    return {
      kind: 'edit', id, at: recordedAt, path, ...dir,
      assertionsBefore: countAssertions(before),
      assertionsAfter: countAssertions(after),
    };
  }

  return null;
}
