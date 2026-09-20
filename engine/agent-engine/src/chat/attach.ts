/* ATTACH (L3 feature): the one-round-trip open and read-progress reporting.
 *
 * A conversation is served in fixed pages of 100 by seq (pages.ts); the
 * attach answer is ONE frame the app can paint from once. A page holds BOTH
 * kinds of row on the one seq axis: the chat messages and the session records
 * (`t: "s"`, chat/sessionrec.ts) the ingest appended beside them. There is no
 * second frame for "activity": the records ARE the log, read from the same
 * file the messages came from, so a cold open after an engine reboot paints
 * messages and events together from the first frame.
 *
 * Opening no longer marks the chat read: the divider is
 * drawn AT the pointer and the pointer advances only as the app REPORTS
 * progress. The one thing an open still settles is the ACTIVITY dot.
 *
 * The device states one frontier seq F (the highest seq the engine has
 * confirmed this device holds contiguously). The engine streams every page
 * that intersects (F, T], newest-complete, capped at DELTA_PAGES_MAX pages.
 * An un-reloaded bundle may still send `have`; that path is deprecated.
 */

import { PAGE_SIZE, pageOf, tailPage, buildPage, pointerSeq, tsForSeq } from "../runtime/pages.ts";
import { ensureSeqs, type ChatSession } from "./chatlog.ts";
import type { ChatMsg } from "./chatmsg.ts";
import type { SessionRec } from "./sessionrec.ts";
import { rowsBySeq } from "./chatstore.ts";
import { markRead, type ReadStateSession } from "../sessions/readstate.ts";
import type { Sock } from "../transport/sock.ts";

/* `chat` is lifted out of the intersection and stated once. Both parts carry
 * it, but ReadStateSession spells it as the two fields read-state needs
 * (ReadableChat) while ChatSession spells the whole ChatMsg. Intersecting them
 * gives `ChatMsg[] & ReadableChat[]`, and TypeScript will not treat THAT as a
 * `readonly Seqd[]`: the two array types' `concat` overloads are incompatible,
 * so every pages.ts call here failed on a chat that is only ever ChatMsg[].
 * ChatMsg satisfies ReadableChat, so naming the concrete element type loses
 * nothing and each part keeps its own narrower view of the same array. */
export type AttachSession = Omit<ChatSession & ReadStateSession, "chat"> & {
  chat: ChatMsg[];
  log: SessionRec[];
  cwd: string;
};

export type AttachDeps = {
  sessionOf(id: string): AttachSession | undefined;
  send(ws: Sock, msg: unknown): void;
  broadcastSessions(): void;
  scheduleHeardSave(sessionId: string): void;
  log(event: string, fields: Record<string, unknown>): void;
};

let deps: AttachDeps | null = null;
export function initAttach(d: AttachDeps): void {
  deps = d;
}
const D = (): AttachDeps => {
  if (!deps) throw new Error("attach not initialised");
  return deps;
};

/** A session record as it rides in a page: tagged so the app can tell it
 *  from a message without inspecting fields. */
export type WireRec = SessionRec & { t: "s" };
export type WireRow = (ChatMsg & { seq: number; id: string }) | WireRec;

/** The rows of one session in storage order, ready for buildPage: messages
 *  with their routing id forced to THIS session (a ChatMsg's own id can be a
 *  stale pane id on a re-keyed session) and records tagged `t: "s"`. */
export function wireRows(s: AttachSession): WireRow[] {
  /* Idempotent, and cheap when the run is already correct (one scan, no
   * writes). Every other paging caller stamps first; doing it here too makes
   * this function safe on its own rather than on its callers' good manners. */
  ensureSeqs(s.chat, s.log);
  const recs = new Set<unknown>(s.log);
  return rowsBySeq(s.chat, s.log).map((r) =>
    recs.has(r) ? { t: "s" as const, ...(r as SessionRec) } : { ...(r as ChatMsg & { seq: number }), id: s.id });
}

/* One page, ready for the wire: buildPage's shape over the merged rows. */
export function wirePage(s: AttachSession, n: number) {
  return buildPage(wireRows(s), n);
}

/** Newest seq on the merged axis; -1 when the log has never held a row. */
export function newestSeqOf(rows: readonly { seq: number }[]): number {
  const last = rows[rows.length - 1];
  return last ? last.seq : -1;
}

/** Wake after days is still bounded; a brand-new device gets the newest 20
 *  pages and backfills older by scroll. */
export const DELTA_PAGES_MAX = 20;

function readFrontier(m: any): number | null {
  if (m.frontier === undefined || m.frontier === null || m.frontier === "") return null;
  const F = Math.floor(Number(m.frontier));
  return Number.isFinite(F) ? F : null;
}

export function onAttach(ws: Sock, m: any) {
  const d = D();
  const id = String(m.id ?? "");
  const s = d.sessionOf(id);
  ws.data.attached = s ? id : null;
  if (!s) {
    d.log("attach", { client: `c${ws.data.cid}`, session: id || "(none)", known: false,
      why: id ? "no such session on this engine" : "the client detached from every chat" });
    /* AN ANSWER, RATHER THAN SILENCE, and it says "not here" rather than
     * "empty" (task 192): the app keeps whatever it holds and stops waiting. */
    if (id) d.send(ws, { t: "attach-ok", id, known: false });
    return;
  }
  ensureSeqs(s.chat, s.log);
  const rows = wireRows(s);
  const total = rows.length;
  const T = newestSeqOf(rows);
  const tail = tailPage(rows);
  const pointer = pointerSeq(s.chat, s.heardTs);
  // The page the divider sits on, clamped into the real range.
  const ptrPage = Math.min(tail, Math.max(0, pageOf(pointer)));
  const tailVersion = buildPage(rows, tail).version;
  const F0 = readFrontier(m);
  /* A frontier beyond the newest seq this axis can hold is IMPOSSIBLE: the
   * device cached rows from an OLDER, LONGER seq axis (a pre-rebuild engine),
   * so nothing it claims to hold maps onto this axis. Honouring it would take
   * the F >= T branch and skip every page forever, wedging the device on stale
   * mid-history while it never receives the real tail. Treat it as a cold
   * attach (frontier -1): serve the newest pages and a deltaBase exactly as for
   * a new device, so a stale client can never wedge itself. */
  const axisMismatch = F0 !== null && F0 > tailVersion;
  if (axisMismatch) {
    d.log("attach.axis-mismatch", {
      client: `c${ws.data.cid}`, session: id, frontier: F0, tailVersion, tail, total,
    });
  }
  const F = axisMismatch ? -1 : F0;
  /* LEGACY (deprecated): an un-reloaded device bundle still sends `have`
   * {tailPage, tailVersion}. Match still skips, as before. New app sends
   * `frontier` and never `have`. This is THIS ROLLOUT'S bridge for
   * pre-frontier bundles that have not yet reloaded, NOT a permanent contract.
   * REMOVE after the final deploy is confirmed on both instances and devices
   * reloaded. */
  const have = m.have && typeof m.have === "object" ? m.have : null;

  let pages: ReturnType<typeof buildPage>[];
  let deltaBase: number | undefined;
  let pagesSkipped = false;
  let legacyHave = false;

  if (F !== null) {
    /* One shape for attach, re-attach, reconnect, settled-edge, wake: the
     * device states the highest seq the engine has confirmed, and we send
     * every page that intersects (F, T], newest-complete, capped at 20. */
    if (F >= T) {
      pages = [];
      deltaBase = T + 1;
      pagesSkipped = true;
    } else {
      const lo = Math.max(F + 1, T + 1 - DELTA_PAGES_MAX * PAGE_SIZE);
      const fromPage = pageOf(lo);
      const toPage = pageOf(T);
      pages = [];
      for (let n = toPage; n >= fromPage; n--) pages.push(buildPage(rows, n));
      deltaBase = lo;
    }
  } else {
    if (have) {
      legacyHave = true;
      d.log("attach.legacy-have", {
        client: `c${ws.data.cid}`, session: id,
        tailPage: Number(have.tailPage), tailVersion: Number(have.tailVersion),
      });
    }
    const tailMatches = have !== null &&
      Number(have.tailPage) === tail && Number(have.tailVersion) === tailVersion;
    const wanted = ptrPage === tail ? [tail] : [ptrPage, tail];
    pages = tailMatches ? [] : wanted.map((n) => buildPage(rows, n));
    pagesSkipped = tailMatches;
  }

  d.log("attach", { client: `c${ws.data.cid}`, session: id, known: true,
    total, messages: s.chat.length, records: s.log.length, pointer, ptrPage, tail,
    tailVersion, frontier: F0 ?? undefined, deltaBase,
    have: have !== null || undefined, pagesSkipped: pagesSkipped || undefined,
    legacyHave: legacyHave || undefined, axisMismatch: axisMismatch || undefined });
  /* THE QUEUED TRUTH RIDES ON EVERY ATTACH. A dequeue is a patch: it changes
   * a row without changing any seq, so the have/tailVersion check cannot see
   * it and a client that missed the live `dequeued` frame (a reconnect gap)
   * kept "Queued for Claude" on a long-delivered message forever
   * (2026-09-06). The list is the engine's current answer, usually empty;
   * the app reconciles its held rows against it on every open. */
  const queued = s.chat.filter((m) => m.role === "user" && m.queued).map((m) => m.ts);
  d.send(ws, { t: "attach-ok", id: s.id, known: true,
    pointer, pointerPage: ptrPage, tailPage: tail, pageSize: PAGE_SIZE, total, pages, queued,
    ...(deltaBase !== undefined ? { deltaBase } : {}) });
  const wasUnseen = s.seenDoneSeq < s.doneSeq;
  s.seenDoneSeq = s.doneSeq; // opening the chat clears the ACTIVITY dot only
  if (wasUnseen) { d.scheduleHeardSave(s.id); d.broadcastSessions(); }
}

/* A device consumed the conversation up to this seq (brief item 6). Forward
 * only through markRead; `explicit: true` is the one allowed backward write. */
export function onProgress(m: any) {
  const d = D();
  const s = d.sessionOf(String(m.id ?? ""));
  if (!s) return;
  ensureSeqs(s.chat, s.log);
  const seq = Math.floor(Number(m.seq));
  if (!Number.isFinite(seq)) return;
  const ts = tsForSeq(s.chat, seq);
  if (!ts) return;
  const explicit = m.explicit === true;
  const moved = explicit && ts < s.heardTs ? setHeardBack(s, ts) : markRead(s, ts);
  if (moved) d.broadcastSessions();
}

/* Put the marker BACK to an earlier instant on purpose. It accounts for every
 * agent message present now via filedTs, exactly as markUnread does, so
 * neither push path fires for a chat he deliberately made unread. */
export function setHeardBack(s: AttachSession, ts: number): boolean {
  if (ts >= s.heardTs) return false;
  s.heardTs = ts;
  let lastClaude = 0;
  for (let i = s.chat.length - 1; i >= 0; i--) {
    if (s.chat[i].role === "claude") { lastClaude = s.chat[i].ts; break; }
  }
  s.filedTs = lastClaude;
  D().scheduleHeardSave(s.id);
  return true;
}
