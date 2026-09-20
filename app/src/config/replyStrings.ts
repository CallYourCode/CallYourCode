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
