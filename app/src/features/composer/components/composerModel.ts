import type {CycReplyTo} from '../../../types';
import type {ComposerWidgetDecl} from '../../../engine/contract';

export const COMPOSER_ICON_TRANSITION = '[transition:0.2s_opacity]!';

export type ComposerPluginWidget = {widget: ComposerWidgetDecl; onSet?: (n: number) => void};

export type Staged = {
  file: File;
  upload: Promise<unknown> | null;
  progress: number;
  done: boolean;
  error: Error | null;

  // Set while an attachment still needs its intake conversion (HEIC -> JPEG)
  // before upload; a failed chip calls it to re-run the conversion instead of
  // uploading the raw source bytes. Cleared once the file is ready to upload.
  retry?: () => void;

  fromPage?: {label: string; page: string};

  durationS?: number;

  width?: number;
  height?: number;
  chip?: HTMLElement;
  ring?: HTMLElement;
  nameEl?: HTMLElement;
};

export type VoiceClip = {
  durationS: number;
  text: string;

  blob?: Blob | null;

  committed?: number;

  unsure?: boolean;

  lost?: boolean;

  waiting?: boolean;

  restored?: boolean;
};

export type VoiceHandle = {
  update(clip: Partial<VoiceClip>): void;
  attach(file: File): void;
  remove(): void;

  file(): File | null;
};

export type ComposerBlock =
  | {kind: 'reply'; reply: CycReplyTo}
  | {kind: 'quote'; text: string; title?: string; source?: CycReplyTo}
  | {kind: 'voice'; clip: VoiceClip; staged?: Staged; onPlay?: (el: HTMLElement) => void}
  | {kind: 'attach'; staged: Staged}
  | {kind: 'prompt'; text: string};

// What a send settles to, as the box sees it:
//   true    the send's rows are on disk (or the engine took it): the box clears.
//   false   nothing went (a dead session, a refused attachment): the box keeps it.
//   {kept}  the send is out but neither on disk nor taken yet: the box keeps it
//           and the user was told; `kept` resolves true once the engine takes
//           it (the box clears then, even late), false once it fails for good.
export type SendSettled = boolean | {kept: Promise<boolean>; delivered?: Promise<boolean>};

export type MessagePart = {kind: 'text' | 'quote'; text: string};

export function liftQuotes(typed: string): MessagePart[] {
  const parts: MessagePart[] = [];
  let quoted: string[] | null = null;
  let plain: string[] = [];
  const flushPlain = () => {
    const t = plain.join('\n').trim();
    plain = [];
    if (t) parts.push({kind: 'text', text: t});
  };
  const flushQuote = () => {
    if (!quoted) return;
    const t = quoted.join('\n').trim();
    quoted = null;
    if (t) parts.push({kind: 'quote', text: t});
  };

  const MARKER = /^ {0,3}> ?/;
  let fenced = false;
  for (const line of typed.split('\n')) {
    if (/^\s*(?:```|~~~)/.test(line)) {
      fenced = !fenced;
      flushQuote();
      plain.push(line);
      continue;
    }
    if (!fenced && MARKER.test(line)) {
      if (!quoted) {
        flushPlain();
        quoted = [];
      }
      quoted.push(line.replace(MARKER, ''));
    } else {
      flushQuote();
      plain.push(line);
    }
  }
  flushQuote();
  flushPlain();
  return parts;
}

function voiceWords(b: ComposerBlock & {kind: 'voice'}): string {
  const t = b.clip.text.trim();
  if (!t) return '';
  return b.clip.unsure && b.staged ? '' : t;
}

export function messageParts(blocks: ComposerBlock[], typed: string): MessagePart[] {
  const parts: MessagePart[] = [];
  for (const b of blocks) {
    if (b.kind === 'quote') parts.push({kind: 'quote', text: b.text});
    else if (b.kind === 'prompt') parts.push({kind: 'text', text: b.text});
    else if (b.kind === 'voice') {
      const t = voiceWords(b);
      if (t) parts.push({kind: 'text', text: t});
    }
  }
  parts.push(...liftQuotes(typed));
  return parts;
}

export function sendPlan(
  blocks: ComposerBlock[],
  typed: string
): {parts: MessagePart[]; answering?: CycReplyTo; body: ComposerBlock[]} {
  const reply = blocks.find((b): b is ComposerBlock & {kind: 'reply'} => b.kind === 'reply');
  const asReply = reply
    ? undefined
    : blocks.find((b): b is ComposerBlock & {kind: 'quote'} => b.kind === 'quote' && !!b.source);

  const body = asReply ? blocks.filter((b) => b !== asReply) : blocks;
  return {
    parts: messageParts(body, typed),
    answering: reply?.reply ?? asReply?.source,
    body
  };
}

function renderPart(p: MessagePart): string {
  return p.kind === 'quote'
    ? p.text
        .split('\n')
        .map((l) => '> ' + l)
        .join('\n')
    : p.text;
}

const PART_GAP = '\n\n';

export function renderParts(parts: MessagePart[]): string {
  return parts.map(renderPart).join(PART_GAP);
}

export type FileAnchor = {at: number; textLen: number};

export function sendLayout(
  blocks: ComposerBlock[],
  typed: string,
  pending?: (staged: Staged) => string | undefined
): {text: string; anchors: FileAnchor[]} {
  const {body} = sendPlan(blocks, typed);
  const anchors: FileAnchor[] = [];

  let waiting: number[] = [];
  let text = '';
  const slot = () => anchors.push({at: 0, textLen: 0}) - 1;
  const place = (rendered: string): number => {
    if (text) text += PART_GAP;
    const at = text.length;
    text += rendered;
    for (const i of waiting) anchors[i] = {at, textLen: 0};
    waiting = [];
    return at;
  };
  for (const b of body) {
    if (b.kind === 'quote') place(renderPart({kind: 'quote', text: b.text}));
    else if (b.kind === 'prompt') place(b.text);
    else if (b.kind === 'attach') waiting.push(slot());
    else if (b.kind === 'voice') {
      const i = b.staged ? slot() : -1;

      const marker = b.staged && pending ? pending(b.staged) : undefined;
      const words = marker ?? voiceWords(b);
      if (!words) {
        if (i >= 0) waiting.push(i);
        continue;
      }
      const at = place(words);
      if (i >= 0) anchors[i] = {at, textLen: words.length};
    }
  }
  for (const p of liftQuotes(typed)) place(renderPart(p));
  for (const i of waiting) anchors[i] = {at: text.length, textLen: 0};
  return {text, anchors};
}
