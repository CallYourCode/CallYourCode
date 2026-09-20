import * as intents from '../intents';
import type {Alongside, Intent, SendPayload} from '../intents';
import * as drain from '../sync/drain';
import type {DrainOutcome} from '../sync/drain';
import * as sync from '../sync';
import {cyclog} from '@/shared/logging';
import type {CycMessage, CycReplyTo} from '../../types';
import type {CycUpload} from '../contract';
import type {CycEngineMessage} from './types';
import {connOf, findLocal, notifyNow, sessions} from './registry';
import {stampRowId} from './rows/core';
import {sightLocalRow} from './readState';
import {retryVoiceClip} from './voiceUpload';
import {retryAttachConversion} from './attachSend';
import * as transfers from '../transfers/worker';

export function quoteForWire(text: string): string {
  return text
    .trim()
    .split('\n')
    .map((line) => `> ${line}`.trimEnd())
    .join('\n');
}

// A written utterance the engine has not acked within the deadline is written
// again, the same frame, the same cid (the engine answers a known cid with
// dup:true and delivers nothing): 10 s, then 20 s, then every 30 s while the
// pipe is up. It is never marked failed for this. The e2e rigs stretch the
// deadline through window.__cycAckTimeoutMs.
const ACK_TIMEOUT_MS = 10_000;
const ACK_CAP_MS = 30_000;

function ackTimeoutMs(n: number): number {
  const t = Number((window as unknown as {__cycAckTimeoutMs?: number}).__cycAckTimeoutMs);
  const base = t > 0 ? t : ACK_TIMEOUT_MS;
  return Math.min(Math.max(base, ACK_CAP_MS), base * (n + 1));
}
const ackTimers = new Map<string, ReturnType<typeof setTimeout>>();

export function clearAck(cid?: string) {
  if (!cid) return;
  const t = ackTimers.get(cid);
  if (t !== undefined) {
    clearTimeout(t);
    ackTimers.delete(cid);
  }
}

// Arm only once the frame was written to a sealed pipe. On the deadline it does
// not write the frame itself: it asks the drain (the one writer) to redeliver
// the same cid, which re-runs the send executor and arms the next deadline. The
// escalation is derived from the intent's durable WIRE-WRITE count, bumped once
// per real write (intents.noteWireWrite), NOT from `attempts` (which bumps on
// every drain pass, transfer-waiting and transient/reconnect passes included).
// The first wire write runs at wireWrites=1, so the deadline is
// ackTimeoutMs(wireWrites - 1) -- 1 -> 10 s, 2 -> 20 s, 3+ -> 30 s, the same
// 10/20/30 shape the direct rewrite gave, and a voice note or attachment that
// spent passes waiting on its bytes still arms its FIRST deadline at 10 s.
// When the pipe is gone the timer is disarmed (sync.onDisconnected) and the
// drain re-sends on the next settled edge.
export function armAck(cid: string, sessionId: string) {
  clearAck(cid);
  const writes = intents.get(cid)?.wireWrites ?? 1;
  const n = Math.max(0, writes - 1);
  ackTimers.set(
    cid,
    setTimeout(() => {
      ackTimers.delete(cid);
      const m = findByCid(sessionId, cid);
      if (!m || m.status !== 'sending') return;
      cyclog('send.ack-timeout', {
        cid,
        session: sessionId,
        chars: m.text.length,
        write: writes,
        why:
          'the engine took the bytes and never acked within the deadline (a ' +
          'connected-but-frozen engine, or a lost frame); the drain is asked to ' +
          'redeliver the same cid, and the bubble stays pending, never failed'
      });
      drain.redeliver(cid);
    }, ackTimeoutMs(n))
  );
}

export function armedAcks(): number {
  return ackTimers.size;
}

// The pipe went: no ack can arrive on it, so no deadline runs against it.
function disarmAll() {
  for (const t of ackTimers.values()) clearTimeout(t);
  ackTimers.clear();
}
sync.onDisconnected(disarmAll);

// Test seam: no deadline survives from one test to the next.
export function __resetForTest(): void {
  disarmAll();
}

export function isLocalOnly(m: CycMessage): boolean {
  return m.status === 'sending' || m.status === 'failed';
}

// Place a painted bubble in ts order (a resurrected old send sits behind every
// row the engine has since delivered, not at the tail). Mirrors admit's insert;
// kept local so sends.ts does not import admit (which already imports sends).
function insertByTs(messages: CycMessage[], m: CycMessage): void {
  let i = messages.length;
  while (i > 0 && messages[i - 1].ts > m.ts) i--;
  messages.splice(i, 0, m);
}

export function findByCid(sessionId: string, cid: string): CycEngineMessage | undefined {
  return sessions.get(sessionId)?.messages.find((m) => (m as CycEngineMessage).cid === cid) as
    CycEngineMessage | undefined;
}

// The engine took the message (ack, or the echo when the ack was missed) or
// the user discarded it: its intent goes, and with it any finished transfer
// rows it owned (Lane A prune).
export function settleSend(cid?: string) {
  if (!cid) return;
  clearAck(cid);
  drain.settled(cid);
  transfers.prune(cid);
}

// The engine refused the send for good (the nack): the ack timer stops, the
// intent is marked failed and kept, owed again on the retry tap.
export function failSend(cid: string, why: string) {
  clearAck(cid);
  drain.fail(cid, why);
}

// The user discarded the message: its intent goes, and every transfer row it
// owned goes with it, queued and active ones too.
export function discardSend(cid: string) {
  clearAck(cid);
  drain.drop(cid);
  transfers.cancel(cid);
}

// A send whose durable row never reached disk is kept in the composer box (the
// retry surface). Its optimistic thread bubble would then show the same message
// a second time, stuck pending (the "sending 0%" attachment bubble on a weak
// link), so the bubble is withdrawn here. Only the local row goes: the intent
// stays in memory and still drains, and the engine's echo paints the delivered
// row once it takes it (or the box resends it after a reload). Nothing is
// removed for a row already delivered (status past sending/failed). The caller
// reads the send's cid (sendSettles) before this runs, so the box's own wait on
// that cid outlives the withdrawal.
export function withdrawSend(sessionId: string, localId: string): boolean {
  const s = sessions.get(sessionId);
  if (!s) return false;
  const i = s.messages.findIndex((m) => m.id === localId);
  if (i < 0) return false;
  const m = s.messages[i] as CycEngineMessage;
  if (m.role !== 'user' || !isLocalOnly(m)) return false;
  s.messages.splice(i, 1);
  cyclog('send.withdrawn', {
    session: sessionId,
    localId,
    cid: m.cid,
    why:
      'its durable row never reached disk, so the box keeps it as the retry surface; ' +
      'the pending thread bubble is withdrawn so the same send is not shown twice'
  });
  notifyNow();
  return true;
}

// Write a send's wire to its engine. True when it went onto a sealed pipe.
export function writeSend(payload: SendPayload): boolean {
  const s = sessions.get(payload.sessionId);
  const owner = s && connOf(s.engineKey);
  if (!s || !owner) return false;
  return owner.client.sendText(s.paneId, payload.wire, {
    ...(payload.kind === 'voice'
      ? {kind: 'voice' as const, msgId: payload.msgId, durationS: payload.durationS}
      : {}),
    ...(payload.wireUploads?.length ? {upload: payload.wireUploads[0]} : {}),
    ...(payload.wireUploads && payload.wireUploads.length > 1
      ? {uploads: payload.wireUploads}
      : {}),
    ...(payload.words?.length ? {words: payload.words} : {}),
    ...(payload.partials?.length ? {partials: payload.partials} : {}),
    cid: payload.cid
  });
}

// The drain step every send kind ends in: write the wire, and hold the intent
// in flight until the engine acks it.
export function writeAndArm(payload: SendPayload): DrainOutcome {
  const m = findByCid(payload.sessionId, payload.cid);
  if (m && m.status !== 'sending') {
    m.status = 'sending';
    notifyNow();
  }
  if (!writeSend(payload)) return 'transient';
  // The frame is on the wire now: count this real write (not the drain pass)
  // and arm the ack deadline from that count.
  intents.noteWireWrite(payload.cid);
  armAck(payload.cid, payload.sessionId);
  return 'inflight';
}

drain.registerExecutor('send-text', (intent: Intent): DrainOutcome => {
  const payload = intent.payload as SendPayload;
  if (!sessions.get(payload.sessionId)) return {failed: 'no such session on this engine'};
  return writeAndArm(payload);
});

// Paint the bubble of a send the engine has not taken yet (a reload, or the
// session's row appearing after the intents were read). It never writes the
// wire: the drain does that, in order, on the settled edge.
function paintSend(intent: Intent): boolean {
  const entry = intent.payload as SendPayload;
  const s = sessions.get(entry.sessionId);
  if (!s) return false;
  const held = findByCid(entry.sessionId, entry.cid);
  if (held) {
    // A page or an echo painted the engine's copy before the intents came back
    // from disk: the send is delivered, the row on disk is owed nothing.
    if (!isLocalOnly(held)) settleSend(entry.cid);
    return true;
  }
  // A send the engine never confirmed for over INTENT_STALE_MS does not paint
  // as still sending -- that is the fake 'Sending…' that resurrected on every
  // boot. It is marked failed once (so the drain leaves it alone) and drawn as
  // a failed bubble the user can retry; the retry renews it.
  if (intents.isSendKind(intent.kind) && intent.state !== 'failed' && intents.isStale(intent)) {
    intents.setState(intent.id, 'failed', intents.STALE_SEND_REASON);
  }
  const msg: CycEngineMessage = stampRowId({
    id: '',
    role: 'user',
    kind: entry.kind,
    text: entry.text,
    ts: entry.ts,
    status: intent.state === 'failed' ? 'failed' : 'sending',
    cid: entry.cid
  });
  if (intent.state === 'failed' && intent.lastError) msg.failReason = intent.lastError;
  if (entry.durationS !== undefined) msg.durationS = entry.durationS;
  if (entry.msgId) msg.msgId = entry.msgId;
  if (entry.upload) msg.upload = entry.upload;
  if (entry.uploads?.length) msg.uploads = entry.uploads;
  // An attachment intent still moving its files: the bubble redraws with the
  // transfer keys standing in for the uploadIds (previews come back from the
  // vault when the send-files executor runs), and shows progress until the
  // wire goes.
  if (entry.transferKeys?.length && entry.attachMeta) {
    const files = entry.transferKeys.map((k) => {
      const mt = entry.attachMeta![k];
      return {
        uploadId: k,
        name: mt.name,
        mime: mt.mime,
        size: mt.size,
        path: '',
        image: mt.image,
        ...(mt.fromPage ? {fromPage: mt.fromPage} : {}),
        ...(mt.durationS ? {durationS: mt.durationS} : {}),
        ...(mt.width && mt.height ? {width: mt.width, height: mt.height} : {}),
        at: mt.at,
        ...(mt.textLen ? {textLen: mt.textLen} : {})
      } as CycUpload;
    });
    msg.upload = files[0];
    if (files.length > 1) msg.uploads = files;
    if (msg.status === 'sending') msg.sendPct = 0;
  }
  if (entry.replyTo) msg.replyTo = entry.replyTo;
  if (entry.wordsPending) msg.wordsPending = true;
  // A voice note's clipKey is rebuilt so the bubble draws as a real recording.
  if (entry.clipKey) msg.clipKey = entry.clipKey;
  if (entry.wire !== entry.text) msg.wireText = entry.wire;
  intents.setLocalId(intent.id, msg.id);

  // Insert by ts, not at the tail: a resurrected send from days ago belongs in
  // its own place in the thread, BEHIND every row the engine has since
  // delivered. Pushed to the tail it became the session's newest row and the
  // list subtitle read it as "Sending…" over a chat that had long moved on.
  insertByTs(s.messages, msg);
  notifyNow();
  return true;
}

// Boot: the intents come back from disk and their bubbles are painted where
// the session already exists; the rest paint as their sessions appear. An
// engine that settled while the disk was read is kicked now, or its edge
// would have found an empty queue.
export async function hydrateSends() {
  const rows = await intents.hydrate();
  for (const i of rows) if (intents.isSendKind(i.kind)) paintSend(i);
  for (const k of intents.engineKeysWithIntents()) drain.kick(k);
}

// Settles once a send's durable rows are on disk: its intent, and the
// transfer row of every file it carries. True when all of them committed. The
// composer clears the box on this, so a tab killed in the moment between the
// press and the write still holds the composition, never nothing.
export function sendCommitted(sessionId: string, localId: string): Promise<boolean> {
  const m = findLocal(sessionId, localId);
  if (!m?.cid) return Promise.resolve(false);
  const payload = intents.get(m.cid)?.payload as SendPayload | undefined;
  const keys = [
    ...(payload?.transferKey ? [payload.transferKey] : []),
    ...(payload?.transferKeys ?? [])
  ];
  return Promise.all([intents.committed(m.cid), ...keys.map((k) => transfers.enqueued(k))]).then(
    (oks) => oks.every(Boolean)
  );
}

// The send's row is gone: it settled already (here, or in another tab whose
// ack this tab learned of before the echo reached it), unless the message is
// painted failed. A refused send keeps its row.
function settledWithoutRow(m: CycEngineMessage): boolean {
  return m.status !== 'failed';
}

// Settles once the engine takes the send (its ack, or its echo): true. False
// only when the send is gone untaken (the user discarded it, or the message
// is gone). A refusal is not the end: the row stays, the bubble offers the
// retry tap, and this follows the same cid through every retry until one
// lands. Unbounded: a send whose engine is away is owed on the next edge, and
// this resolves with that edge's ack, however late. In memory only: the
// caller is the composer holding the box for a send whose row did not reach
// disk, and a reload loses both.
export function sendSettles(sessionId: string, localId: string): Promise<boolean> {
  const m = findLocal(sessionId, localId);
  if (!m?.cid) return Promise.resolve(false);
  if (!intents.get(m.cid)) return Promise.resolve(settledWithoutRow(m));
  return drain.whenTaken(m.cid);
}

// The send's first verdict, bounded to what the wire can promise now: true
// for a send the engine took within the ack deadline; false at once when the
// send's engine is not reachable, on the pipe going down while it waits, on
// the engine refusing it, and at the deadline (the wire's own rewrite runs
// from there; this wait does not). A false here is the composer's cue to tell
// the user the box keeps the words; sendSettles says whether they leave it.
export function sendTaken(sessionId: string, localId: string): Promise<boolean> {
  const m = findLocal(sessionId, localId);
  const s = sessions.get(sessionId);
  if (!m?.cid || !s) return Promise.resolve(false);
  const engineKey = s.engineKey;
  if (!intents.get(m.cid)) return Promise.resolve(settledWithoutRow(m));
  if (!drain.reachable(engineKey)) return Promise.resolve(false);
  return new Promise<boolean>((resolve) => {
    let done = false;
    const finish = (ok: boolean) => {
      if (done) return;
      done = true;
      clearTimeout(deadline);
      offDown();
      resolve(ok);
    };
    const deadline = setTimeout(() => finish(false), ackTimeoutMs(0));
    const offDown = sync.onDisconnected((k) => {
      if (k === engineKey) finish(false);
    });
    void drain.whenSettled(m.cid).then(finish);
  });
}

export function paintPendingSends(sessionId: string) {
  for (const i of intents.all()) {
    if (intents.isSendKind(i.kind) && i.sessionId === sessionId) paintSend(i);
  }
}

export function retrySend(sessionId: string, localId: string) {
  const m = findLocal(sessionId, localId);
  // A voice note carries its payload as a recording kept in the clipVault, not as
  // a replayable wire body: re-send it from those bytes over the transfer
  // contract rather than replaying an empty wire.
  if (m && m.kind === 'voice' && m.clipKey && retryVoiceClip(sessionId, localId)) return;
  // A HEIC that could not be decoded at the upload chokepoint wrote no intent:
  // its retry re-runs the conversion, not the drain.
  if (m && m.cid && retryAttachConversion(sessionId, localId)) return;
  if (!m || !m.cid) {
    cyclog('retry.noop', {
      session: sessionId,
      localId,
      why: !m
        ? 'the messageNode is gone'
        : 'this messageNode carries no cid, so it is not a resendable send'
    });
    return;
  }
  const intent = intents.get(m.cid);
  if (!intent) {
    // The acknowledged-checkmark case: this send was acked (its intent deleted at
    // ack) and then failed delivery, so the row sits at 'failed' with a cid
    // but no intent. A retry rebuilds the send intent from the row itself,
    // same cid, mirroring sendText's payload shape, and kicks the drain to
    // write the frame again. The engine never committed this cid (delivery
    // failed before commitDelivery), so recentCids misses it and it delivers
    // fresh.
    const s = sessions.get(sessionId);
    if (s && m.status === 'failed') {
      const files = m.uploads?.length ? m.uploads : m.upload ? [m.upload] : [];
      const payload: SendPayload = {
        cid: m.cid,
        sessionId,
        ts: m.ts,
        text: m.text,
        kind: m.kind,
        durationS: m.durationS,
        msgId: m.msgId,
        replyTo: m.replyTo,
        upload: m.upload,
        uploads: m.uploads,
        wire: m.wireText ?? m.text,
        wireUploads: files.length ? files : undefined
      };
      cyclog('retry.rebuild', {
        session: sessionId,
        localId,
        cid: m.cid,
        why:
          'user tapped a failed send whose intent was deleted at ack: the ' +
          'intent is rebuilt from the row, same cid, and owed again'
      });
      m.status = 'sending';
      delete m.failReason;
      notifyNow();
      intents.put({
        id: m.cid,
        engineKey: s.engineKey,
        sessionId,
        kind: 'send-text',
        payload,
        localId: m.id
      });
      drain.kick(s.engineKey);
      return;
    }
    cyclog('retry.noop', {
      session: sessionId,
      localId,
      cid: m.cid,
      why: 'no intent: this send already settled or was never durable'
    });
    return;
  }
  cyclog('retry.send', {
    session: sessionId,
    localId,
    cid: m.cid,
    attempts: intent.attempts,
    why: 'user tapped a failed send: the intent is owed again, same cid'
  });
  // The user is choosing to send it NOW: restart its clock so the drain's
  // expiry guard does not refuse the very frame the tap asked for. A row that
  // aged past a day and failed for it sends fresh on this tap.
  intents.renew(m.cid);
  m.status = 'sending';
  delete m.failReason;
  notifyNow();
  drain.requeue(m.cid);
}

type WireForm = {
  body: string;

  uploads: CycUpload[];

  words: string[];

  partials?: {id: string; text: string; upToS: number}[];
};

export function sendText(
  sessionId: string,
  text: string,
  opts: {
    kind?: CycMessage['kind'];
    durationS?: number;
    msgId?: string;
    upload?: CycUpload;
    uploads?: CycUpload[];
    ts?: number;
    replyTo?: CycReplyTo;
    cid?: string;
    wire?: WireForm;
    // Deletes that go in the intent row's own transaction (what this send
    // supersedes on disk).
    alongside?: Alongside;
  } = {}
): string {
  const clean = text.trim();

  if (!clean && !opts.upload && !opts.uploads?.length) {
    cyclog('send.dropped', {
      cid: opts.cid,
      session: sessionId,
      msgId: opts.msgId,
      kind: opts.kind,
      why: 'nothing to send: no text and no attachment'
    });
    return '';
  }
  const s = sessions.get(sessionId);
  if (!s) {
    cyclog('send.dropped', {
      cid: opts.cid,
      session: sessionId,
      msgId: opts.msgId,
      kind: opts.kind,
      chars: clean.length,
      why: 'no such session in the store (pruned, or the engine never reported it)'
    });
    return '';
  }

  const excerpt = (opts.replyTo?.text ?? '').trim();

  const body = (opts.wire?.body ?? text).trim();
  const wire = excerpt ? quoteForWire(excerpt) + '\n\n' + body : body;

  const cid =
    opts.cid ??
    crypto.randomUUID?.() ??
    Date.now().toString(36) + Math.random().toString(36).slice(2);

  const msg: CycEngineMessage = stampRowId({
    id: '',
    role: 'user',
    kind: opts.kind ?? 'text',
    text: clean,
    cid,

    ts: opts.ts ?? Date.now(),
    status: 'sending'
  });
  if (opts.durationS !== undefined) msg.durationS = opts.durationS;
  if (opts.msgId) msg.msgId = opts.msgId;

  const files = opts.uploads?.length ? opts.uploads : opts.upload ? [opts.upload] : [];
  if (files.length) {
    msg.upload = files[0];
    if (files.length > 1) msg.uploads = files;
  }
  if (opts.replyTo) msg.replyTo = opts.replyTo;
  if (wire !== clean) msg.wireText = wire;

  if (opts.wire?.words.length) msg.wordsPending = true;

  s.messages.push(msg);
  // Optimism (fix-unread): the moment his own row is on screen, mark it read in
  // memory so the unread divider never strands above his own message while the
  // send is in flight. This is NOT a wire sighting -- the row has no engine
  // identity yet and its durable sighting is queued on delivery (admit.ts), so
  // nothing here competes with the send in the drain. No timestamp math: the
  // engine stays the authority and this overlay collapses to its marker.
  sightLocalRow(sessionId, {ts: msg.ts});
  s.thinking = true;
  notifyNow();

  const wireFiles = opts.wire?.uploads.length ? opts.wire.uploads : files;

  const payload: SendPayload = {
    cid,
    sessionId,
    ts: msg.ts,
    text: msg.text,
    kind: msg.kind,
    durationS: msg.durationS,
    msgId: msg.msgId,
    replyTo: msg.replyTo,
    wordsPending: msg.wordsPending,
    upload: msg.upload,
    uploads: msg.uploads,
    wire,
    wireUploads: wireFiles.length ? wireFiles : undefined,
    words: opts.wire?.words,
    partials: opts.wire?.partials
  };
  intents.put(
    {
      id: cid,
      engineKey: s.engineKey,
      sessionId,
      kind: 'send-text',
      payload,
      localId: msg.id
    },
    {alongside: opts.alongside}
  );
  drain.kick(s.engineKey);
  return msg.id;
}

export function engineCan(sessionId: string, feature: string): boolean {
  const s = sessions.get(sessionId);
  const owner = s && connOf(s.engineKey);
  return !!owner?.client.can(feature);
}

export function voiceEngineHealthy(sessionId: string | null): boolean {
  if (!sessionId) return true;
  const s = sessions.get(sessionId);
  const owner = s && connOf(s.engineKey);
  return owner ? owner.voiceHealthy : true;
}
