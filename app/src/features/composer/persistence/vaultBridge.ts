import type {ComposerBlock, VoiceClip} from '../components/messageComposer';
import type {StoredBlock} from './vault';
import * as composerVault from './vault';
import * as clipVault from '../../../audio/clipVault';
import {cyclog} from '@/shared/logging';
import {CLIPS, COMPOSITIONS} from '@/shared/browser';
import type {Alongside} from '../../../engine/store';
import {vaultHolds} from '../../../sessionState';

interface ComposerBoxHandle {
  getBlocks(): ComposerBlock[];
  setBlocks(blocks: ComposerBlock[]): void;
  getDraft(): string;
  setDraft(text: string): void;
}

export function createComposerVaultBridge(deps: {box(): ComposerBoxHandle}) {
  const {box} = deps;

  const vaultKeyOf = new WeakMap<File, string>();

  const DRAFTS_KEY = 'cyc-drafts';
  type PersistedDraft = {text: string; revision: number};
  type Drafts = Record<string, PersistedDraft>;
  // null is distinct from an empty store. A caller that must remove a draft
  // cannot safely do so after a failed read.
  const tryReadDrafts = (): Drafts | null => {
    try {
      const raw = JSON.parse(localStorage.getItem(DRAFTS_KEY) || '{}') as unknown;
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
      return Object.fromEntries(
        Object.entries(raw).flatMap(([id, value]) => {
          if (typeof value === 'string') return [[id, {text: value, revision: 0}]];
          if (
            value &&
            typeof value === 'object' &&
            typeof (value as PersistedDraft).text === 'string' &&
            Number.isSafeInteger((value as PersistedDraft).revision) &&
            (value as PersistedDraft).revision >= 0
          )
            return [[id, value as PersistedDraft]];
          return [];
        })
      );
    } catch {
      return null;
    }
  };
  const readDrafts = (): Drafts => tryReadDrafts() ?? {};
  const drafts = readDrafts();
  let draftOwner: string | null = null;

  const MAX_DRAFTS = 60;
  const writeDrafts = (next: Drafts): boolean => {
    const keys = Object.keys(next);
    if (keys.length > MAX_DRAFTS) {
      for (const k of keys.slice(0, keys.length - MAX_DRAFTS)) delete next[k];
    }
    try {
      localStorage.setItem(DRAFTS_KEY, JSON.stringify(next));
      return true;
    } catch {
      return false;
    }
  };

  // Every shared-draft read/modify/write uses this lock. The synchronous path
  // is for browsers without Web Locks; its operation re-reads immediately
  // before writing so it does not delete from a stale snapshot.
  const withDraftLock = (work: () => void) => {
    const locks = navigator.locks;
    if (!locks) {
      work();
      return;
    }
    void locks.request(DRAFTS_KEY, work).catch(() => work());
  };

  const stagedFor = new Map<string, ComposerBlock[]>();
  const MAX_STAGED = 8;

  /* Compositions with changes NOT yet settled in the vault. Only these hold a
   * reload: a block restored from the vault, or already written through
   * writeComposition, survives a reload by definition (the vault's own save
   * log says so). The old anyBlocksHeld counted every staged block, so one
   * fossil restored draft for a dead session held the update reload forever
   * (fkfm3, 2026-09-06, named live by reload.deferred unsent=true). */
  const unsettled = new Set<string>();

  const saveDraft = () => {
    if (!draftOwner) return;

    const owner = draftOwner;
    const held = box().getBlocks();
    stagedFor.delete(owner);
    if (held.length) stagedFor.set(owner, held);
    while (stagedFor.size > MAX_STAGED) stagedFor.delete(stagedFor.keys().next().value as string);

    const text = box().getDraft();
    withDraftLock(() => {
      const current = tryReadDrafts();
      if (!current) return;
      const previous = current[owner];
      if (text === (previous?.text ?? '')) {
        if (previous) drafts[owner] = previous;
        else delete drafts[owner];
        return;
      }
      if (text) {
        // Resetting to zero at the safe-integer edge keeps every persisted
        // revision readable. Identity also includes text, so this reset never
        // makes an earlier dispatched draft equal to the new one.
        const revision =
          previous && previous.revision === Number.MAX_SAFE_INTEGER
            ? 0
            : (previous?.revision ?? -1) + 1;
        const saved = {text, revision};
        current[owner] = saved;
        if (!writeDrafts(current)) return;
        drafts[owner] = saved;
      } else {
        delete current[owner];
        if (!writeDrafts(current)) return;
        delete drafts[owner];
      }
    });
  };

  const loadDraft = (id: string | null) => {
    draftOwner = id;
    const current = id ? readDrafts()[id] : undefined;
    if (id) {
      if (current) drafts[id] = current;
      else delete drafts[id];
    }
    box().setDraft(current?.text ?? '');
    box().setBlocks(id ? (stagedFor.get(id) ?? []) : []);
  };

  const clipCid = new WeakMap<File, string>();

  const RETRY_MS = [500, 2_000, 8_000, 30_000, 120_000, 300_000];
  const retried = new Map<string, number>();
  const retryComposition = (sessionId: string, key: string) => {
    const n = retried.get(sessionId) ?? 0;
    if (n >= RETRY_MS.length) {
      cyclog('clip.vault.retry-exhausted', {
        session: sessionId,
        key,
        attempts: n,
        why:
          'the vault refused this recording on every attempt over five minutes; it ' +
          "is in the box and in this page's memory only, and a reload will lose it"
      });
      return;
    }
    retried.set(sessionId, n + 1);
    cyclog('clip.vault.retry', {
      session: sessionId,
      key,
      attempt: n + 1,
      inMs: RETRY_MS[n],
      why:
        'the vault refused this recording, so the composition write is asked again: ' +
        'a store that is unavailable now (a blocked upgrade, a frozen tab) is often ' +
        'available in a moment'
    });
    window.setTimeout(() => {
      void persistComposition(sessionId);
    }, RETRY_MS[n]);
  };

  const vaultKeyFor = async (
    file: File,
    sessionId: string,
    clip: VoiceClip
  ): Promise<string | null> => {
    const had = vaultKeyOf.get(file);
    if (had) return had;
    const key = clipCid.get(file) ?? crypto.randomUUID?.() ?? `k${Date.now()}-${Math.random()}`;

    vaultKeyOf.set(file, key);
    vaultHolds.writing++;
    const ok = await clipVault
      .park({
        key,
        cid: clipCid.get(file),
        sessionId,
        blob: file,
        mime: file.type || 'audio/webm',
        durationS: clip.durationS,
        ts: Date.now()
      })
      .finally(() => {
        vaultHolds.writing--;
      });
    if (ok) {
      retried.delete(sessionId);
      return key;
    }

    vaultKeyOf.delete(file);
    retryComposition(sessionId, key);
    return null;
  };

  const storable = async (sessionId: string, blocks: ComposerBlock[]): Promise<StoredBlock[]> => {
    const out: StoredBlock[] = [];
    for (const b of blocks) {
      if (b.kind === 'reply' || b.kind === 'quote' || b.kind === 'prompt') {
        out.push(b);
        continue;
      }
      if (b.kind === 'attach') {
        out.push({
          kind: 'attach',
          file: b.staged.file,
          ...(b.staged.fromPage ? {fromPage: b.staged.fromPage} : {}),
          ...(b.staged.durationS ? {durationS: b.staged.durationS} : {})
        });
        continue;
      }
      const file = b.staged?.file;
      if (!file) {
        continue;
      }
      const key = await vaultKeyFor(file, sessionId, b.clip);
      if (!key) continue;

      out.push({kind: 'voice', clip: {...b.clip, blob: null}, vaultKey: key, mime: file.type});
    }
    return out;
  };

  const blocksOf = (id: string): ComposerBlock[] =>
    id === draftOwner ? box().getBlocks() : (stagedFor.get(id) ?? []);

  clipVault.holding(() => {
    const keys = new Set<string>();
    const ids = new Set(stagedFor.keys());
    if (draftOwner) ids.add(draftOwner);
    for (const id of ids) {
      for (const b of blocksOf(id)) {
        if (b.kind !== 'voice') continue;
        const file = b.staged?.file;
        const key = file && vaultKeyOf.get(file);
        if (key) keys.add(key);
      }
    }
    return keys;
  });

  composerVault.holding(() => {
    const ids = new Set(stagedFor.keys());
    if (draftOwner) ids.add(draftOwner);

    return new Set([...ids].filter((id) => blocksOf(id).length > 0));
  });

  const writeComposition = async (sessionId: string) => {
    const held = blocksOf(sessionId);
    const stored = await storable(sessionId, held);
    /* Complete = every voice block made it into the row (a clip the vault
     * refused is excluded by storable and retried; until it lands, this
     * composition is genuinely at risk across a reload and stays unsettled). */
    const voiceHeld = held.filter((b) => b.kind === 'voice' && b.staged?.file).length;
    const voiceStored = stored.filter((b) => b.kind === 'voice').length;
    const previous = stored.length
      ? await composerVault.save(sessionId, stored)
      : await composerVault.get(sessionId).then(async (p) => {
          if (p) await composerVault.drop(sessionId, 'the box for this chat is empty now');
          return p;
        });
    if (voiceStored >= voiceHeld) unsettled.delete(sessionId);
    if (!previous) return;
    const keeping = new Set(
      stored.filter((b) => b.kind === 'voice').map((b) => (b as {vaultKey: string}).vaultKey)
    );
    for (const b of previous.blocks) {
      if (b.kind !== 'voice' || keeping.has(b.vaultKey)) continue;

      void clipVault.release(
        b.vaultKey,
        'this recording is no longer part of the composition it was parked for',
        {session: sessionId}
      );
    }
  };

  const MIN_WRITE_GAP_MS = 300;
  const writing = new Map<string, {again: boolean}>();
  const persistComposition = async (sessionId: string) => {
    unsettled.add(sessionId); // a persist request means something changed
    const running = writing.get(sessionId);
    if (running) {
      running.again = true;
      return;
    }
    const mine = {again: false};
    writing.set(sessionId, mine);
    try {
      do {
        mine.again = false;
        await writeComposition(sessionId);
        if (mine.again) await new Promise((r) => setTimeout(r, MIN_WRITE_GAP_MS));
      } while (mine.again);
    } finally {
      writing.delete(sessionId);
    }
  };

  const putBlocksBack = (sessionId: string, add: ComposerBlock[]) => {
    if (!add.length) return;

    if (draftOwner === sessionId) saveDraft();
    const held = [...(stagedFor.get(sessionId) ?? []), ...add];

    stagedFor.delete(sessionId);
    stagedFor.set(sessionId, held);
    while (stagedFor.size > MAX_STAGED) stagedFor.delete(stagedFor.keys().next().value as string);
    if (draftOwner === sessionId) loadDraft(sessionId);

    void persistComposition(sessionId);
  };

  const restoreVoiceBlock = (sessionId: string, file: File, clip: VoiceClip) =>
    putBlocksBack(sessionId, [
      {
        kind: 'voice',
        clip,
        staged: {
          file,
          upload: null,
          progress: 0,
          done: false,
          error: null,
          durationS: clip.durationS
        }
      }
    ]);

  const sentChannel = 'BroadcastChannel' in window ? new BroadcastChannel('cyc-box-sent') : null;
  type DraftIdentity = {text: string; version: number};
  const sameDraft = (draft: PersistedDraft | undefined, sent: DraftIdentity) =>
    draft?.text === sent.text && draft.revision === sent.version;

  const forgetSentElsewhere = (id: string, sent: DraftIdentity) => {
    const local = drafts[id];
    const text = id === draftOwner ? box().getDraft() : (local?.text ?? '');
    const current = readDrafts();
    if (
      text !== sent.text ||
      !sameDraft(local, sent) ||
      (current[id] && !sameDraft(current[id], sent))
    )
      return;

    const blocks = blocksOf(id).length;
    const chars = text.length;
    if (!blocks && !chars) return;

    if (current[id]) {
      delete current[id];
      writeDrafts(current);
    }
    delete drafts[id];
    stagedFor.delete(id);
    unsettled.delete(id); // the other tab's send owns this composition now
    if (draftOwner === id) {
      box().setBlocks([]);
      box().setDraft('');
    }
    cyclog('composition.sent-in-another-tab', {
      session: id,
      blocks,
      chars,
      open: draftOwner === id,
      why:
        "another tab sent this chat's box, so this tab drops its copy: the next " +
        'write here would otherwise put a message already in the transcript back on disk'
    });
  };
  sentChannel?.addEventListener('message', (e: MessageEvent) => {
    const said = e.data as {sent?: unknown; draft?: unknown} | null;
    if (
      said &&
      typeof said.sent === 'string' &&
      said.draft &&
      typeof said.draft === 'object' &&
      typeof (said.draft as DraftIdentity).text === 'string' &&
      Number.isSafeInteger((said.draft as DraftIdentity).version)
    )
      forgetSentElsewhere(said.sent, said.draft as DraftIdentity);
  });

  // What a send from this chat's box supersedes on disk: the composition row
  // and the composer's parked copies of its recordings. They go in the send's
  // own transaction, as its intent row lands: a tab killed at any point holds
  // the message either in the box or as an intent, never as both.
  const sentAlongside = (id: string): Alongside => ({
    stores: [COMPOSITIONS, CLIPS],
    // The keys are read as the transaction opens: the box still holds the
    // blocks then (it clears once the write has settled), and a copy parked
    // after the send was pressed is caught too.
    run: (tx) => {
      tx.objectStore(COMPOSITIONS).delete(id);
      for (const b of blocksOf(id)) {
        const file = b.kind === 'voice' ? b.staged?.file : undefined;
        const key = file && vaultKeyOf.get(file);
        if (key) tx.objectStore(CLIPS).delete(key);
      }
    }
  });

  const draftIdentity = (id: string, text: string): DraftIdentity => {
    const current = readDrafts()[id];
    return {text, version: current?.text === text ? current.revision : (drafts[id]?.revision ?? 0)};
  };

  // After a send from this chat's box is on disk (its composition row went
  // with the intent's write): the in-memory copies and the text draft go.
  // A later input can already have replaced this send's draft, so remove only
  // the revision that was dispatched.
  const dropDraft = (id: string, sent?: DraftIdentity) => {
    withDraftLock(() => {
      // This read is inside the lock, and the fallback performs it immediately
      // before its write. A failed read leaves memory and other tabs unchanged.
      const current = tryReadDrafts();
      if (!current) return;
      if (sent && current[id] && !sameDraft(current[id], sent)) {
        sentChannel?.postMessage({sent: id, draft: sent});
        return;
      }

      if (current[id]) {
        delete current[id];
        if (!writeDrafts(current)) return;
      }
      stagedFor.delete(id);
      unsettled.delete(id); // the send's own write carried the blocks
      delete drafts[id];
      cyclog('composition.vault.dropped', {
        session: id,
        why: "the composition in this chat's box was sent; its row went with the send's own write"
      });
      // The durable deletion precedes the broadcast: a receiving tab may reload
      // while handling this message and must not read the sent words back.
      if (sent) sentChannel?.postMessage({sent: id, draft: sent});
    });
  };

  const anyBlocksHeld = (): boolean => unsettled.size > 0;

  return {
    draftOwner: () => draftOwner,
    saveDraft,
    loadDraft,
    dropDraft,
    draftIdentity,
    sentAlongside,
    persistComposition,
    putBlocksBack,
    restoreVoiceBlock,
    blocksOf,
    anyBlocksHeld,
    clipCid,
    vaultKeyOf
  };
}
