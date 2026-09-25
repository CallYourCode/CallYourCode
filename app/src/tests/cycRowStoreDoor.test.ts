import {afterEach, describe, expect, test} from 'vitest';
import * as rowStore from '../engine/store/rows/rowStore';
import {messageRow, type StoreRow} from '../engine/store/rows/core';
import {applyProjection, isUnsettledOwnSend, settleEcho} from '../engine/store/rows/door';
import {sessions} from '../engine/store/registry';
import type {CycEngineMessage} from '../engine/store/types';
import {memTx} from './rowStoreFake';

// The synchronous write door the open chat's live path and the user's own sends
// use, and the cid rekey that settles an engine echo into a pending send bubble
// without twinning it or losing the painted node's local id.

const SID = 'eng|p1';
const msg = (over: Partial<CycEngineMessage>): CycEngineMessage =>
  ({
    id: 0,
    role: 'claude',
    kind: 'text',
    text: 't',
    ts: over.seq ?? 0,
    ...over
  }) as CycEngineMessage;
const mrow = (over: Partial<CycEngineMessage>): StoreRow => messageRow(SID, msg(over));

afterEach(() => rowStore.__setBackingForTest(null));

describe('upsertSync', () => {
  test('returns null when the session is not warm, folds and paints when it is', async () => {
    rowStore.__setBackingForTest(memTx().tx);
    // cold: no mirror loaded yet
    expect(rowStore.upsertSync(SID, [mrow({mid: 'mr-1', seq: 1})])).toBeNull();
    // warm it by opening the window
    rowStore.setOpen(SID);
    await rowStore.openWindow(SID, 100);
    const paints: number[] = [];
    const off = rowStore.onChange(() => paints.push(1));
    const r = rowStore.upsertSync(SID, [mrow({mid: 'mr-2', seq: 2, text: 'live'})]);
    expect(r?.changed).toBe(true);
    expect(paints).toHaveLength(1);
    expect(rowStore.projection(SID).messages.map((m) => m.text)).toEqual(['live']);
    off();
  });
});

describe('cid rekey: an echo settles a pending send', () => {
  test('the pending bubble and its echo share ONE cid-keyed id, so the settle is one row, no twin', async () => {
    rowStore.__setBackingForTest(memTx().tx);
    rowStore.setOpen(SID);
    await rowStore.openWindow(SID, 100);

    // the user sends: the pending row is keyed by its cid (fix-oneid), so its
    // one durable name is `m:c:c1` from dispatch -- no provisional mid.
    const pending = messageRow(
      SID,
      msg({
        role: 'user',
        text: 'hi',
        ts: 100,
        seq: -1,
        cid: 'c1',
        status: 'sending'
      })
    );
    rowStore.upsertSync(SID, [pending]);
    expect(rowStore.findMsgByCid(SID, 'c1')?.msg?.id).toBe('m:c:c1');

    // the engine echoes with the durable mid and a real seq -- but the SAME cid,
    // so the echo's id is the SAME `m:c:c1`: the rekey is a plain in-place
    // settle, never a twin.
    const echo = messageRow(
      SID,
      msg({
        mid: 'mr-real',
        role: 'user',
        text: 'hi',
        ts: 145,
        seq: 7,
        cid: 'c1',
        status: 'delivered'
      })
    );
    const found = rowStore.findMsgByCid(SID, 'c1')!;
    rowStore.rekey(SID, found.id, echo);

    const {messages} = rowStore.projection(SID);
    expect(messages).toHaveLength(1); // control: settled, not twinned
    expect(messages[0].status).toBe('delivered');
    expect(messages[0].seq).toBe(7);
    // the ONE name never changed across dispatch and echo
    expect(messages[0].id).toBe('m:c:c1');
  });
});

// The reverse of the rekey above: the mid copy of a send is ALREADY stored (its
// page re-serve landed first, or an earlier echo folded the pending into it), so
// settleEcho's m:pending:cid row is gone. On 5f7a9e2 rekey then inserts a
// mid-less fallback row (seq -1) beside the mid row: the twin captured on the
// rig. settleEcho must be idempotent here, folding the settle INTO the mid row
// and creating nothing.
describe('settleEcho is idempotent when its pending row is already gone', () => {
  test('a settle for a cid a mid row already holds folds in, no twin', async () => {
    rowStore.__setBackingForTest(memTx().tx);
    rowStore.setOpen(SID);
    await rowStore.openWindow(SID, 100);

    // the mid copy is already stored, carrying the engine mid, a real seq and cid
    rowStore.upsertSync(SID, [
      messageRow(SID, msg({mid: 'mr-real', role: 'user', text: 'hi', ts: 100, seq: 7, cid: 'c1'}))
    ]);
    expect(rowStore.projection(SID).messages).toHaveLength(1);

    // settleEcho re-settles the same echo (its adopted bubble carries the mid
    // and the real seq): its cid keys the SAME `m:c:c1` the stored row already
    // has, so the settle updates that one row in place instead of twinning it.
    const delivered = msg({
      mid: 'mr-real',
      role: 'user',
      text: 'hi',
      ts: 100,
      seq: 7,
      cid: 'c1',
      status: 'delivered'
    });
    settleEcho(SID, 'c1', delivered);

    const {messages} = rowStore.projection(SID);
    expect(messages).toHaveLength(1); // one row under m:c:c1, not twinned (was 2)
    expect(messages[0].id).toBe('m:c:c1');
    expect(messages[0].mid).toBe('mr-real');
    expect(messages[0].seq).toBe(7);
    expect(messages[0].status).toBe('delivered');
  });
});

describe('an old served send is never a pending overlay', () => {
  test('a mid-less user row the engine numbered is settled; a real optimistic send is not', () => {
    const old = msg({role: 'user', text: 'my resume', ts: 50, seq: 677, cid: 'c-old'});
    expect(isUnsettledOwnSend(old)).toBe(false);
    const sending = msg({role: 'user', text: 'hi', ts: 900, seq: -1, cid: 'c-new', status: 'sending'});
    expect(isUnsettledOwnSend(sending)).toBe(true);
    expect(isUnsettledOwnSend(msg({role: 'user', text: 'x', ts: 1, cid: 'c-x'}))).toBe(true);
  });

  test('when the window moves past an old send it leaves the chat, it is not pinned at the bottom', async () => {
    rowStore.__setBackingForTest(memTx().tx);
    rowStore.setOpen(SID);
    await rowStore.openWindow(SID, 100);
    const old = msg({role: 'user', text: 'my resume', ts: 50, seq: 677, cid: 'c-old'});
    const s = {id: SID, messages: [old], events: []} as never as import('../engine/store/types').CycEngineSession;
    sessions.set(SID, s);
    try {
      // the window now holds only newer rows; the old send is not among them
      rowStore.upsertSync(SID, [mrow({mid: 'mr-today', seq: 2600, ts: 1000, text: 'today'})]);
      applyProjection(SID);
      expect(s.messages.map((m) => m.text)).toEqual(['today']);
    } finally {
      sessions.delete(SID);
    }
  });
});
