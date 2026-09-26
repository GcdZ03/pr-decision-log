import { assistantText, toolResults, toolUses, type TranscriptEntry } from './transcript.ts';

export type DecisionSource = 'human-answer' | 'plan' | 'stated';
export type Confidence = 'confirmed_by_human' | 'stated';
export type DecisionKind = 'decision' | 'assumption' | 'open_item';

export type Decision = {
  text: string;
  kind: DecisionKind;
  source: DecisionSource;
  confidence: Confidence;
  at?: string;
};

/**
 * Markers from DESIGN section 10, grouped by what they signal.
 *
 * Word-boundary anchored, so `rechosen` does not match `chose`. Measured
 * yield on 881 real edits was 3%, so this rule is high precision and
 * near-zero recall by design: it is rendered when it fires and never padded.
 */
const MARKERS: { kind: DecisionKind; re: RegExp }[] = [
  // First person only. "the spike assumed X" reports what someone else did
  // and is an ordinary statement, not an assumption this session is making.
  { kind: 'assumption', re: /(?:^|\W)(?:assuming\b|(?:I|we)\s+(?:am\s+|are\s+)?assum\w*|(?:my|our|the)\s+assumption\b)/i },
  { kind: 'open_item', re: /\b(?:TODO|left (?:out|unfinished)|not addressed)\b/i },
  { kind: 'decision', re: /\b(?:because|instead of|rather than|chose|decided|trade-?off)\b/i },
];

/**
 * Sentences that carry a rationale marker but describe the agent's own
 * workflow rather than a choice about the code.
 *
 * Measured on the author's transcripts, these were the majority of rule 3's
 * output once the same-turn lookback raised recall, which is why the design
 * doc's "high precision" note no longer holds unqualified. The recurring
 * shape is a marker used rhetorically against an epistemic act: "verify X
 * rather than guess", "checked rather than asserted". A reviewer learns
 * nothing from either.
 */
const NARRATION: RegExp[] = [
  /\blet(?:'s|\s+me|\s+us)\b/i,
  /\bI(?:'ve|\s+have)?\s+just\s+(?:verified|checked|confirmed|tested)\b/i,
  /^(?:first|now|next|then)\b[^.]{0,40}\b(?:verif|check|confirm)/i,
  /^verifying\b/i,
  /^(?:red|green)\b[^.]{0,30}[\u2014-]/i,
  /\b(?:rather than|instead of)\s+(?:my own\s+)?(?:guess|assert|assum|trust|claim|check|verif|memor)/i,
];

const isNarration = (s: string): boolean => NARRATION.some((re) => re.test(s));

/** Tools that change the repository. Rationale before a read explains nothing that shipped. */
const CHANGING_TOOLS = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit', 'Bash']);

const MAX_SENTENCE = 320;
const MAX_STATED = 5;

function sentences(text: string): string[] {
  return text
    .split('\n')
    .flatMap((line) => line.split(/(?<=[.!?])\s+/))
    .map((s) => s.trim())
    .filter((s) => s !== '');
}

/** Emphasis is authoring syntax, not content, and renders as literal asterisks once re-nested. */
function stripEmphasis(s: string): string {
  return s.replace(/\*\*(.+?)\*\*/g, '$1').replace(/(^|\s)\*(\S(?:.*?\S)?)\*(?=\s|$)/g, '$1$2');
}

function truncate(s: string): string {
  return s.length <= MAX_SENTENCE ? s : `${s.slice(0, MAX_SENTENCE - 1).trimEnd()}\u2026`;
}

/**
 * Rule 3: visible rationale stated just before something changed.
 *
 * Only the sentence carrying the marker is kept. The surrounding block is
 * narration of what the agent is about to do, which is not a decision and
 * would bulk out the PR body for no reader benefit.
 */
/**
 * A configured marker as a regex. Word boundaries apply only at edges that are
 * word characters, so `Decision:` still matches before a space and `Rejected`
 * does not match inside `rejectedness`.
 */
function markerRe(marker: string): RegExp {
  const esc = marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const lead = /^\w/.test(marker) ? '(?<!\\w)' : '';
  const trail = /\w$/.test(marker) ? '(?!\\w)' : '';
  return new RegExp(`${lead}${esc}${trail}`, 'i');
}

function fromStatedRationale(entries: TranscriptEntry[], markers: typeof MARKERS): Decision[] {
  const out: Decision[] = [];
  const seen = new Set<string>();

  for (const [i, entry] of entries.entries()) {
    if (!toolUses(entry).some((u) => CHANGING_TOOLS.has(u.name))) continue;

    // The agent usually emits its prose and its tool call as two entries of
    // one turn, so text on the entry itself is the exception rather than the
    // rule. Measuring found this rule yielding literally nothing until the
    // lookback was added. `requestId` bounds it: prose from an earlier turn
    // explains an earlier change, not this one.
    let text = assistantText(entry);
    for (let j = i - 1; j >= 0 && !text; j--) {
      const prev = entries[j];
      if (!prev || prev.type !== 'assistant' || prev.requestId !== entry.requestId) break;
      text = assistantText(prev);
    }
    if (!text) continue;

    for (const sentence of sentences(text)) {
      const hit = markers.find((m) => m.re.test(sentence));
      if (!hit) continue;
      if (isNarration(sentence)) continue;

      const clipped = truncate(stripEmphasis(sentence));
      const key = clipped.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);

      out.push({ text: clipped, kind: hit.kind, source: 'stated', confidence: 'stated', at: entry.timestamp });
      if (out.length >= MAX_STATED) return out;
    }
  }

  return out;
}

type Question = { question: string; header?: string };

function questionsOf(input: Record<string, unknown>): Question[] {
  const qs = input['questions'];
  if (!Array.isArray(qs)) return [];
  return qs
    .filter((q): q is Record<string, unknown> => typeof q === 'object' && q !== null)
    .map((q) => ({
      question: typeof q['question'] === 'string' ? q['question'] : '',
      header: typeof q['header'] === 'string' ? q['header'] : undefined,
    }))
    .filter((q) => q.question !== '');
}

/**
 * Pull one question's answer out of the result string.
 *
 * The result is prose of the form `"<question>"="<answer>"`, so the answer is
 * located by its own question rather than by splitting on commas: an answer
 * may itself contain a comma, and splitting would turn one decision into two.
 */
function answerFor(result: string, question: string): string | undefined {
  const needle = `"${question}"="`;
  const start = result.indexOf(needle);
  if (start === -1) return undefined;

  const from = start + needle.length;
  const end = result.indexOf('"', from);
  if (end === -1) return undefined;

  // `(Recommended)` is guidance attached to the option at question time, not
  // part of what was chosen, and it reads as noise in a PR body.
  const answer = result.slice(from, end).replace(/\s*\(Recommended\)\s*$/i, '').trim();
  return answer === '' ? undefined : answer;
}

/**
 * Rule 1 from DESIGN section 10, and the most reliable one: a question the
 * human actually answered. Everything else in this file is the model's own
 * account of its reasoning; this is the only source where a person committed
 * to something, so it is the only one marked `confirmed_by_human`.
 */
function fromQuestions(entries: TranscriptEntry[]): Decision[] {
  const asked = new Map<string, { questions: Question[]; at?: string }>();
  const decisions: Decision[] = [];

  for (const entry of entries) {
    for (const use of toolUses(entry)) {
      if (use.name !== 'AskUserQuestion') continue;
      asked.set(use.id, { questions: questionsOf(use.input), at: entry.timestamp });
    }

    for (const result of toolResults(entry)) {
      const pending = asked.get(result.id);
      if (!pending) continue;
      asked.delete(result.id);

      for (const q of pending.questions) {
        const answer = answerFor(result.text, q.question);
        if (answer === undefined) continue;
        decisions.push({
          text: `${q.header ?? q.question}: ${answer}`,
          kind: 'decision',
          source: 'human-answer',
          confidence: 'confirmed_by_human',
          at: entry.timestamp ?? pending.at,
        });
      }
    }
  }

  return decisions;
}

export type ExtractOptions = {
  /** From `extract.decision_markers`; added to the built-in markers as decisions. */
  extraMarkers?: string[];
};

export function extractDecisions(entries: TranscriptEntry[], options: ExtractOptions = {}): Decision[] {
  const extra = (options.extraMarkers ?? []).filter((m) => m.trim() !== '').map((m) => ({ kind: 'decision' as const, re: markerRe(m) }));
  return [...fromQuestions(entries), ...fromStatedRationale(entries, [...MARKERS, ...extra])];
}

export { assistantText };
