import type {CycMessage, CycReplyTo, CycSession} from './types';
import {REPLY_EXCERPT_LIMIT} from './types';
import {uploadTitle} from '@/features/chat/content';

export const replyAuthor = (s: CycSession, m: CycMessage): string =>
  m.role === 'user' ? 'You' : s.title?.text || s.name;

export const replyExcerpt = (m: CycMessage): string => {
  const text = (m.text ?? '').trim();
  if (text) return text;

  if (m.upload) return uploadTitle(m.upload);
  if (m.kind === 'voice') return 'Voice message';
  if (m.file) return m.file.name;
  return 'Message';
};

const replyPreview = (value: string): string => {
  const text = value.trim().replace(/\s+/g, ' ');
  if (text.length <= REPLY_EXCERPT_LIMIT) return text;
  const cut = text.slice(0, REPLY_EXCERPT_LIMIT);
  const wordEnd = cut.lastIndexOf(' ');
  return (wordEnd > REPLY_EXCERPT_LIMIT / 2 ? cut.slice(0, wordEnd) : cut).trimEnd() + '…';
};

export const replyTargetFor = (s: CycSession, m: CycMessage, quote?: string): CycReplyTo => ({
  // KEY ON THE ID (fix-oneid): the reply resolves back to its target by this one
  // durable id, across a re-serve and a reload. ts rides along as display-only
  // metadata (the excerpt's clock), never the resolution key.
  id: m.id,
  ts: m.ts,
  role: m.role,
  title: replyAuthor(s, m),
  text: quote ?? replyPreview(replyExcerpt(m)),
  ...(quote ? {quote: true} : {})
});

export const replySource = new WeakMap<CycReplyTo, CycMessage>();

// Refresh a reply target from its source bubble's current facts: the durable id
// (the one the jump keys on) and the display ts. With cid/mid-keyed ids the id
// is stable, so this normally only trues up the display ts of a target built
// before its own send was restamped on delivery.
export const settledReply = (r: CycReplyTo | undefined): CycReplyTo | undefined => {
  const src = r && replySource.get(r);
  if (!src) return r;
  return src.ts !== r!.ts || src.id !== r!.id ? {...r!, ts: src.ts, id: src.id} : r;
};
