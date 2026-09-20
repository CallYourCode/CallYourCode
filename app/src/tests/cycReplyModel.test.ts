import {describe, expect, test} from 'vitest';
import type {CycMessage, CycSession} from '../types';
import {REPLY_EXCERPT_LIMIT} from '../types';
import {replyAuthor, replyExcerpt, replyTargetFor, replySource, settledReply} from '../replyModel';
const session = {
  id: 's',
  name: 'Relay Server',
  unread: 0,
  muted: false,
  thinking: false,
  messages: []
} as unknown as CycSession;
const msg = (over: Partial<CycMessage>): CycMessage =>
  ({id: 1, role: 'claude', kind: 'text', text: '', ts: 100, ...over}) as CycMessage;
describe('replyAuthor', () => {
  test('you on one side, the session (title over name) on the other', () => {
    expect(replyAuthor(session, msg({role: 'user'}))).toBe('You');
    expect(replyAuthor(session, msg({role: 'claude'}))).toBe('Relay Server');
    const titled = {...session, title: {text: 'Relay (staging)'}} as CycSession;
    expect(replyAuthor(titled, msg({role: 'claude'}))).toBe('Relay (staging)');
  });
});
describe('replyExcerpt: a message with no words is named, not blanked', () => {
  test('text wins when there is any', () => {
    expect(replyExcerpt(msg({text: '  hello  '}))).toBe('hello');
  });
  test('a wordless voice note is "Voice message"', () => {
    expect(replyExcerpt(msg({kind: 'voice', text: ''}))).toBe('Voice message');
  });
  test('a shown file is quoted as its file name', () => {
    expect(
      replyExcerpt(
        msg({file: {docId: 'd', name: 'notes.md', fileKind: 'markdown', size: 1}} as never)
      )
    ).toBe('notes.md');
  });
  test('the last resort is "Message"', () => {
    expect(replyExcerpt(msg({}))).toBe('Message');
  });
});
describe('replyTargetFor', () => {
  test('whole-message reply: capped excerpt, anchored on ts and role', () => {
    const m = msg({text: 'x'.repeat(REPLY_EXCERPT_LIMIT * 2), ts: 42, role: 'claude'});
    const t = replyTargetFor(session, m);
    expect(t.ts).toBe(42);
    expect(t.role).toBe('claude');
    expect(t.title).toBe('Relay Server');

    expect(t.text.length).toBeLessThanOrEqual(REPLY_EXCERPT_LIMIT + 3);
    expect(t.text.length).toBeLessThan(m.text.length);
    expect(t.quote).toBeUndefined();
  });
  test('a quote keeps the selection verbatim and marks itself', () => {
    const t = replyTargetFor(session, msg({text: 'long text'}), 'the selection');
    expect(t.text).toBe('the selection');
    expect(t.quote).toBe(true);
  });
});
describe('settledReply: the anchor follows the echo', () => {
  test('a target whose source message was re-stamped takes the new ts', () => {
    const m = msg({text: 'hi', ts: 100});
    const t = replyTargetFor(session, m);
    replySource.set(t, m);
    m.ts = 250;
    const settled = settledReply(t);
    expect(settled?.ts).toBe(250);
    expect(t.ts).toBe(100);
  });
  test('an unmoved source or an untracked target passes through unchanged', () => {
    const m = msg({ts: 7});
    const t = replyTargetFor(session, m);
    replySource.set(t, m);
    expect(settledReply(t)).toBe(t);
    expect(settledReply(undefined)).toBeUndefined();
  });
});
