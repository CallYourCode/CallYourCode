// The deploy-crossing seam (fix-oneid, defect 3). The CURRENTLY DEPLOYED build
// (master) keyed an own-send row by its engine mid `m:<mid>` (master
// rowIdOfMessage ignored the cid). fix-oneid keys the same own send by its cid
// `m:c:<cid>`. Every real device crosses this once at deploy: it restores rows
// written under the OLD key, then the engine re-serves the tail under the NEW
// key. Without a rekey the two spellings twin every delivered own send, durably.
//
// Fail-before (on 80b12b4): the runtime-fold case below twins (two rows). The
// durable-rekey and crash-mid-migration cases exercise rekeyDurableRowsToOneId,
// which does not exist on 80b12b4. After this branch every case is ONE row per
// message, no blank window, no orphaned old-key record, and reply/copy
// resolution lands on the single row (its id derives from its own facts).

import {afterEach, describe, expect, test} from 'vitest';
import * as rowStore from '../engine/store/rows/rowStore';
import {rowIdOfMessage} from '../engine/store/rows/core';
import {rowsFromPage} from '../engine/store/rows/replicator';
import {sessions} from '../engine/store/registry';
import type {CycEngineMessage} from '../engine/store/types';
import type {EnginePage} from '../engine/contract';
import {memTx} from './rowStoreFake';

const SID = 'eng|deploy';

afterEach(() => {
  rowStore.__setBackingForTest(null);
  rowStore.close(SID);
  sessions.delete(SID);
});

// A durable backing in the MASTER shape: an own-send user row that carried a cid
// AND a mid, persisted keyed on the MID (`m:<mid>`), its payload msg.id a NUMERIC
// render id, plus the idx tuple master wrote. This is exactly what a device that
// ran master leaves on disk.
function masterOwnSend(db: Map<string, {key: string}>): {mid: string; cid: string} {
  const mid = 'mr-own';
  const cid = 'own-cid';
  const oldId = `m:${mid}`;
  const oldMsg = {
    id: 12345, // master's numeric render id
    role: 'user',
    kind: 'text',
    text: 'my own send',
    ts: 1000,
    seq: 7,
    cid,
    mid,
    dedupeKey: `mid:${mid}`,
    status: 'delivered'
  } as unknown as CycEngineMessage;
  db.set(`${SID}|r|${oldId}`, {
    key: `${SID}|r|${oldId}`,
    id: oldId,
    sessionId: SID,
    seq: 7,
    ts: 1000,
    kind: 'msg',
    msg: oldMsg
  } as never);
  db.set(`${SID}|idx`, {
    key: `${SID}|idx`,
    sessionId: SID,
    tuples: [{id: oldId, seq: 7, ts: 1000, kind: 'msg'}]
  } as never);
  return {mid, cid};
}

// The engine re-serves the tail on attach. Under the new code the same message is
// keyed `m:c:<cid>` because it carries the cid; the re-serve carries BOTH cid and
// mid, exactly as deliver.ts persists them on the user row.
function reservePage(): StoreReserve {
  const page: EnginePage = {
    page: 0,
    version: 1,
    sealed: false,
    events: [],
    messages: [
      {
        id: SID,
        role: 'user',
        text: 'my own send',
        ts: 1000,
        seq: 7,
        cid: 'own-cid',
        mid: 'mr-own',
        dedupeKey: 'mid:mr-own',
        status: 'delivered'
      }
    ] as unknown as EnginePage['messages']
  };
  return rowsFromPage(SID, page);
}
type StoreReserve = ReturnType<typeof rowsFromPage>;

describe('deploy crossing: old m:<mid> record, new m:c:<cid> re-serve', () => {
  test('runtime fold: an own send restored under the OLD mid key does not twin against a fresh cid-keyed re-serve', async () => {
    const {db, tx} = memTx();
    rowStore.__setBackingForTest(tx);
    masterOwnSend(db);

    // Boot under the NEW code WITHOUT the durable rekey (a row that reaches the
    // store by a path the migration did not touch): the runtime fold must still
    // converge to one row.
    let win = await rowStore.openWindow(SID, 300);
    expect(win.messages).toHaveLength(1);
    expect(win.messages[0].text).toBe('my own send');

    await rowStore.upsert(SID, reservePage());

    const m = rowStore.__mirror(SID)!;
    const msgTuples = m.idx.filter((t) => t.kind === 'msg');
    expect(msgTuples).toHaveLength(1);
    expect(msgTuples[0].id).toBe('m:c:own-cid');

    win = await rowStore.openWindow(SID, 300);
    expect(win.messages.filter((x) => x.text === 'my own send')).toHaveLength(1);
    // Reply/copy resolves by the one id, which derives from the row's own facts.
    const only = win.messages[0];
    expect(only.id).toBe('m:c:own-cid');
    expect(rowIdOfMessage(only)).toBe(only.id);
    expect(typeof only.id).toBe('string');

    // No orphaned old-key record survives in the backing.
    expect(db.has(`${SID}|r|m:mr-own`)).toBe(false);
    expect(db.has(`${SID}|r|m:c:own-cid`)).toBe(true);
  });

  test('durable rekey: rewrites the old master record to the one id before any attach', async () => {
    const {db, tx} = memTx();
    rowStore.__setBackingForTest(tx);
    masterOwnSend(db);

    const res = await rowStore.rekeyDurableRowsToOneId();
    expect(res).toEqual({sessions: 1, rekeyed: 1});

    // The record moved under the new key, the old key is gone, the idx tuple was
    // re-derived, and the payload's numeric id was stamped to the string.
    expect(db.has(`${SID}|r|m:mr-own`)).toBe(false);
    const rec = db.get(`${SID}|r|m:c:own-cid`) as unknown as {msg: CycEngineMessage} | undefined;
    expect(rec).toBeDefined();
    expect(rec!.msg.id).toBe('m:c:own-cid');
    const idx = db.get(`${SID}|idx`) as unknown as {tuples: Array<{id: string}>};
    expect(idx.tuples.map((t) => t.id)).toEqual(['m:c:own-cid']);

    // Idempotent: a re-run derives the same id and changes nothing.
    expect(await rowStore.rekeyDurableRowsToOneId()).toEqual({sessions: 0, rekeyed: 0});

    // Now the attach re-serve lands on the already-rekeyed row: still one row.
    let win = await rowStore.openWindow(SID, 300);
    expect(win.messages).toHaveLength(1);
    await rowStore.upsert(SID, reservePage());
    win = await rowStore.openWindow(SID, 300);
    expect(win.messages).toHaveLength(1);
    expect(win.messages[0].id).toBe('m:c:own-cid');
    expect(rowStore.__mirror(SID)!.idx.filter((t) => t.kind === 'msg')).toHaveLength(1);
  });

  test('rekey over a backing already holding BOTH spellings leaves ONE tuple and ONE painted row', async () => {
    const {db, tx} = memTx();
    rowStore.__setBackingForTest(tx);
    // The compounded state: a crash-mid-migration survivor (the old m:<mid>
    // record) AND a raced admit that already wrote the new m:c:<cid> record, so
    // the idx carries BOTH spellings for the SAME message when the rekey re-runs.
    masterOwnSend(db); // old m:mr-own record + idx tuple, numeric payload id
    const newId = 'm:c:own-cid';
    db.set(`${SID}|r|${newId}`, {
      key: `${SID}|r|${newId}`,
      id: newId,
      sessionId: SID,
      seq: 7,
      ts: 1000,
      kind: 'msg',
      msg: {
        id: newId,
        role: 'user',
        kind: 'text',
        text: 'my own send',
        ts: 1000,
        seq: 7,
        cid: 'own-cid',
        mid: 'mr-own',
        dedupeKey: 'mid:mr-own',
        status: 'delivered'
      } as unknown as CycEngineMessage
    } as never);
    // The idx holds both the old and the target new tuple for the one message.
    db.set(`${SID}|idx`, {
      key: `${SID}|idx`,
      sessionId: SID,
      tuples: [
        {id: 'm:mr-own', seq: 7, ts: 1000, kind: 'msg'},
        {id: newId, seq: 7, ts: 1000, kind: 'msg'}
      ]
    } as never);

    await rowStore.rekeyDurableRowsToOneId();

    // The remap dedupes: the idx ends with ONE tuple, not two identical ones.
    const idx = db.get(`${SID}|idx`) as unknown as {tuples: Array<{id: string}>};
    expect(idx.tuples.map((t) => t.id)).toEqual([newId]);
    expect(db.has(`${SID}|r|m:mr-own`)).toBe(false);

    // And project() paints ONE row, no durable twin.
    const win = await rowStore.openWindow(SID, 300);
    expect(win.messages.filter((x) => x.text === 'my own send')).toHaveLength(1);
    expect(win.messages[0].id).toBe(newId);
  });

  test('crash mid-migration: a half-rekeyed backing restores without twinning', async () => {
    const {db, tx} = memTx();
    rowStore.__setBackingForTest(tx);
    // Two own sends in the master shape; simulate the durable rekey having
    // rewritten ONLY the first before the page died. The second is still keyed on
    // its mid, and the idx carries the new key for the first and the old for the
    // second.
    const cidA = 'cid-a';
    const cidB = 'cid-b';
    const mkMsg = (n: number, cid: string, mid: string, id: unknown): CycEngineMessage =>
      ({
        id,
        role: 'user',
        kind: 'text',
        text: `send ${n}`,
        ts: 1000 + n,
        seq: 7 + n,
        cid,
        mid,
        dedupeKey: `mid:${mid}`,
        status: 'delivered'
      }) as unknown as CycEngineMessage;
    // First already rekeyed to the new key + stamped string id.
    db.set(`${SID}|r|m:c:${cidA}`, {
      key: `${SID}|r|m:c:${cidA}`,
      id: `m:c:${cidA}`,
      sessionId: SID,
      seq: 8,
      ts: 1001,
      kind: 'msg',
      msg: mkMsg(1, cidA, 'mid-a', `m:c:${cidA}`)
    } as never);
    // Second still in the master shape (old key, numeric payload id).
    db.set(`${SID}|r|m:mid-b`, {
      key: `${SID}|r|m:mid-b`,
      id: 'm:mid-b',
      sessionId: SID,
      seq: 9,
      ts: 1002,
      kind: 'msg',
      msg: mkMsg(2, cidB, 'mid-b', 999)
    } as never);
    db.set(`${SID}|idx`, {
      key: `${SID}|idx`,
      sessionId: SID,
      tuples: [
        {id: `m:c:${cidA}`, seq: 8, ts: 1001, kind: 'msg'},
        {id: 'm:mid-b', seq: 9, ts: 1002, kind: 'msg'}
      ]
    } as never);

    // Restore and re-serve BOTH sends (each carrying its cid + mid), without
    // finishing the migration: the runtime fold catches the un-rekeyed one.
    let win = await rowStore.openWindow(SID, 300);
    expect(win.messages).toHaveLength(2);
    const page: EnginePage = {
      page: 0,
      version: 1,
      sealed: false,
      events: [],
      messages: [
        {id: SID, role: 'user', text: 'send 1', ts: 1001, seq: 8, cid: cidA, mid: 'mid-a'},
        {id: SID, role: 'user', text: 'send 2', ts: 1002, seq: 9, cid: cidB, mid: 'mid-b'}
      ] as unknown as EnginePage['messages']
    };
    await rowStore.upsert(SID, rowsFromPage(SID, page));

    win = await rowStore.openWindow(SID, 300);
    expect(win.messages).toHaveLength(2);
    expect(win.messages.map((x) => x.id).sort()).toEqual([`m:c:${cidA}`, `m:c:${cidB}`]);
    // No orphaned old-key record remains.
    expect(db.has(`${SID}|r|m:mid-b`)).toBe(false);
  });
});
