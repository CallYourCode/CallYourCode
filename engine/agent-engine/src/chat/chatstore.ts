/* THE CHAT LOG ON DISK: one append-only jsonl per chat (the design).
 *
 * `.run/chat.json` was one giant JSON file holding every session's log,
 * rewritten whole on a debounce. Every restart-survival property the app
 * depends on rode on that rewrite, and so did every mutation: clearing a
 * queued flag, closing out a growing clip, filling a transcript in. The new
 * model appends: a chat lives at agents/<agentId>/chats/<chatId>.jsonl, a
 * message is one appended line, and a mutation is one appended PATCH line that
 * names the message it edits by its `ts` (strictly increasing per chat --
 * stampTs -- so it addresses exactly one message). No existing line is ever
 * rewritten. The two operations that genuinely replace a log -- the rekey
 * merge and the TEST-only trim -- write a NEW chat file and flip the meta
 * pointer, leaving the old file as history.
 *
 * Line shapes:
 *   { "t": "m", ...msg }                                    append one message
 *   { "t": "e", "ev": "patch", "mts": ts, "set": {..}, "del": ["field"] }
 *   { "t": "s", ...rec }                 append one session record (sessionrec.ts)
 *
 * Replay reads lines in order, applies patches by mts, and SKIPS an
 * unparseable trailing line (a torn append from a crash is a lost tail line,
 * never a lost log). Appends are serialized per chat file so line order on
 * disk is call order. Messages and session records share ONE seq axis (the
 * writer, chatlog.ts, stamps it); replayLogText hands them back as two arrays
 * so the many message readers keep their shape, and pages.ts merges by seq.
 *
 *   bun test agent-engine/src/chat/chatstore.test.ts
 */

import { readdir } from "node:fs/promises";
import { agentChatFile, agentChatsDir } from "../storage/datadir.ts";
import { appendPrivate, mkdirPrivate } from "../../../shared/runfiles.ts";
import { parseSessionRec, type SessionRec } from "./sessionrec.ts";

/** The store is generic over the message shape: server.ts owns ChatMsg. */
export type StoredMsg = { ts: number } & Record<string, unknown>;

/** One chat file replayed: its messages (patched), its session records, and
 *  whether the last line was torn (a crashed append; the line is skipped and
 *  the log is otherwise whole). */
export type ReplayedLog = { msgs: StoredMsg[]; recs: SessionRec[]; torn: boolean };

export type ChatPatch = {
  mts: number;
  set?: Record<string, unknown>;
  del?: string[];
};

export function newChatId(): string {
  return crypto.randomUUID();
}

/** Apply one patch to a loaded log, in place. Unknown mts is a no-op: a patch
 *  for a message that a merge or trim left behind must not corrupt another. */
export function applyPatch(msgs: StoredMsg[], p: ChatPatch): void {
  const m = msgs.find((x) => x.ts === p.mts);
  if (!m) return;
  if (p.set) for (const [k, v] of Object.entries(p.set)) (m as Record<string, unknown>)[k] = v;
  if (p.del) for (const k of p.del) delete (m as Record<string, unknown>)[k];
}

/** Replay one chat file's text: messages, session records, torn-tail flag. */
export function replayLogText(text: string): ReplayedLog {
  const msgs: StoredMsg[] = [];
  const recs: SessionRec[] = [];
  let torn = false;
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    let j: unknown;
    try {
      j = JSON.parse(line);
    } catch {
      /* A torn line. Only the LAST line can be torn by a crashed append; an
       * unparseable line anywhere else is still skipped (a skipped message
       * beats a lost log) but the last-line case is the designed one. */
      if (i === lines.length - 1 || (i === lines.length - 2 && !lines[lines.length - 1].trim())) torn = true;
      continue;
    }
    if (!j || typeof j !== "object") continue;
    const rec = j as Record<string, unknown>;
    if (rec.t === "m") {
      const { t: _t, ...msg } = rec;
      /* A message with no usable ts (another version's write, a hand edit) is
       * still a message: it is kept, exactly as the old whole-file restore kept
       * it. It merely can never be addressed by a patch. */
      msgs.push(msg as StoredMsg);
    } else if (rec.t === "e" && rec.ev === "patch" && typeof rec.mts === "number") {
      applyPatch(msgs, {
        mts: rec.mts,
        set: rec.set && typeof rec.set === "object" ? (rec.set as Record<string, unknown>) : undefined,
        del: Array.isArray(rec.del) ? rec.del.filter((k): k is string => typeof k === "string") : undefined,
      });
    } else if (rec.t === "s") {
      const r = parseSessionRec(rec);
      if (r) recs.push(r);
    }
    // any other t: written by a newer build; ignored rather than believed
  }
  return { msgs, recs, torn };
}

/** Replay one chat file's text into a message array (the records are
 *  dropped: the callers that want them use replayLogText). */
export function replayChatText(text: string): StoredMsg[] {
  return replayLogText(text).msgs;
}

/** One log's rows in storage order: messages and records merged by seq. A
 *  row with no seq (a pre-seq message) sorts by its position among the
 *  messages, which is where ensureSeqs will put it. */
export function rowsBySeq<M extends { seq?: number }, R extends { seq: number }>(
  msgs: readonly M[], recs: readonly R[],
): (M | R)[] {
  const out: (M | R)[] = [];
  let i = 0, j = 0;
  while (i < msgs.length || j < recs.length) {
    const m = msgs[i];
    const r = recs[j];
    if (m === undefined) { out.push(r); j++; continue; }
    if (r === undefined) { out.push(m); i++; continue; }
    if ((m.seq ?? i) <= r.seq) { out.push(m); i++; } else { out.push(r); j++; }
  }
  return out;
}

export class ChatStore {
  /* One append chain per chat file, so the line order on disk is the call
   * order even when appends interleave with awaits. The chain never rejects;
   * a failed append is logged by the catch the caller installed on boot. */
  private chains = new Map<string, Promise<void>>();
  constructor(private onError: (err: unknown, path: string) => void = () => {}) {}

  private enqueue(path: string, line: string): void {
    const prev = this.chains.get(path) ?? Promise.resolve();
    const next = prev.then(async () => {
      // the agent's chats dir may not exist yet: the first line makes it
      await mkdirPrivate(path.slice(0, path.lastIndexOf("/")));
      await appendPrivate(path, line + "\n");
    }).catch((e) => this.onError(e, path));
    this.chains.set(path, next);
  }

  /** Append one message line. The caller has already stamped ts + seq. */
  appendMsg(agentId: string, chatId: string, msg: StoredMsg): void {
    this.enqueue(agentChatFile(agentId, chatId), JSON.stringify({ t: "m", ...msg }));
  }

  /** Append one patch line: edit the message whose ts is `mts`. */
  appendPatch(agentId: string, chatId: string, p: ChatPatch): void {
    const line: Record<string, unknown> = { t: "e", ev: "patch", mts: p.mts };
    if (p.set && Object.keys(p.set).length) line.set = p.set;
    if (p.del && p.del.length) line.del = p.del;
    this.enqueue(agentChatFile(agentId, chatId), JSON.stringify(line));
  }

  /** Append one session record line. The caller (chatlog.ts logSession) has
   *  already stamped seq + id and done the idempotency check: this is the
   *  ONE writer, on the same per-file chain as the messages, so the line
   *  order on disk is the seq order. */
  appendRec(agentId: string, chatId: string, rec: SessionRec): void {
    this.enqueue(agentChatFile(agentId, chatId), JSON.stringify({ t: "s", ...rec }));
  }

  /** Every append issued so far is on disk when this resolves. */
  async flush(): Promise<void> {
    await Promise.all([...this.chains.values()]);
  }

  /** Load one chat's messages. Missing file = empty log (a fresh chat id not
   *  yet written). */
  async load(agentId: string, chatId: string): Promise<StoredMsg[]> {
    return (await this.loadLog(agentId, chatId)).msgs;
  }

  /** Load one chat whole: messages AND session records. */
  async loadLog(agentId: string, chatId: string): Promise<ReplayedLog> {
    const f = Bun.file(agentChatFile(agentId, chatId));
    if (!(await f.exists())) return { msgs: [], recs: [], torn: false };
    return replayLogText(await f.text());
  }

  /** Write a whole log as a NEW chat file (merge, trim) and return its id.
   *  Never touches an existing file; the caller flips the meta pointer. The
   *  records, when given, are interleaved with the messages by seq so the new
   *  file's line order is its storage order. */
  async writeNew(agentId: string, msgs: StoredMsg[], recs: SessionRec[] = []): Promise<string> {
    const chatId = newChatId();
    // both paths before the first await: dataDir() is read per call (agentmeta.ts saveAgentMeta)
    const dir = agentChatsDir(agentId);
    const path = agentChatFile(agentId, chatId);
    await mkdirPrivate(dir);
    // build the whole body, one append: a new file either exists whole or not at all
    const recSet = new Set<unknown>(recs);
    const body = rowsBySeq(msgs as (StoredMsg & { seq?: number })[], recs)
      .map((r) => JSON.stringify(recSet.has(r) ? { t: "s", ...r } : { t: "m", ...r }))
      .join("\n");
    await appendPrivate(path, body.length ? body + "\n" : "");
    return chatId;
  }

  /** The chat ids that have files on disk for this agent, no order promised. */
  async listChats(agentId: string): Promise<string[]> {
    try {
      return (await readdir(agentChatsDir(agentId)))
        .filter((n) => n.endsWith(".jsonl"))
        .map((n) => n.slice(0, -".jsonl".length));
    } catch {
      return [];
    }
  }
}
