// The reload id defect, retired by fix-oneid (the message contract
// consolidation). A message's ONE name is its durable string row id, computed
// in exactly one place (rowIdOfMessage) from the row's own durable facts (cid,
// else mid, else ts|role|text) -- never a per-load render number. So the
// cross-load collision that once twinned two bubbles under one number (Reply and
// Copy quoting a DIFFERENT bubble) cannot exist: a restored row keeps the id its
// content derives, and a freshly admitted row derives the same id from the same
// content, never a colliding one. These pin the new invariants: string-id
// uniqueness, and a stable id across the whole lifetime of a row on a device.

import {afterEach, describe, expect, test} from 'vitest';
import * as rowStore from '../engine/store/rows/rowStore';
import {messageRow, rowIdOfMessage} from '../engine/store/rows/core';
import {rowsFromPage} from '../engine/store/rows/replicator';
import {sessions, findLocal} from '../engine/store/registry';
import {replyTargetFor} from '../replyModel';
import type {CycEngineMessage} from '../engine/store/types';
import type {CycSession} from '../types';
import type {EnginePage} from '../engine/contract';
import {memTx} from './rowStoreFake';

const SID = 'eng|renderid';

function seat(messages: CycEngineMessage[]): CycSession {
  const s = {id: SID, name: 'p', messages, events: []} as unknown as CycSession;
  sessions.set(SID, s as never);
  return s;
}

afterEach(() => {
  rowStore.__setBackingForTest(null);
  sessions.delete(SID);
});

describe('the one durable id, through the real store', () => {
  test('restored rows and a freshly admitted page never share an id, and findLocal resolves the right message', async () => {
    rowStore.__setBackingForTest(memTx().tx);

    // A PREVIOUS load persisted three claude rows. Their durable ids are keyed
    // on their engine mids, computed by the one id function.
    const restored = [1, 2, 3].map((n) =>
      messageRow(SID, {
        id: '',
        role: 'claude',
        kind: 'text',
        text: 'restored-' + n,
        ts: n,
        seq: n,
        mid: 'old-' + n
      } as CycEngineMessage)
    );
    await rowStore.upsert(SID, restored);
    // The reload drops every warm mirror; the next open reloads the restored
    // rows (and their durable ids) from the backing.
    rowStore.close(SID);

    // THIS load admits a fresh page of DIFFERENT rows. There is no per-load
    // counter to re-seed: every row's id is derived from its own mid.
    const page: EnginePage = {
      page: 0,
      version: 1,
      sealed: false,
      events: [],
      messages: [
        {id: SID, role: 'user', text: 'fresh-A', ts: 10, seq: 10, mid: 'new-A'},
        {id: SID, role: 'user', text: 'fresh-B', ts: 11, seq: 11, mid: 'new-B'},
        {id: SID, role: 'user', text: 'fresh-C', ts: 12, seq: 12, mid: 'new-C'}
      ] as EnginePage['messages']
    };
    await rowStore.upsert(SID, rowsFromPage(SID, page));

    const {messages} = await rowStore.openWindow(SID, 300);
    seat(messages);

    // Every id in one session's messages array is UNIQUE, by construction.
    const ids = messages.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
    // And each is exactly what the one id function derives from its content.
    for (const m of messages) expect(m.id).toBe(rowIdOfMessage(m));

    // findLocal resolves each id to the ONE message that carries it.
    const freshB = messages.find((m) => m.text === 'fresh-B')!;
    expect(freshB.id).toBe('m:new-B');
    expect(findLocal(SID, freshB.id)?.text).toBe('fresh-B');
    const restored2 = messages.find((m) => m.text === 'restored-2')!;
    expect(restored2.id).toBe('m:old-2');
    expect(findLocal(SID, restored2.id)?.text).toBe('restored-2');
  });

  test('an own send keeps ONE cid-keyed id from dispatch through echo, re-serve and reload', async () => {
    rowStore.__setBackingForTest(memTx().tx);
    const cid = 'send-cid-1';

    // Dispatch: the optimistic bubble is keyed by its cid (no mid yet).
    const optimistic = {
      id: '',
      role: 'user',
      kind: 'text',
      text: 'hello',
      ts: 1000,
      status: 'sending',
      cid
    } as CycEngineMessage;
    const dispatchId = rowIdOfMessage(optimistic);
    expect(dispatchId).toBe('m:c:' + cid);

    // Engine echo: the same send comes back carrying a mid AND a server ts (the
    // delivery restamp). The id is STILL the cid-keyed name: cid outranks mid.
    const echo = {
      id: '',
      role: 'user',
      kind: 'text',
      text: 'hello',
      ts: 1001,
      seq: 4,
      cid,
      mid: 'mr-echo',
      dedupeKey: 'mid:mr-echo',
      status: 'delivered'
    } as CycEngineMessage;
    expect(rowIdOfMessage(echo)).toBe(dispatchId);
    await rowStore.upsert(SID, [messageRow(SID, echo)]);

    // Re-serve from a page (a renumbered seq, still the cid): same id, in place.
    const reserve = {...echo, seq: 9} as CycEngineMessage;
    await rowStore.upsert(SID, [messageRow(SID, reserve)]);
    let win = await rowStore.openWindow(SID, 300);
    expect(win.messages).toHaveLength(1);
    expect(win.messages[0].id).toBe(dispatchId);

    // Reload: drop the warm mirror, reopen from the durable backing.
    rowStore.close(SID);
    win = await rowStore.openWindow(SID, 300);
    expect(win.messages).toHaveLength(1);
    expect(win.messages[0].id).toBe(dispatchId);
    seat(win.messages);
    expect(findLocal(SID, dispatchId)?.text).toBe('hello');
  });

  test('a reply target resolves back to its message by id across a re-serve and a reload', async () => {
    rowStore.__setBackingForTest(memTx().tx);
    const claude = {
      id: '',
      role: 'claude',
      kind: 'text',
      text: 'the reply the owner quotes',
      ts: 500,
      seq: 3,
      mid: 'mr-quoted'
    } as CycEngineMessage;
    await rowStore.upsert(SID, [messageRow(SID, claude)]);
    let win = await rowStore.openWindow(SID, 300);
    const s = seat(win.messages);

    // Build the reply target from the painted bubble: it KEYS ON THE ID.
    const target = replyTargetFor(s, win.messages[0]);
    expect(target.id).toBe('m:mr-quoted');
    expect(target.id).not.toBe(String(target.ts));

    // A renumber re-serves the row under a new seq; then a reload rebuilds it
    // from the backing. The id the reply keyed on is unchanged, and resolves.
    await rowStore.upsert(SID, [messageRow(SID, {...claude, seq: 42} as CycEngineMessage)]);
    rowStore.close(SID);
    win = await rowStore.openWindow(SID, 300);
    seat(win.messages);

    const resolved = findLocal(SID, target.id!);
    expect(resolved?.text).toBe('the reply the owner quotes');
    // Resolution is by identity, never by the target's stored instant.
    expect(resolved?.id).toBe(target.id);
  });
});
