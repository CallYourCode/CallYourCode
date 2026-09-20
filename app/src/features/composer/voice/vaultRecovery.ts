import * as clipVault from '../../../audio/clipVault';
import type {ParkedClip} from '../../../audio/clipVault';
import * as composerVault from '../persistence/vault';
import {toast} from '../../../components/widgets';
import * as engine from '../../../engine/store';
import * as intents from '../../../engine/intents';
import * as transfers from '../../../engine/transfers/worker';
import {dataState, orphanSweep, sessionState} from '../../../sessionState';
import {cyclog} from '../../../shared/logging';
import type {ComposerBlock, VoiceClip} from '../components/messageComposer';
import type {VoiceCaptureDeps} from './captureState';

export function installVaultRecovery({
  putBlocksBack,
  restoreVoiceBlock,
  clipCid,
  vaultKeyOf
}: Pick<VoiceCaptureDeps, 'putBlocksBack' | 'restoreVoiceBlock' | 'clipCid' | 'vaultKeyOf'>): void {
  if (orphanSweep.started) return;
  orphanSweep.started = true;
  void recoverVault({putBlocksBack, restoreVoiceBlock, clipCid, vaultKeyOf});
}

async function recoverVault({
  putBlocksBack,
  restoreVoiceBlock,
  clipCid,
  vaultKeyOf
}: Pick<
  VoiceCaptureDeps,
  'putBlocksBack' | 'restoreVoiceBlock' | 'clipCid' | 'vaultKeyOf'
>): Promise<void> {
  // Bytes parked by the transfer queue (a voice note already sent, an
  // attachment) are a message's, never the composer's: they are not recordings
  // to put back in the box. The transfer row resumes them after the reload.
  // The one exception (E1) is handled below: transfer-parked bytes that no
  // committed send intent names have no message to resume into.
  const recordings = (await clipVault.list()).filter((record) => !record.attachment);
  const orphans = recordings.filter((record) => !record.transfer);
  const parked = new Map(orphans.map((record) => [record.key, record]));
  const claimed = new Set<string>();
  for (const composition of await composerVault.list()) {
    const blocks: ComposerBlock[] = [];
    const lost: string[] = [];
    for (const block of composition.blocks) {
      if (block.kind === 'reply' || block.kind === 'quote') {
        blocks.push(block);
        continue;
      }
      if (block.kind === 'prompt') {
        // Reading the old `block.bit` shape is a PERMANENT storage reader, not
        // compat awaiting cleanup: a user-typed draft saved to IDB before the
        // field was flattened to `block.text` still carries `bit`, and the
        // MAX_COMPOSITIONS (8) cap on the composer vault bounds how many such
        // rows can ever exist. New text always writes `block.text`.
        const legacy = (block as unknown as {bit?: {text?: string}}).bit;
        const text = typeof block.text === 'string' ? block.text : (legacy?.text ?? '');
        if (text) blocks.push({kind: 'prompt', text});
        continue;
      }
      if (block.kind === 'attach') {
        blocks.push({
          kind: 'attach',
          staged: {
            file: block.file,
            upload: null,
            progress: 0,
            done: false,
            error: null,
            fromPage: block.fromPage,
            durationS: block.durationS
          }
        });
        continue;
      }
      const record = parked.get(block.vaultKey);
      if (!record) {
        lost.push(block.vaultKey);
        continue;
      }
      claimed.add(record.key);
      const file = new File([record.blob], `voice-${record.cid ?? record.key}.webm`, {
        type: block.mime || record.mime || 'audio/webm'
      });
      vaultKeyOf.set(file, record.key);
      if (record.cid) clipCid.set(file, record.cid);
      blocks.push({
        kind: 'voice',
        clip: {...block.clip, blob: record.blob, restored: true},
        staged: {
          file,
          upload: null,
          progress: 0,
          done: false,
          error: null,
          durationS: block.clip.durationS
        }
      });
    }
    cyclog('composition.vault.restored', {
      session: composition.sessionId,
      blocks: blocks.map((block) => block.kind),
      bytes: composition.bytes,
      ageMs: Date.now() - composition.ts,
      open: sessionState.activeId === composition.sessionId,
      ...(lost.length ? {droppedClips: lost} : {})
    });
    putBlocksBack(composition.sessionId, blocks);
  }
  if (dataState.mode !== 'live') return;
  // E1: a dictation killed in the pre-commit window (the settlement parked and
  // queued the clip, the tab died before commitVoiceNote wrote its intent)
  // leaves transfer-parked bytes that NO intent and NO message names. Left
  // alone, the worker would move them to the engine as an orphan nobody
  // references and then release the local copy: the recording would vanish
  // silently. Instead they are taken back from the queue and restored to the
  // composer below, exactly like the old restore path.
  const stranded = await reclaimUncommitted(recordings.filter((record) => record.transfer));
  const pool = [...orphans, ...stranded].sort((a, b) => a.ts - b.ts);
  if (!pool.length) return;
  const unclaimed = pool.filter((record) => !claimed.has(record.key));
  if (!unclaimed.length) return;
  for (const record of unclaimed) {
    const restored = record.restored ?? 0;
    if (restored >= 3) continue;
    if (!(await waitForSession(record.sessionId))) {
      await clipVault.update(record.key, {tries: record.tries + 1});
      continue;
    }
    const file = new File([record.blob], `voice-${record.cid ?? record.key}.webm`, {
      type: record.mime || 'audio/webm'
    });
    vaultKeyOf.set(file, record.key);
    restoreVoiceBlock(record.sessionId, file, {
      durationS: record.durationS ?? 0,
      text: '',
      blob: record.blob,
      restored: true
    } as VoiceClip);
    await clipVault.update(record.key, {restored: restored + 1});
    toast(
      record.sent
        ? 'Recovered a recording (its words were already sent)'
        : 'Recovered a recording from before the reload'
    );
  }
}

// The transfer-parked recordings whose send was never committed: no send
// intent on disk names their key. Each is reclaimed from the transfer queue
// (row removed, bytes kept, an engine-side partial DELETEd best-effort) and
// its vault record loses the transfer flag, so this recovery and every later
// one treat it as an ordinary composer recording. A record whose row is done
// or gone is left alone: the worker settled those bytes already and its
// release is in flight. Returns the reclaimed records, transfer flag cleared.
async function reclaimUncommitted(records: ParkedClip[]): Promise<ParkedClip[]> {
  if (!records.length) return [];
  // The verdict must come from the durable stores, not the boot race: an
  // intent or a transfer row still being read from disk counts.
  await Promise.all([intents.hydrate(), transfers.hydrateTransfers()]);
  const out: ParkedClip[] = [];
  for (const record of records) {
    if (hasSendIntent(record.key)) continue; // committed: the queue resumes it
    if (!transfers.reclaim(record.key)) {
      cyclog('clip.vault.uncommitted-settled', {
        key: record.key,
        session: record.sessionId,
        why:
          'no send intent names these bytes, but their transfer already settled ' +
          '(done or gone): the worker owns their release, nothing to restore'
      });
      continue;
    }
    await clipVault.update(record.key, {transfer: false});
    cyclog('clip.vault.uncommitted-reclaimed', {
      key: record.key,
      session: record.sessionId,
      bytes: record.bytes,
      why:
        'transfer parked but no send intent reached disk (killed in the pre-commit ' +
        'window); the recording goes back to the composer instead of orphaning'
    });
    out.push({...record, transfer: false});
  }
  return out;
}

// A committed send that names these bytes: the intent whose id IS the key
// (a voice note's cid == its transfer key on every writer), or defensively
// any send intent whose payload references the key.
function hasSendIntent(key: string): boolean {
  if (intents.get(key)) return true;
  return intents.all().some((i) => {
    if (!intents.isSendKind(i.kind)) return false;
    const p = i.payload as
      {transferKey?: string; clipKey?: string; transferKeys?: string[]} | undefined;
    return p?.transferKey === key || p?.clipKey === key || p?.transferKeys?.includes(key) === true;
  });
}

function waitForSession(id: string): Promise<boolean> {
  return new Promise((resolve) => {
    if (engine.get(id)) {
      resolve(true);
      return;
    }
    let done = false;
    const finish = (ok: boolean) => {
      if (done) return;
      done = true;
      off();
      clearTimeout(timer);
      resolve(ok);
    };
    const off = engine.subscribe(() => {
      if (engine.get(id)) finish(true);
    });
    const timer = window.setTimeout(() => finish(false), 90_000);
  });
}
