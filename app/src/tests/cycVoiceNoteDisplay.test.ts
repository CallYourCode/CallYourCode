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
});
