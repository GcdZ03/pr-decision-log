import { readFileSync } from 'node:fs';

export type ContentBlock = {
  type: string;
  text?: string;
  name?: string;
  id?: string;
  input?: Record<string, unknown>;
  tool_use_id?: string;
  content?: unknown;
};

export type TranscriptEntry = {
  type: string;
  timestamp?: string;
  requestId?: string;
  uuid?: string;
  isSidechain?: boolean;
  gitBranch?: string;
  message?: { role?: string; content?: unknown };
};

export type ToolUse = { id: string; name: string; input: Record<string, unknown> };

const blocks = (entry: TranscriptEntry): ContentBlock[] => {
  const c = entry.message?.content;
  return Array.isArray(c) ? (c as ContentBlock[]).filter((b) => typeof b === 'object' && b !== null) : [];
};

/**
 * Read a session transcript.
 *
 * The transcript is the only place assistant text lives: hook payloads carry
 * tool inputs and results, never what the model said between them. It is read
 * best-effort, since a session that is still running has a partial last line
 * and publishing must not depend on the file being well-formed.
 *
 * Sidechain entries belong to subagents. A subagent's reasoning is not this
 * session's, so it is dropped here rather than filtered at every call site.
 */
export function readTranscript(path: string): TranscriptEntry[] {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return [];
  }

  const entries: TranscriptEntry[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line) as TranscriptEntry;
      if (entry.isSidechain === true) continue;
      entries.push(entry);
    } catch {
      // Partial trailing line from a live session.
    }
  }
  return entries;
}

export function toolUses(entry: TranscriptEntry): ToolUse[] {
  return blocks(entry)
    .filter((b) => b.type === 'tool_use' && typeof b.name === 'string')
    .map((b) => ({ id: b.id ?? '', name: b.name as string, input: b.input ?? {} }));
}

/** Visible assistant prose. Thinking blocks are stored empty on disk, so they contribute nothing. */
export function assistantText(entry: TranscriptEntry): string {
  return blocks(entry)
    .filter((b) => b.type === 'text' && typeof b.text === 'string' && b.text.trim() !== '')
    .map((b) => (b.text as string).trim())
    .join('\n');
}

/** Tool results, which arrive on the following user entry. */
export function toolResults(entry: TranscriptEntry): { id: string; text: string }[] {
  return blocks(entry)
    .filter((b) => b.type === 'tool_result' && typeof b.tool_use_id === 'string')
    .map((b) => ({
      id: b.tool_use_id as string,
      text: typeof b.content === 'string'
        ? b.content
        : Array.isArray(b.content)
          ? (b.content as ContentBlock[]).map((c) => c.text ?? '').join('\n')
          : '',
    }));
}
