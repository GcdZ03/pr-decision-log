import { classifyCommand, type CommandKind } from './classify-command.ts';
import type { TimelineEvent } from './types.ts';

const EDIT_TOOLS = new Set(['Edit', 'MultiEdit', 'NotebookEdit']);
const WRITE_TOOLS = new Set(['Write']);

/** Rough assertion counter, deliberately cross-language and shallow. */
const ASSERT_RE = /\b(?:expect\(|assert[._(]|XCTAssert\w*|require\.\w+|t\.(?:Error|Fatal)\w*|Assert\.\w+)/g;

function countAssertions(s: unknown): number {
  if (typeof s !== 'string') return 0;
  return (s.match(ASSERT_RE) ?? []).length;
}

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

  if (tool === 'Bash') {
    const command = str(input['command']) ?? '';
    const classification: CommandKind = classifyCommand(command);

    if (event === 'PostToolUseFailure') {
      const error = str(payload['error']) ?? '';
      return {
        kind: 'command', id, at: recordedAt, command, classification,
        outcome: 'fail', output: error, exitCode: parseExitCode(error), durationMs,
      };
    }

    const response = obj(payload['tool_response']) ?? {};
    const interrupted = response['interrupted'] === true;
    const stdout = str(response['stdout']) ?? '';
    const stderr = str(response['stderr']) ?? '';
    return {
      kind: 'command', id, at: recordedAt, command, classification,
      outcome: interrupted ? 'interrupted' : 'pass',
      output: [stdout, stderr].filter(Boolean).join('\n'),
      durationMs,
    };
  }

  if (EDIT_TOOLS.has(tool ?? '') || WRITE_TOOLS.has(tool ?? '')) {
    const path = str(input['file_path']) ?? str(input['notebook_path']) ?? '';
    if (!path) return null;

    // A Write replaces the whole file, so there is no "before" to count.
    // Reporting 0 would make every Write look like an assertion removal.
    if (WRITE_TOOLS.has(tool ?? '')) {
      return { kind: 'edit', id, at: recordedAt, path };
    }
    const before = input['old_string'];
    const after = input['new_string'];
    if (typeof before !== 'string' || typeof after !== 'string') {
      return { kind: 'edit', id, at: recordedAt, path };
    }
    return {
      kind: 'edit', id, at: recordedAt, path,
      assertionsBefore: countAssertions(before),
      assertionsAfter: countAssertions(after),
    };
  }

  return null;
}
