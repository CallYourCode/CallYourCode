import type {EngineChatMessage, EnginePage, EngineSessionEvent} from './contract';

export function decodeChat(frame: any): EngineChatMessage | null {
  if (!frame || typeof frame !== 'object') return null;
  const m: EngineChatMessage = {
    id: String(frame.id),
    role: frame.role === 'claude' ? 'claude' : 'user',
    text: String(frame.text ?? ''),
    ts: Number(frame.ts) || Date.now()
  };

  if (Number.isFinite(frame.seq)) m.seq = Number(frame.seq);
  // The engine's durable row id: the identity the store dedups on so a row
  // re-served under a renumbered seq is not painted twice. The app rebuilds
  // every frame field by field, so it exists only because it is copied here.
  if (typeof frame.mid === 'string' && frame.mid) m.mid = frame.mid;
  if (frame.msgId) m.msgId = String(frame.msgId);
  if (frame.kind === 'voice') m.kind = 'voice';
  if (frame.queued) m.queued = true;

  if (typeof frame.cid === 'string' && frame.cid) m.cid = frame.cid;

  if (frame.wordsFailed === true) m.wordsFailed = true;

  if (frame.transcriptPending === true) m.transcriptPending = true;

  if (typeof frame.scheduled === 'string' && frame.scheduled) m.scheduled = frame.scheduled;
  if (Number.isFinite(frame.durationS)) m.durationS = Number(frame.durationS);

  if (frame.growing === true) m.growing = true;
  const f = frame.file;
  if (f && typeof f.docId === 'string' && f.docId) {
    const kind =
      f.fileKind === 'markdown' ||
      f.fileKind === 'diff' ||
      f.fileKind === 'image' ||
      f.fileKind === 'html' ||
      f.fileKind === 'binary'
        ? f.fileKind
        : 'text';
    m.file = {
      docId: f.docId,
      name: String(f.name ?? 'file'),
      fileKind: kind,
      size: Number(f.size) || 0,

      ...(f.inline && kind !== 'html' && kind !== 'binary' ? {inline: true} : {}),
      ...(typeof f.content === 'string' && kind !== 'html' && kind !== 'binary'
        ? {content: f.content}
        : {})
    };
  }

  const clean = (u: Record<string, unknown> | undefined) => {
    if (!u || typeof u.uploadId !== 'string' || !u.uploadId) return null;
    const durationS = Number(u.durationS) || 0;
    const at = Number(u.at);
    const textLen = Number(u.textLen) || 0;
    const from = u.fromPage as {label?: unknown; page?: unknown} | undefined;
    const fromPage =
      from && typeof from.label === 'string' && typeof from.page === 'string'
        ? {label: from.label, page: from.page}
        : undefined;

    const width = Number(u.width) || 0;
    const height = Number(u.height) || 0;
    return {
      uploadId: u.uploadId,
      name: String(u.name ?? 'file'),
      mime: String(u.mime ?? 'application/octet-stream'),
      size: Number(u.size) || 0,
      path: String(u.path ?? ''),
      image: !!u.image,
      ...(durationS > 0 ? {durationS} : {}),
      ...(Number.isFinite(at) && at >= 0 ? {at} : {}),
      ...(textLen > 0 ? {textLen} : {}),
      ...(fromPage ? {fromPage} : {}),
      ...(width > 0 && height > 0 ? {width, height} : {})
    };
  };
  const one = clean(frame.upload as Record<string, unknown> | undefined);
  if (one) m.upload = one;
  if (Array.isArray(frame.uploads)) {
    const many = (frame.uploads as Record<string, unknown>[])
      .map(clean)
      .filter((x): x is NonNullable<typeof x> => !!x);
    if (many.length) {
      m.uploads = many;
      m.upload ??= many[0];
    }
  }
  return m;
}

const INTERRUPT_TEXT = /^>?\s*\[Request interrupted by user[^\]]*\]\s*$/;

/** A session record off the wire: a `t:"s"` page row or a `session-event`
 *  delta's `ev`. Its id is `id` (the engine's `se-...`); `uuid` is accepted for
 *  the same field. A kind this build does not know is kept as-is: the row still
 *  counts toward its page. A claude "[Request interrupted by user]" prompt is
 *  shown as the interrupt it is. */
export function parseSessionEvent(e: any): EngineSessionEvent | null {
  if (!e || typeof e !== 'object' || !Number.isFinite(e.ts)) return null;
  const uuid = typeof e.id === 'string' && e.id ? e.id : typeof e.uuid === 'string' ? e.uuid : '';
  if (!uuid || typeof e.kind !== 'string' || !e.kind) return null;
  let kind: string = e.kind;
  let text = String(e.text ?? '');
  if (kind === 'prompt' && INTERRUPT_TEXT.test(text)) {
    kind = 'interrupt';
    text = 'interrupted by user';
  }
  const ev: EngineSessionEvent = {uuid, ts: Number(e.ts), kind, text};
  if (Number.isFinite(e.seq)) ev.seq = Number(e.seq);
  const tool = typeof e.tool === 'string' ? e.tool : e.tool?.name;
  if (typeof tool === 'string' && tool) ev.tool = tool;
  // input attribution: where it came from, and the sender for agent-to-agent
  if (typeof e.source === 'string' && e.source) ev.source = e.source;
  if (typeof e.sender === 'string' && e.sender) ev.sender = e.sender;
  return ev;
}

/** One page of the log as the engine sends it (attach-ok `pages[]` and
 *  `GET /session/:id/page/:n` agree): the `messages` array holds chat messages
 *  and, tagged `t:"s"`, the session records of the same seq range. The two are
 *  split here, once, for every path that reads a page. */
export function decodePage(p: any): EnginePage {
  const messages: EngineChatMessage[] = [];
  const events: EngineSessionEvent[] = [];
  for (const row of Array.isArray(p?.messages) ? p.messages : []) {
    if (row && row.t === 's') {
      const ev = parseSessionEvent(row);
      if (ev) events.push(ev);
    } else {
      const m = decodeChat(row);
      if (m) messages.push(m);
    }
  }
  return {
    page: Number(p?.page) || 0,
    version: Number(p?.version) || 0,
    sealed: p?.sealed === true,
    messages,
    events
  };
}
