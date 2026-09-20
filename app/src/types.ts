// sending: on this device only, the engine has not acked. sent: the engine
// acked the frame (it took the bytes); a later send-failed on the same cid
// demotes it to failed, so the single tick is no longer permanent on a
// swallowed or refused delivery. delivered: the engine echoed the committed
// row back, which now follows a consumption check on the pane. failed: refused
// or not delivered; the row keeps its cid and offers the retry tap.
type CycMessageStatus = 'sending' | 'sent' | 'delivered' | 'failed';

export type CycFileRef = {
  docId: string;
  name: string;

  fileKind: 'markdown' | 'diff' | 'text' | 'image' | 'html' | 'binary';
  size: number;

  inline?: boolean;
  content?: string;

  width?: number;
  height?: number;
};

export const REPLY_EXCERPT_LIMIT = 200;

export type CycReplyTo = {
  // THE TARGET'S ONE DURABLE ID (fix-oneid): what a reply resolves back to, by
  // identity, across a re-serve and a reload. Absent only on a target built
  // before its row had a durable id (a still-optimistic own send). `ts` is kept
  // as DISPLAY metadata and the legacy fallback, never the resolution key.
  id?: string;
  ts: number;
  role: 'user' | 'claude';
  title: string;
  text: string;

  quote?: boolean;
};

export type CycMessage = {
  // THE ONE NAME (fix-oneid): the message's durable string row id, computed in
  // exactly one place (engine/store/rows/core rowIdOfMessage) and used
  // everywhere -- the store key, data-mid, reply targets, retry/cancel, the read
  // marker. No per-load numeric render id, no clock-as-identity anywhere.
  id: string;
  role: 'user' | 'claude';
  kind: 'text' | 'voice';
  text: string;
  durationS?: number;
  ts: number;
  status?: CycMessageStatus;

  replyTo?: CycReplyTo;
  file?: CycFileRef;

  upload?: {
    uploadId: string;
    name: string;
    mime: string;
    size: number;
    path: string;
    image: boolean;
    fromPage?: {label: string; page: string};
    durationS?: number;
    at?: number;
    textLen?: number;
    width?: number;
    height?: number;
  };

  uploads?: CycMessage['upload'][];

  queued?: boolean;

  wordsPending?: boolean;

  wordsFailed?: boolean;

  transcriptPending?: boolean;

  growing?: boolean;

  scheduled?: string;

  draftCommitted?: number;

  clipLost?: boolean;

  // Why a failed send was refused, in the bubble's own words ("too large (over
  // 300 MB)"). Set when the engine's refusal carries a reason worth showing;
  // absent, the bubble paints its generic failed copy.
  failReason?: string;

  // Progress of an in-flight resumable transfer for this send, 0..1 (acked
  // chunks over total). Painted on the pending bubble as "sending NN%"; cleared
  // once the transfer finishes and the message is on its way.
  sendPct?: number;

  // The clipVault key (== cid) under which this voice note's recorded bytes are
  // kept while its upload is in flight or failed. Present only on a voice note
  // sent through the honest clip-upload path (sends.retrySend re-reads these
  // bytes so a failed send can be resent from the original recording).
  clipKey?: string;
};

export type CycMediaItem = {
  key: string;
  kind: 'image' | 'doc';
  from: 'upload' | 'shown';
  refId: string;
  name: string;
  size: number;
  ts: number;
  url: string;
};

/** A session record held in the store: a row of the agent's log beside the
 *  messages (same page, same seq axis). `kind` is open; the chat surface
 *  paints the kinds it has a pill for (VISIBLE_EVENT_KINDS) and holds the rest. */
export type CycSessionEvent = {
  uuid: string;
  ts: number;
  seq?: number;

  kind: string;
  text: string;
  tool?: string;
  /** kind:"prompt" only: where the input reached the agent from, for the
   *  overlay's source chip (`app`|`manual`|`agent`|`cron`; app is suppressed
   *  upstream so it never arrives here). */
  source?: string;
  /** source:"agent" only: the sending agent's id (from `cyc agent message --from`) */
  sender?: string;
};

export type CycAgentStatus = 'idle' | 'working' | 'blocked' | 'done' | 'unknown';

type CycSessionTitle = {
  text: string;
  detail: string | null;
};

export type CycSession = {
  id: string;
  name: string;
  cwd: string;
  unread: number;
  muted: boolean;
  thinking: boolean;
  avatarUrl?: string;
  messages: CycMessage[];

  status?: CycAgentStatus;
  title?: CycSessionTitle;
  agentLabel?: string;

  agentName?: string;

  agentId?: string;

  model?: string;
  turnSince?: number;

  lastActivity?: number;

  contextPct?: number;
  order?: number;

  ask?: CycAsk | null;

  askUnknown?: boolean;
};

type CycAskChoice = {
  n: number;
  label: string;
  detail?: string;

  freeText?: boolean;
};

export type CycAsk = {
  question: string;
  context: string[];
  choices: CycAskChoice[];
  fingerprint: string;
};
