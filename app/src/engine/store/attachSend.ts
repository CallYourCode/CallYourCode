import * as intents from '../intents';
import type {Alongside, AttachMeta, Intent, SendPayload} from '../intents';
import * as drain from '../sync/drain';
import type {DrainOutcome} from '../sync/drain';
import * as clipVault from '../../audio/clipVault';
import * as transfers from '../transfers/worker';
import type {TransferRow} from '../transfers/rows';
import {cyclog} from '@/shared/logging';
import {aliasLocalUpload, rememberLocalUpload} from '@/features/composer/localUploadUrls';
import {heicToJpegForUpload, isHeic} from '@/features/media/heic';
import type {CycReplyTo} from '../../types';
import type {CycUpload} from '../contract';
import type {CycEngineMessage} from './types';
import {notifyNow, sessions} from './registry';
import {stampRowId} from './rows/core';
import {discardSend, findByCid, quoteForWire, writeAndArm} from './sends';

// File and image attachments over the resumable transfer queue (Lane A).
//
// A message with attachments names its uploads by the engine's uploadId, so
// the wire cannot go out before the engine has the bytes. Before this the
// composer streamed each file over /upload at staging time and the send waited
// on those promises in memory: a reload mid-upload lost the send. Now:
//   - the press pushes the bubble at once (previews from the local files) and
//     writes ONE send-files intent that lists its transfer keys;
//   - each file becomes a TransferRow (kind 'upload') parked in the clipVault,
//     moved chunk by chunk by the worker, resumed from acked across reloads;
//   - progress on the bubble is the aggregate over every row of the message;
//   - the wire (uploadIds, {{cyc-words:<id>}} markers, words, partials) goes
//     out ONLY once every row is done, built by substituting each transfer key
//     with the uploadId its result carries;
//   - any row gone (size cap, refused type, bad hash) is the definitive failed
//     bubble for the whole message; nothing half-sends.

// The marker the composer writes into the wire body for a recording whose
// words the engine fills in. Before the send it names the transfer key; the
// wire that goes out names the uploadId.
export const wordsMarker = (id: string): string => `{{cyc-words:${id}}}`;
const MARKER_RE = /\{\{cyc-words:([^}]+)\}\}/g;

export type AttachFile = {
  key: string;
  file: File;
  name: string;
  mime: string;
  durationS?: number;
  width?: number;
  height?: number;
  fromPage?: {label: string; page: string};
  // Where this file sits in the display text and in the wire text.
  at: number;
  textLen?: number;
  wireAt: number;
  wireTextLen?: number;
};

export type AttachSendOpts = {
  // The display body (no markers) and the wire body (markers by transfer key).
  text: string;
  wireText: string;
  files: AttachFile[];
  // Transfer keys of the files whose words the engine fills in.
  words: string[];
  partials?: {id: string; text: string; upToS: number}[];
  replyTo?: CycReplyTo;
  // Deletes that go in the intent row's own transaction (what this send
  // supersedes on disk).
  alongside?: Alongside;
};

// Local files for previews, by transfer key. Rebuilt from the vault on resume.
const previews = new Map<string, File>();

// Re-run the HEIC->JPEG conversion for a send whose decode failed at the
// chokepoint (no intent was written, so the drain has nothing to owe). Keyed
// by the send's cid; cleared once the conversion lands and the send commits.
const heicRetries = new Map<string, () => void>();

// A finished row runs the drain again: the send-files intent that owns it
// looks at its rows and sends once every one is done.
transfers.onResult((row) => {
  if (row.kind !== 'upload' || !row.ownerCid) return;
  drain.kick(intents.engineKeyOfSessionId(row.sessionId));
});

function isImage(mime: string): boolean {
  return mime.startsWith('image/');
}

// The bubble's upload before the engine has it: the transfer key stands in for
// the uploadId, the local file for the preview.
function placeholderUpload(key: string, meta: AttachMeta): CycUpload {
  return {
    uploadId: key,
    name: meta.name,
    mime: meta.mime,
    size: meta.size,
    path: '',
    image: meta.image,
    ...(meta.fromPage ? {fromPage: meta.fromPage} : {}),
    ...(meta.durationS ? {durationS: meta.durationS} : {}),
    ...(meta.width && meta.height ? {width: meta.width, height: meta.height} : {}),
    at: meta.at,
    ...(meta.textLen ? {textLen: meta.textLen} : {})
  };
}

function setUploads(m: CycEngineMessage, files: CycUpload[]): void {
  m.upload = files[0];
  if (files.length > 1) m.uploads = files;
  else delete m.uploads;
}

function newCid(): string {
  return crypto.randomUUID?.() ?? Date.now().toString(36) + Math.random().toString(36).slice(2);
}

// Send a message with attachments. Returns the local message id (or '' when
// there is no such session to hang a row on).
export function sendAttachments(sessionId: string, opts: AttachSendOpts): string {
  const s = sessions.get(sessionId);
  if (!s || !opts.files.length) {
    cyclog('attach.dropped', {
      session: sessionId,
      files: opts.files.length,
      why: !s ? 'no such session in the store' : 'nothing to attach'
    });
    return '';
  }
  const cid = newCid();
  const clean = opts.text.trim();
  const excerpt = (opts.replyTo?.text ?? '').trim();
  const body = opts.wireText.trim();
  const wire = excerpt ? quoteForWire(excerpt) + '\n\n' + body : body;

  const attachMeta: Record<string, AttachMeta> = {};
  for (const f of opts.files) {
    attachMeta[f.key] = {
      name: f.name,
      mime: f.mime,
      size: f.file.size,
      image: isImage(f.mime),
      durationS: f.durationS,
      width: f.width,
      height: f.height,
      fromPage: f.fromPage,
      at: f.at,
      textLen: f.textLen,
      wireAt: f.wireAt,
      wireTextLen: f.wireTextLen
    };
    previews.set(f.key, f.file);
    if (isImage(f.mime)) rememberLocalUpload(f.key, f.file);
  }
  const keys = opts.files.map((f) => f.key);

  const msg: CycEngineMessage = stampRowId({
    id: '',
    role: 'user',
    kind: 'text',
    text: clean,
    ts: Date.now(),
    status: 'sending',
    cid,
    sendPct: 0
  });
  setUploads(
    msg,
    keys.map((k) => placeholderUpload(k, attachMeta[k]))
  );
  if (opts.replyTo) msg.replyTo = opts.replyTo;
  if (wire !== clean) msg.wireText = wire;
  if (opts.words.length) msg.wordsPending = true;
  s.messages.push(msg);
  s.thinking = true;
  notifyNow();

  const enqueueOne = (f: AttachFile): void => {
    transfers.enqueue(f.file, {
      key: f.key,
      sessionId,
      kind: 'upload',
      mime: f.mime,
      name: f.name,
      durationS: f.durationS,
      ts: msg.ts,
      ownerCid: cid
    });
  };

  const intentPayload: SendPayload = {
    cid,
    sessionId,
    ts: msg.ts,
    text: clean,
    kind: 'text',
    replyTo: opts.replyTo,
    wordsPending: msg.wordsPending,
    wire,
    words: opts.words,
    partials: opts.partials?.length ? opts.partials : undefined,
    transferKeys: keys,
    attachMeta
  };

  // The intent's row reaches disk after every file's bytes and transfer row
  // have: a tab killed in between leaves no intent that names bytes it does
  // not have.
  const commit = (): void => {
    intents.put(
      {
        id: cid,
        engineKey: s.engineKey,
        sessionId,
        kind: 'send-files',
        localId: msg.id,
        payload: intentPayload
      },
      {after: Promise.all(keys.map((k) => transfers.enqueued(k))), alongside: opts.alongside}
    );
    cyclog('attach.queued', {
      cid,
      session: sessionId,
      files: keys.length,
      bytes: opts.files.reduce((n, f) => n + f.file.size, 0),
      words: opts.words.length,
      why: 'the bubble is up and every file is a durable transfer row; the wire waits for all of them'
    });
    drain.kick(s.engineKey);
  };

  // The unbypassable HEIC guard. The composer's stage-time conversion is a
  // fast-preview optimization; any staging path that skips it (the composer
  // vault restore rebuilding attach blocks on reload, or any future entry)
  // reaches this chokepoint carrying raw HEIC. Normalize every HEIC/HEIF file
  // to JPEG BEFORE its bytes are parked and the intent names it, so no staging
  // path can ship raw HEIC. An already converted JPEG (the stage-time path) is
  // a no-op here. A decode failure fails the whole send loudly -- the bubble
  // goes failed with a retry that re-runs the conversion -- rather than parking
  // undecodable bytes.
  async function normalizeThenSend(): Promise<void> {
    try {
      for (const f of opts.files) {
        if (!isHeic(f.file)) continue;
        const jpeg = await heicToJpegForUpload(f.file);
        f.file = jpeg;
        f.mime = jpeg.type;
        f.name = jpeg.name;
        const mt = attachMeta[f.key];
        if (mt) {
          mt.mime = jpeg.type;
          mt.name = jpeg.name;
          mt.size = jpeg.size;
          mt.image = isImage(jpeg.type);
        }
        previews.set(f.key, jpeg);
        if (isImage(jpeg.type)) rememberLocalUpload(f.key, jpeg);
      }
    } catch (e) {
      failAttach(intentPayload, e instanceof Error ? e.message : 'HEIC conversion failed');
      return;
    }
    heicRetries.delete(cid);
    for (const f of opts.files) enqueueOne(f);
    commit();
  }

  if (opts.files.some((f) => isHeic(f.file))) {
    heicRetries.set(cid, () => void normalizeThenSend());
    void normalizeThenSend();
    return msg.id;
  }

  for (const f of opts.files) enqueueOne(f);
  commit();
  return msg.id;
}

// A send whose HEIC failed to convert at the chokepoint never wrote an intent
// (there were no bytes to name), so its retry is not the drain's -- it re-runs
// the conversion from the files still held in memory. The bubble tap routes
// here through sends.retrySend before the generic rebuild path.
export function retryAttachConversion(sessionId: string, localId: string): boolean {
  const s = sessions.get(sessionId);
  const m = s?.messages.find((x) => x.id === localId) as CycEngineMessage | undefined;
  if (!m || !m.cid) return false;
  const retry = heicRetries.get(m.cid);
  if (!retry) return false;
  // A second tap while it is already owed again does nothing but claim the tap.
  if (m.status === 'failed') {
    m.status = 'sending';
    delete m.failReason;
    notifyNow();
    retry();
  }
  return true;
}

// The user-facing cancel of an attachment send still moving its files (the
// progress line's tap). It cancels the WHOLE pending message, never a single
// file out of it: the send is one intent with one wire whose text carries
// positional offsets (attachMeta at/textLen) for every file, and its delivery
// is already all-or-nothing (any refused row fails the whole message, nothing
// half-sends), so a per-file cancel would have to rewrite the composed text
// and markers, which is the composer's job, not the bubble's. The transfer
// rows are cancelled (in-flight step aborted, bytes released, engine-side
// partials DELETEd best-effort; the engine's 7-day sweeper covers a DELETE
// that never lands), the intent goes, and the pending bubble goes with it.
// Returns false as a no-op when the transfers already finished and the wire
// phase was reached (the message is leaving; a cancel cannot unsend it) or
// when the message is not a pending upload at all.
export function cancelAttachmentSend(sessionId: string, localId: string): boolean {
  const s = sessions.get(sessionId);
  const m = s?.messages.find((x) => x.id === localId) as CycEngineMessage | undefined;
  if (!s || !m || m.role !== 'user' || m.status !== 'sending' || !m.cid) return false;
  const cid = m.cid;
  const intent = intents.get(cid);
  const keys = (intent?.payload as SendPayload | undefined)?.transferKeys ?? [];
  // No intent (settled already) or no transferKeys left (every row finished
  // and wireFromRows swapped the payload to the wire form): too late.
  if (!intent || !keys.length) return false;
  discardSend(cid);
  for (const k of keys) previews.delete(k);
  const i = s.messages.indexOf(m);
  if (i >= 0) s.messages.splice(i, 1);
  notifyNow();
  // The parking window: sendAttachments paints sendPct 0 (the cancel X) from
  // the first frame, while each file's parkAndWrite (the whole blob into IDB
  // plus a whole-blob sha256, 0.5-2s for a big file) is still running and no
  // row exists yet. discardSend's cancel above catches only the rows that
  // exist NOW; a file still parking gets its queued row written AFTER the
  // cancel and, with the intent already gone, the worker would upload it in
  // full in the background (resuming across reloads) and leave its done row
  // unpruned forever. So wait for every key to finish parking, then cancel
  // again: the late row is found, aborted, its bytes released, its begun id
  // DELETEd. The intent is already gone, so no wire can ever go regardless.
  void Promise.all(keys.map((k) => transfers.enqueued(k))).then(() => {
    transfers.cancel(cid);
  });
  cyclog('attach.cancelled', {
    cid,
    session: sessionId,
    files: keys.length,
    why:
      'user cancelled the upload from the bubble; the whole message goes ' +
      '(one wire, positional offsets, all-or-nothing delivery)'
  });
  return true;
}

// Every row of the intent is done: the wire is built from the results and the
// payload becomes an ordinary wire send (uploadIds in place of transfer keys).
function wireFromRows(payload: SendPayload, rows: TransferRow[]): SendPayload | null {
  const meta = payload.attachMeta ?? {};
  const idOf = new Map<string, string>();
  const results = new Map<string, CycUpload>();
  for (const r of rows) {
    const res = r.result as CycUpload | undefined;
    if (!res?.uploadId) {
      cyclog('attach.result-malformed', {
        cid: payload.cid,
        key: r.key,
        why: 'finish reply has no uploadId'
      });
      return null;
    }
    idOf.set(r.key, res.uploadId);
    results.set(r.key, res);
  }
  const keys = payload.transferKeys ?? [];
  const build = (k: string, wireSide: boolean): CycUpload => {
    const mt = meta[k];
    const res = results.get(k)!;
    const u: CycUpload = {...res};
    if (mt?.fromPage) u.fromPage = mt.fromPage;
    if (mt?.durationS) u.durationS = mt.durationS;
    if (mt?.width && mt?.height) {
      u.width = mt.width;
      u.height = mt.height;
    }
    const at = wireSide ? mt?.wireAt : mt?.at;
    const textLen = wireSide ? mt?.wireTextLen : mt?.textLen;
    if (at !== undefined) u.at = at;
    if (textLen) u.textLen = textLen;
    return u;
  };
  const files = keys.map((k) => build(k, false));
  const wireFiles = keys.map((k) => build(k, true));
  const wire = payload.wire.replace(MARKER_RE, (m0, k: string) => {
    const id = idOf.get(k);
    return id ? wordsMarker(id) : m0;
  });
  const words = (payload.words ?? []).map((k) => idOf.get(k) ?? k);
  const partials = payload.partials?.map((p) => ({...p, id: idOf.get(p.id) ?? p.id}));

  // The image previews follow the real ids so the bubble never flashes: the
  // engine uploadId is aliased to the SAME object URL the transfer key held,
  // so the bubble's <img> src does not change across the swap (a second
  // minted URL forced a reload). Minting is the fallback for a preview whose
  // key entry was evicted while its File is still at hand.
  for (const k of keys) {
    const f = previews.get(k);
    const id = idOf.get(k);
    if (id && meta[k]?.image && !aliasLocalUpload(k, id) && f) rememberLocalUpload(id, f);
    previews.delete(k);
  }

  const m = findByCid(payload.sessionId, payload.cid);
  if (m) {
    setUploads(m, files);
    delete m.sendPct;
    if (wire !== m.text) m.wireText = wire;
    else delete m.wireText;
    // The progress line leaves with the last transfer: the bubble repaints
    // now, the wire's own status edge is not a paint.
    notifyNow();
  }
  const s = sessions.get(payload.sessionId);
  if (s) s.thinking = true;

  const named: SendPayload = {
    ...payload,
    upload: files[0],
    uploads: files.length > 1 ? files : undefined,
    wire,
    wireUploads: wireFiles,
    words: words.length ? words : undefined,
    partials: partials?.length ? partials : undefined
  };
  delete named.transferKeys;
  delete named.attachMeta;
  cyclog('attach.sent', {
    cid: payload.cid,
    session: payload.sessionId,
    uploads: keys.map((k) => idOf.get(k)).join(','),
    words: words.length,
    why: 'every file is on the engine; the wire names their uploadIds'
  });
  return named;
}

function failAttach(payload: SendPayload, why: string): {failed: string} {
  const m = findByCid(payload.sessionId, payload.cid);
  if (m) {
    m.status = 'failed';
    m.failReason = why;
    delete m.sendPct;
  }
  cyclog('attach.failed', {cid: payload.cid, session: payload.sessionId, why});
  notifyNow();
  return {failed: why};
}

// The drain step for a send-files intent, and the whole of its resume after a
// reload: every row done sends; any row gone fails; a row still moving waits
// for the worker (its result kicks the drain); a row that vanished while its
// bytes survive is re-queued from the vault (previews rebuilt); one that
// vanished with its bytes is the definitive failure (nothing left to send).
drain.registerExecutor('send-files', async (intent: Intent): Promise<DrainOutcome> => {
  const payload = intent.payload as SendPayload;
  const s = sessions.get(payload.sessionId);
  if (!s) return {failed: 'no such session on this engine'};
  const keys = payload.transferKeys ?? [];
  // The wire was built already (every row was done): only the send is owed.
  if (!keys.length) return writeAndArm(payload);
  const meta = payload.attachMeta ?? {};
  const rows: TransferRow[] = [];
  let missing = 0;
  let moving = false;
  for (const k of keys) {
    const row = transfers.rowOf(k);
    if (row?.state === 'gone')
      return failAttach(payload, `attachment ${k} was refused definitively`);
    if (row?.state === 'done') {
      rows.push(row);
      continue;
    }
    const mt = meta[k];
    if (row) {
      moving = true;
      // After a reload the image preview is gone with the page: it comes back
      // from the vault while the row finishes moving.
      if (mt?.image && !previews.has(k)) {
        const rec = await clipVault.get(k);
        if (!intents.get(intent.id)) return 'waiting';
        if (rec) {
          const file = new File([rec.blob], mt.name, {type: rec.mime});
          previews.set(k, file);
          rememberLocalUpload(k, file);
        }
      }
      continue;
    }
    if (transfers.isEnqueuing(k)) {
      // `enqueue` is still parking the bytes and writing the row (the send's
      // own kick lands first): the row is coming, the worker moves it.
      moving = true;
      continue;
    }
    // No row survives, but the bytes might: the vault read is an await, and
    // the intent can be discarded under it.
    const rec = await clipVault.get(k);
    if (!intents.get(intent.id)) return 'waiting';
    if (!rec) {
      missing++;
      continue;
    }
    const file = new File([rec.blob], mt?.name ?? 'file', {type: rec.mime});
    previews.set(k, file);
    if (mt?.image) rememberLocalUpload(k, file);
    transfers.enqueue(file, {
      key: k,
      sessionId: payload.sessionId,
      kind: 'upload',
      mime: rec.mime,
      name: mt?.name,
      durationS: mt?.durationS,
      ts: payload.ts,
      ownerCid: payload.cid
    });
    moving = true;
  }
  if (missing) {
    return failAttach(
      payload,
      `${missing} attachment(s) have neither a transfer row nor kept bytes`
    );
  }
  if (moving) {
    transfers.wake();
    return 'waiting';
  }
  const named = wireFromRows(payload, rows);
  if (!named)
    return failAttach(payload, 'the engine answered a finished upload without an uploadId');
  intents.update(intent.id, named);
  return writeAndArm(named);
});

// Test seam.
export function __resetForTest(): void {
  previews.clear();
  heicRetries.clear();
}
