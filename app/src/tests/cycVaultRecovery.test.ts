import {beforeEach, describe, expect, test, vi} from 'vitest';

// The recovery sweep after a reload: an unclaimed recording goes back in the
// composer with a toast; bytes a transfer parked whose send IS committed (an
// intent on disk names them) are a message's and must NOT come back, whatever
// their kind. But transfer-parked bytes with NO committed send intent (the E1
// window: killed after the settlement queued the clip, before commitVoiceNote
// wrote its intent) are the user's recording with no message to resume into:
// they are reclaimed from the queue and restored visibly.
const parked: Record<string, unknown>[] = [];
const vaultUpdates: {key: string; patch: Record<string, unknown>}[] = [];
vi.mock('../audio/clipVault', () => ({
  list: async () => parked,
  update: vi.fn(async (key: string, patch: Record<string, unknown>) => {
    vaultUpdates.push({key, patch});
  })
}));
vi.mock('../features/composer/persistence/vault', () => ({
  list: async (): Promise<unknown[]> => []
}));
vi.mock('../engine/store', () => ({
  get: (id: string) => ({id}),
  subscribe: () => () => {}
}));
const intentRows: {id: string; kind: string; payload: unknown}[] = [];
vi.mock('../engine/intents', () => ({
  hydrate: async () => intentRows,
  get: (id: string) => intentRows.find((i) => i.id === id),
  all: () => intentRows,
  isSendKind: (k: string) => k === 'send-text' || k === 'send-voice' || k === 'send-files'
}));
const reclaimed: string[] = [];
const settledRows = new Set<string>(); // keys whose row is done/gone: reclaim refuses
vi.mock('../engine/transfers/worker', () => ({
  hydrateTransfers: async (): Promise<unknown[]> => [],
  reclaim: (key: string) => {
    if (settledRows.has(key)) return false;
    reclaimed.push(key);
    return true;
  }
}));
const toasts: string[] = [];
vi.mock('../components/widgets', () => ({
  toast: (s: string) => {
    toasts.push(s);
  }
}));
vi.mock('../shared/logging', () => ({cyclog: () => {}, setLogAutoShip: () => {}}));

import {installVaultRecovery} from '../features/composer/voice/vaultRecovery';
import {dataState, orphanSweep} from '../sessionState';

const blob = new Blob([new Uint8Array(16)], {type: 'audio/webm'});
const rec = (key: string, extra: Record<string, unknown> = {}) => ({
  key,
  sessionId: 's1',
  blob,
  mime: 'audio/webm',
  bytes: 16,
  ts: Date.now(),
  tries: 0,
  ...extra
});

const flush = async () => {
  for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0));
};

const install = () => {
  const restoreVoiceBlock = vi.fn();
  const vaultKeyOf = new WeakMap<File, string>();
  installVaultRecovery({
    putBlocksBack: vi.fn(),
    restoreVoiceBlock,
    clipCid: new WeakMap(),
    vaultKeyOf
  });
  return {restoreVoiceBlock, vaultKeyOf};
};

describe('vault recovery after a reload', () => {
  beforeEach(() => {
    parked.length = 0;
    toasts.length = 0;
    intentRows.length = 0;
    reclaimed.length = 0;
    vaultUpdates.length = 0;
    settledRows.clear();
    orphanSweep.started = false;
    dataState.mode = 'live';
  });

  test('a committed voice note (transfer parked, intent on disk) is never put back; a plain orphan is', async () => {
    parked.push(rec('sent-voice', {transfer: true}));
    parked.push(rec('sent-file', {transfer: true, attachment: true}));
    parked.push(rec('orphan'));
    intentRows.push({
      id: 'sent-voice',
      kind: 'send-voice',
      payload: {cid: 'sent-voice', transferKey: 'sent-voice', clipKey: 'sent-voice'}
    });
    const {restoreVoiceBlock} = install();
    await flush();
    expect(restoreVoiceBlock).toHaveBeenCalledTimes(1);
    expect(restoreVoiceBlock.mock.calls[0][0]).toBe('s1');
    expect((restoreVoiceBlock.mock.calls[0][1] as File).name).toBe('voice-orphan.webm');
    expect(toasts).toEqual(['Recovered a recording from before the reload']);
    // The committed note stays the transfer queue's: never reclaimed.
    expect(reclaimed).toEqual([]);
  });

  test('E1: transfer parked, NO intent: reclaimed from the queue and restored visibly', async () => {
    parked.push(rec('e1-clip', {transfer: true, durationS: 4, cid: 'cap-1'}));
    const {restoreVoiceBlock, vaultKeyOf} = install();
    await flush();
    // Non-vacuous against the committed case above: same record shape, the
    // only difference is the missing intent, and the outcome flips.
    expect(reclaimed).toEqual(['e1-clip']);
    expect(vaultUpdates).toContainEqual({key: 'e1-clip', patch: {transfer: false}});
    expect(restoreVoiceBlock).toHaveBeenCalledTimes(1);
    expect(restoreVoiceBlock.mock.calls[0][0]).toBe('s1');
    const file = restoreVoiceBlock.mock.calls[0][1] as File;
    expect(file.name).toBe('voice-cap-1.webm');
    // The restored file carries its vault key: a later composition persist
    // reuses the parked bytes under the SAME key instead of parking a second
    // copy, and the send that follows moves exactly one transfer.
    expect(vaultKeyOf.get(file)).toBe('e1-clip');
    expect(toasts).toEqual(['Recovered a recording from before the reload']);
  });

  test('E1 is skipped when the intent names the key in its payload only', async () => {
    parked.push(rec('by-payload', {transfer: true}));
    intentRows.push({
      id: 'other-cid',
      kind: 'send-voice',
      payload: {cid: 'other-cid', transferKey: 'by-payload'}
    });
    const {restoreVoiceBlock} = install();
    await flush();
    expect(reclaimed).toEqual([]);
    expect(restoreVoiceBlock).not.toHaveBeenCalled();
    expect(toasts).toEqual([]);
  });

  test('a settled row (done or gone) is not reclaimable: nothing restored', async () => {
    parked.push(rec('landed', {transfer: true}));
    settledRows.add('landed');
    const {restoreVoiceBlock} = install();
    await flush();
    expect(restoreVoiceBlock).not.toHaveBeenCalled();
    expect(vaultUpdates).toEqual([]);
    expect(toasts).toEqual([]);
  });

  test('only committed transfer-parked bytes in the vault: nothing restored, no toast', async () => {
    parked.push(rec('sent-voice', {transfer: true}));
    intentRows.push({
      id: 'sent-voice',
      kind: 'send-voice',
      payload: {cid: 'sent-voice', transferKey: 'sent-voice'}
    });
    const {restoreVoiceBlock} = install();
    await flush();
    expect(restoreVoiceBlock).not.toHaveBeenCalled();
    expect(toasts).toEqual([]);
  });
});
