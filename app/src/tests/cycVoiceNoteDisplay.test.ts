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
import {adoptEngineRow} from '../engine/store/admit';
import {audioMessage} from '../features/chat/messages/audioMessages';
import type {CycMessage} from '../types';
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
