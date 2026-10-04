/* THE SENT VOICE BUBBLE SHOWS THE DEVICE'S OWN STREAMING TRANSCRIPT and then
 * takes the engine's final without a flicker or a duplicate.
 *
 * The instant lone-note send ships an empty wire body (the engine fills it) but
 * paints the device's still-settling words on the sent row (draftCommitted
 * kept, so updateVoiceNote can grow it). When the engine's copy of the row
 * comes back, adoptEngineRow must:
 *   - REPLACE a still-streaming display with the engine's delivered text (the
 *     settled superset: device words + decoded tail), one repaint, no twin;
 *   - LEAVE a settled non-empty text alone (the old contract: the engine only
 *     fills what the device did not already say);
 *   - on a PENDING echo (a long note shown before its transcript) keep the
 *     stream OPEN: no words came yet, the device's display stands and keeps
 *     growing until the completion row lands (settleTranscript).
 */
import {describe, expect, test} from 'vitest';
import {adoptEngineRow, findLocalFor} from '../engine/store/admit';
import {audioMessage} from '../features/chat/messages/audioMessages';
import {reachOf} from '../features/chat/content';
import {renderMessages, clearMessages} from '../features/chat/surface/messageList';
import * as rowStore from '../engine/store/rows/rowStore';
import {messageRow} from '../engine/store/rows/core';
import {memTx} from './rowStoreFake';
import type {CycMessage, CycSession} from '../types';
import type {CycEngineMessage, CycEngineSession} from '../engine/store/types';
import type {EngineChatMessage} from '../engine/contract';

function mkSession(local: CycEngineMessage): CycEngineSession {
  return {
    id: 'e|p1',
    engineKey: 'e',
    paneId: 'p1',
    messages: [local]
  } as unknown as CycEngineSession;
}

function mkLocal(over: Partial<CycEngineMessage> = {}): CycEngineMessage {
  return {
    id: 1,
    role: 'user',
    kind: 'voice',
    text: '',
    ts: 100,
    status: 'sending',
    cid: 'c1',
    ...over
  } as CycEngineMessage;
}

const engineRow = (over: Partial<EngineChatMessage> = {}): EngineChatMessage =>
  ({role: 'user', kind: 'voice', text: '', ts: 200, cid: 'c1', ...over}) as EngineChatMessage;

describe('adoptEngineRow on a streaming voice display', () => {
  test('a still-streaming display takes the engine final whole: text replaced, stream closed', () => {
    const local = mkLocal({text: 'hello world and', draftCommitted: 11});
    const s = mkSession(local);
    adoptEngineRow(
      s,
      local,
      engineRow({text: 'hello world and the decoded tail'}),
      'hello world and the decoded tail',
      'k1'
    );
    expect(local.text).toBe('hello world and the decoded tail');
    expect(local.draftCommitted).toBeUndefined();
    expect(local.status).toBe('delivered');
  });

  test('a settled non-empty bubble is left alone (only streaming rows adopt over their text)', () => {
    const local = mkLocal({text: 'the words i baked in'});
    const s = mkSession(local);
    adoptEngineRow(s, local, engineRow({text: 'something else'}), 'something else', 'k2');
    expect(local.text).toBe('the words i baked in');
  });

  test('an empty bubble still takes the engine words, exactly as before', () => {
    const local = mkLocal({text: ''});
    const s = mkSession(local);
    adoptEngineRow(s, local, engineRow({text: 'server words'}), 'server words', 'k3');
    expect(local.text).toBe('server words');
  });

  test('a PENDING echo keeps the device stream open: display stands, draftCommitted kept', () => {
    const local = mkLocal({text: 'growing device words', draftCommitted: 20});
    const s = mkSession(local);
    adoptEngineRow(s, local, engineRow({text: '', transcriptPending: true}), '', 'k4');
    // No words came yet: the device's display is all there is, and it must
    // keep growing (updateVoiceNote needs draftCommitted) until the
    // completion row lands.
    expect(local.text).toBe('growing device words');
    expect(local.draftCommitted).toBe(20);
    expect(local.transcriptPending).toBe(true);
  });

  // A quoted note the engine filled ("note-words"): the engine's text is the
  // quote this device's wire put on top, then the words, then the caption. The
  // bubble already draws the quote as its reply panel, so it takes the body
  // below the quote; the quote is never drawn twice.
  const REPLY = {ts: 50, role: 'claude' as const, title: 'Claude', text: 'Done. Only remote roles.'};

  test('a quoted note takes the words and caption below the quote, and its caption frame goes', () => {
    const local = mkLocal({
      text: 'This is not\n\nand a caption',
      draftCommitted: 4,
      replyTo: REPLY,
      wordsAround: {before: '', after: '\n\nand a caption'}
    });
    const s = mkSession(local);
    const full = '> Done. Only remote roles.\n\nThis is not what I asked.\n\nand a caption';
    adoptEngineRow(s, local, engineRow({text: full}), full, 'k5');
    expect(local.text).toBe('This is not what I asked.\n\nand a caption');
    expect(local.draftCommitted).toBeUndefined();
    expect(local.wordsAround).toBeUndefined();
    expect(local.replyTo).toEqual(REPLY);
  });

  test('a quoted pending echo keeps the stream and its caption frame open', () => {
    const local = mkLocal({
      text: 'growing\n\ncaption',
      draftCommitted: 7,
      replyTo: REPLY,
      wordsAround: {before: '', after: '\n\ncaption'}
    });
    const s = mkSession(local);
    adoptEngineRow(s, local, engineRow({text: '', transcriptPending: true}), '', 'k6');
    expect(local.text).toBe('growing\n\ncaption');
    expect(local.wordsAround).toEqual({before: '', after: '\n\ncaption'});
  });

  test('text that does not start with the reply quote is taken whole', () => {
    const local = mkLocal({text: '', replyTo: REPLY});
    const s = mkSession(local);
    adoptEngineRow(s, local, engineRow({text: 'just words'}), 'just words', 'k7');
    expect(local.text).toBe('just words');
  });

  test("a quoted note's pending echo (its quote and caption) never replaces the device's growing words", () => {
    const local = mkLocal({
      text: 'not what I asked\n\ncaption',
      draftCommitted: 8,
      replyTo: REPLY,
      wordsAround: {before: '', after: '\n\ncaption'}
    });
    const s = mkSession(local);
    const pending = '> Done. Only remote roles.\n\ncaption';
    adoptEngineRow(s, local, engineRow({text: pending, transcriptPending: true}), pending, 'k8');
    expect(local.text).toBe('not what I asked\n\ncaption');
    expect(local.draftCommitted).toBe(8);
    expect(local.transcriptPending).toBe(true);
  });
});

describe('a note the engine gave up on (undelivered)', () => {
  // the row as a page or a live frame brings it, on any device
  const row = (): CycEngineMessage =>
    ({
      id: '',
      role: 'user',
      kind: 'voice',
      text: 'my caption',
      ts: 1,
      cid: 'c-old',
      msgId: 'clip-1',
      mid: 'mr-9',
      seq: 5,
      durationS: 30,
      status: 'delivered',
      undelivered: 'the engine restarted while delivering this and cannot tell whether it arrived.'
    }) as unknown as CycEngineMessage;

  test('comes into the store failed with the reason, and paints so with the retry', () => {
    const m = messageRow('e|p1', row()).msg!;
    expect(m).toMatchObject({status: 'failed', failReason: row().undelivered});
    expect(reachOf(m)).toBe('failed');
    const node = audioMessage(m, true, true, () => {});
    expect(node.classList.contains('cyc-msg-failed')).toBe(true);
    const note = node.querySelector('button.cyc-voice-failed');
    expect(note, 'no retry offered').not.toBeNull();
    expect(note!.textContent).toContain('the engine restarted while delivering this');
    expect(note!.textContent).toContain('Tap to try again');
    expect(node.textContent).not.toContain('recording was not saved');
  });

  test('an open chat repaints its pending bubble to failed when the mark arrives', () => {
    (globalThis as unknown as {IntersectionObserver: unknown}).IntersectionObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
    const inner = document.createElement('div');
    const scroll = document.createElement('div');
    scroll.className = 'cyc-message-list-scroll';
    scroll.append(inner);
    document.body.append(scroll);
    const pending = {...row(), text: '> the agent asked\n\nmy caption', transcriptPending: true};
    delete (pending as Partial<CycEngineMessage>).undelivered;
    const s = {id: 'e|p1', messages: [messageRow('e|p1', pending).msg!]} as unknown as CycSession;
    renderMessages(inner, s, () => {});
    expect(inner.querySelectorAll('.cyc-send-failed').length).toBe(0);
    const marked = {...pending, undelivered: 'it did not arrive'} as CycEngineMessage;
    delete marked.transcriptPending;
    s.messages = [messageRow('e|p1', marked).msg!];
    renderMessages(inner, s, () => {});
    expect(
      inner.querySelectorAll('.cyc-send-failed').length,
      'the open chat kept the pending node'
    ).toBe(1);
    clearMessages(inner);
    scroll.remove();
  });

  test('once its retry lands the re-served row, without the mark, is no longer failed', async () => {
    rowStore.__setBackingForTest(memTx().tx);
    rowStore.setOpen('e|p1');
    await rowStore.openWindow('e|p1', 100);
    await rowStore.upsert('e|p1', [messageRow('e|p1', row())]);
    expect(rowStore.projection('e|p1').messages[0].status).toBe('failed');
    const cleared = {...row(), rev: 2} as Partial<CycEngineMessage>;
    delete cleared.undelivered;
    delete cleared.status; // a page row carries no status
    await rowStore.upsert('e|p1', [messageRow('e|p1', cleared as CycEngineMessage)]);
    const m = rowStore.projection('e|p1').messages[0] as CycEngineMessage;
    expect(m.status, 'the failed mark was carried over').not.toBe('failed');
    expect(m.failReason).toBeUndefined();
    rowStore.__setBackingForTest(null);
  });

  test('a held failed row (from a page) takes the cleared mark from the live frame', () => {
    const held = messageRow('e|p1', row()).msg!;
    const cleared = {...row()} as Partial<CycEngineMessage>;
    delete cleared.undelivered;
    adoptEngineRow(mkSession(held), held, engineRow(cleared), 'my caption', 'k8');
    expect(messageRow('e|p1', held).msg).toMatchObject({status: 'delivered'});
    expect(held.failReason).toBeUndefined();
  });

  test("the failed row's cleared frame is never folded into its retry's bubble (same clip)", () => {
    const retry = mkLocal({cid: 'c-old-r', msgId: 'clip-1', status: 'sending'});
    const s = mkSession(retry);
    expect(findLocalFor(s, engineRow({cid: 'c-old', msgId: 'clip-1'}), 'my caption')).toBeUndefined();
    expect(findLocalFor(s, engineRow({cid: 'c-old-r', msgId: 'clip-1'}), '')).toBe(retry);
  });

  test("the sender's own bubble takes the failure from the row", () => {
    const local = mkLocal({text: 'my words', status: 'sent'});
    adoptEngineRow(
      mkSession(local),
      local,
      engineRow({text: 'my caption', undelivered: 'it did not arrive'}),
      'my caption',
      'k9'
    );
    expect(messageRow('e|p1', local).msg).toMatchObject({
      status: 'failed',
      failReason: 'it did not arrive'
    });
  });
});

describe("the engine's pending row on another device", () => {
  test('shows the quote and caption formatted, with the reading dots', () => {
    const m = {
      id: 'r1',
      role: 'user',
      kind: 'voice',
      text: '> Done. Only remote roles.\n\nand a caption',
      ts: 1,
      msgId: 'clip-1',
      durationS: 30,
      transcriptPending: true
    } as unknown as CycMessage;
    const node = audioMessage(m, true, true, () => {});
    const t = node.querySelector('.cyc-transcript')!;
    expect(t.querySelector('.cyc-callout')?.textContent).toContain('Done. Only remote roles.');
    expect(t.textContent).toContain('and a caption');
    expect(t.textContent).not.toContain('{{cyc-words');
    expect(t.textContent).not.toContain('> Done');
    expect(t.querySelector('.cyc-transcript-dots')).not.toBeNull();
  });
});
