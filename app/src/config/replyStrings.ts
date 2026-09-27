export const RUNGS = [1, 2, 3, 4, 5] as const;

const DEFAULT_REPLY_NAMES: Record<number, string> = {
  1: 'Terminal',
  2: 'Chat',
  3: 'Read out',
  4: 'Spoken',
  5: 'Voice only'
};

export const DEFAULT_REPLY_TEXT: Record<number, string> = {
  1:
    ' (Reply with a copy of your terminal output via the chat tool. Send the' +
    ' same detail you would print in the terminal.)',
  2:
    ' (Reply with the chat tool, the way you would message someone. complete' +
    ' but not exhaustive, structured where structure helps, a few short' +
    ' paragraphs at most.)',
  3:
    ' (Reply with the chat tool AND the speak tool. Send a short spoken summary' +
    ' of the reply via speak tool and a full text message via chat tool.)',
  4:
    ' (Answer with the speak tool. The spoken answer must stand on its own:' +
    ' concise, complete, whole sentences, no markdown, no paths read aloud.' +
    ' Use the chat tool only for what speech cannot carry, when it is needed:' +
    ' code, tables, diffs, file paths, long lists.)',
  5:
    ' (Answer with the speak tool only: concise, complete, whole sentences, no' +
    ' markdown. Do not send a chat message.)'
};

const COMPLEXITY_NAMES: Record<number, string> = {
  1: 'Product Manager',
  2: 'Junior Developer',
  3: 'Short and Simple',
  4: 'Multitasking Developer',
  5: 'Focused Developer'
};

const DEFAULT_COMPLEXITY_TEXT: Record<number, string> = {
  1:
    ' (Pitch this at a product manager: lead with what it means and what it' +
    ' changes, in plain language. Where a technical word is the only accurate' +
    ' one, use it and say what it means.)',
  2:
    ' (Pitch this at a junior developer who is learning the craft. Lead with' +
    ' what it means and what it changes, avoid assuming heavy technical jargon' +
    ' knowledge.)',
  3:
    ' (Keep this super short and simple: the context, the answer, the reason,' +
    ' the question and nothing extra worth knowing.)',
  4:
    ' (Pitch this at a working developer juggling multiple agents: lead with' +
    ' the context and assume the basics are known.)',
  5:
    ' (Pitch this at a developer who is solely focused on this agent only. Full' +
    ' technical depth, the tradeoffs you considered, the edge cases.)'
};

const DEFAULT_PROMPT_BITS: string[] = [
  "discuss don't do",
  'show as a linux style file tree. different abstraction layers. show it collapsed first.',
  'concise, complete, information dense list with short and simple line items.',
  'lead with the result',
  'short answer',
  "add to task list, don't discuss or do.",
  'do in a background agent.',
  'do with a background builder agent and a verifier agent in a worktree.',
  'explain with examples.',
  'Build a interactive html page and show that to me to make it easier for me to ' +
    'understand, go abstraction layer by layer so I start from what I know and go to more ' +
    'details slowly.',
  'Keep your answer as short as possible without dropping any part of my question.',
  'Let me know the result of your investigation. Do not write an essay. Tell it to me ' +
    'in short.',
  'Put the answer in the app as a markdown file with the show tool, not only in the chat.',
  'Build an interactive HTML page for this and push it to the app with the show tool.',
  'Push the diff to the app with the show tool rather than pasting it into the chat.',
  'Make an image for this -- a chart, a diagram, a rendered view -- and push it to ' +
    'the app with the show tool rather than describing it in the chat.'
];

export type ReplyStringOverrides = {
  reply?: Record<number, {name?: string; text?: string}>;

  complexity?: Record<number, {name?: string; text?: string}>;

  bits?: string[];
};

export function promptBitList(ov?: ReplyStringOverrides): string[] {
  return ov?.bits ?? DEFAULT_PROMPT_BITS;
}

// Reply/complexity wordings the dial appended in SHIPPED builds before the
// current DEFAULT_* strings. Collected verbatim from stored chat logs (grep
// "(Reply with", "(Answer with", "(Keep this") so a prompt pill that carries an
// old wording is still cleaned. Whitespace is matched flexibly at strip time, so
// the multiline (indented) forms these shipped in are covered by these
// single-space forms. These are DISPLAY-strip data only; nothing generates them.
const LEGACY_APPENDED_SUFFIXES: string[] = [
  '(Reply with the chat tool, complete and structured. Then ALSO call the speak tool' +
    ' with a short spoken summary of that reply: two or three sentences, the answer and' +
    ' nothing else.)',
  '(Reply with the chat tool, complete and structured. Then ALSO call the speak tool' +
    ' with a short spoken summary: two or three sentences, the answer and nothing else.)',
  '(Reply with the chat tool, the way you would message someone: complete but not' +
    ' exhaustive, structured where structure helps, a few short paragraphs at most. Do' +
    ' not use the speak tool.)',
  '(Reply with the chat tool. Send the same detail you would print in the terminal: full' +
    ' output, structure intact. Do not use the speak tool.)',
  '(Reply with the speak tool. Keep it concise, complete, short and simple; whole' +
    ' sentences, it will be read aloud.)',
  '(Reply with the chat tool, the way you would message someone. 1-2 lines answer. No' +
    ' blobs of text. A list of short and simple line items where it helps.)',
  '(Answer with the speak tool. The spoken answer must stand on its own: concise,' +
    ' complete, whole sentences, no markdown, no paths read aloud. Chat only for what' +
    ' speech cannot carry: code, tables, diffs, paths, long lists.)',
  '(Answer with the speak tool. The spoken answer must stand on its own: concise,' +
    ' complete, whole sentences, no markdown, no paths read aloud. Put in the chat only' +
    ' what speech cannot carry, when it is needed: code, tables, diffs, file paths, long' +
    ' lists. Do not repeat the spoken answer as text.)',
  '(Keep this short and simple: the answer, the one reason it is the answer, and stop' +
    ' there.)'
];

// Every wording the reply dial may have appended to the owner's message: the
// current defaults, the owner's current overrides (settings), the shipped bits,
// and the legacy wordings above. Trimmed and deduped, for the DISPLAY strip.
export function knownPromptSuffixes(ov?: ReplyStringOverrides): string[] {
  const out: string[] = [];
  for (const n of RUNGS) {
    out.push(replyText(n, ov), DEFAULT_REPLY_TEXT[n]);
    out.push(complexityText(n, ov), DEFAULT_COMPLEXITY_TEXT[n]);
  }
  out.push(...promptBitList(ov), ...DEFAULT_PROMPT_BITS, ...LEGACY_APPENDED_SUFFIXES);
  return [...new Set(out.map((s) => s.trim()).filter(Boolean))];
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Strip, FOR DISPLAY ONLY, every known dial-appended bit off the end of a prompt
// pill's text (several may be concatenated), plus a leading "TEXT: " prefix.
// Matching is exact per known wording except that any run of whitespace in a
// wording matches any run of whitespace in the text, so a wording that shipped
// wrapped across indented lines is still recognised. Only exact known wordings
// are removed, never arbitrary text the owner typed. Never call this on the
// message sent to the agent -- it is a render-time transform.
export function stripAppendedPromptBits(text: string, ov?: ReplyStringOverrides): string {
  if (!text) return text;
  let cur = text.replace(/^TEXT:[ \t]+/, '');
  // Longest first, so a longer wording wins over a shorter one it contains.
  const res = knownPromptSuffixes(ov)
    .sort((a, b) => b.length - a.length)
    .map((s) => new RegExp('\\s*' + escapeRe(s).replace(/\s+/g, '\\s+') + '\\s*$'));
  for (let guard = 0; guard < 12; guard++) {
    let cut = false;
    for (const re of res) {
      const next = cur.replace(re, '');
      if (next.length < cur.length) {
        cur = next;
        cut = true;
        break;
      }
    }
    if (!cut) break;
  }
  return cur.replace(/\s+$/, '');
}

function replyText(n: number, ov?: ReplyStringOverrides): string {
  return ov?.reply?.[n]?.text ?? DEFAULT_REPLY_TEXT[n] ?? '';
}

export function complexityText(n: number, ov?: ReplyStringOverrides): string {
  return ov?.complexity?.[n]?.text ?? DEFAULT_COMPLEXITY_TEXT[n] ?? '';
}

type EngineStrings = {reply: Record<number, string>; complexity: Record<number, string>};

export function parseReplyStrings(v: unknown): ReplyStringOverrides {
  const out: ReplyStringOverrides = {};
  if (!v || typeof v !== 'object' || Array.isArray(v)) return out;
  const o = v as Record<string, unknown>;

  const reply: Record<number, {name?: string; text?: string}> = {};
  if (o.reply && typeof o.reply === 'object') {
    for (const n of RUNGS) {
      const e = (o.reply as Record<string, unknown>)[n];
      if (!e || typeof e !== 'object') continue;
      const entry: {name?: string; text?: string} = {};
      const {name, text} = e as Record<string, unknown>;
      if (typeof name === 'string') entry.name = name;
      if (typeof text === 'string') entry.text = text;
      if (Object.keys(entry).length) reply[n] = entry;
    }
  }
  if (Object.keys(reply).length) out.reply = reply;

  const complexity: Record<number, {name?: string; text?: string}> = {};
  if (o.complexity && typeof o.complexity === 'object') {
    for (const n of RUNGS) {
      const e = (o.complexity as Record<string, unknown>)[n];

      if (typeof e === 'string') {
        complexity[n] = {text: e};
        continue;
      }
      if (!e || typeof e !== 'object') continue;
      const entry: {name?: string; text?: string} = {};
      const {name, text} = e as Record<string, unknown>;
      if (typeof name === 'string') entry.name = name;
      if (typeof text === 'string') entry.text = text;
      if (Object.keys(entry).length) complexity[n] = entry;
    }
  }
  if (Object.keys(complexity).length) out.complexity = complexity;

  if (Array.isArray(o.bits)) {
    out.bits = o.bits.filter((s): s is string => typeof s === 'string');
  }

  return out;
}
