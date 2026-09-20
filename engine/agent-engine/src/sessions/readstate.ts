/* READ STATE (L2 domain): the ONE unread marker and everything derived from it.
 *
 * The count and the row's flag are the same fact shown twice; read-aloud
 * starts at the marker; the divider draws at it. Nothing here stores a second
 * answer. FORWARD ONLY through markRead; markUnread is the one deliberate
 * exception, and filedTs answers the only question the marker cannot (which
 * messages he has already accounted for), read by the push paths alone.
 *
 * Structural session type: this module reads only the read-marker fields, so
 * the engine's full Session satisfies it and no cycle forms.
 *
 *   bun test agent-engine/src/sessions/readstate.test.ts
 */

export type ReadableChat = { role: "user" | "claude"; ts: number; mid?: string };

/** The IDENTITY of the newest row the user has read: its durable row key
 *  (`mid`) and the instant it carries. The marker clock (`heardTs`) is kept as
 *  the derived/legacy field the persistence and every ts consumer still read,
 *  but the row IDENTITY is what rides the wire so the app anchors its divider on
 *  the ROW rather than re-deriving a position from a timestamp it cannot trust
 *  (a restamp, a mis-sorted legacy page). */
export type ReadThrough = { mid?: string; ts: number };

export type ReadStateSession = {
  id: string;
  chat: ReadableChat[];
  heardTs: number;
  notified?: boolean;
  silentSince?: number;
  filedTs?: number;
  doneSeq: number;
  seenDoneSeq: number;
  status: string;
};

export type ReadStateDeps = {
  /** persist the marker (debounced meta save) */
  scheduleHeardSave(sessionId: string): void;
  /** take the standing banner down on the devices */
  sendDismissal(s: ReadStateSession): void;
  broadcastSessions(): void;
};

const INERT: ReadStateDeps = {
  scheduleHeardSave: () => {},
  sendDismissal: () => {},
  broadcastSessions: () => {},
};
let deps: ReadStateDeps = INERT;
export function initReadState(d: ReadStateDeps): void {
  deps = d;
}

/** TEST ONLY: put the deps back to the inert defaults, so a second in-process
 *  wiring cannot persist or dismiss through the first one's seams. This module
 *  owns no timers and no cache (the marker lives on the Session), so the deps
 *  bag is all there is to reset. No-op in production, which never re-wires. */
export function resetForTest(): void {
  deps = INERT;
}

/* HOW MANY MESSAGES ARE NEW FOR YOU, computed, never stored. Only the agent's
 * messages count: your own are yours, and session activity (doneSeq) is a
 * different signal that must never be added in here. */
export function unreadOf(s: ReadStateSession): number {
  let n = 0;
  for (const c of s.chat) if (c.role === "claude" && c.ts > s.heardTs) n++;
  return n;
}

/* THE READ-THROUGH ROW IDENTITY, resolved from the marker clock against the
 * log ORDER. The engine's order is ts order, so the newest row with ts <=
 * heardTs is the marker's position; its `mid` is the durable key the app dedups
 * on. Undefined when nothing has been read. This is the ONE identity the wire
 * carries and the ONLY thing the app anchors on. */
export function readThroughOf(s: ReadStateSession): ReadThrough | undefined {
  let best: ReadableChat | undefined;
  for (const c of s.chat) {
    if (c.ts <= s.heardTs && (best === undefined || c.ts > best.ts)) best = c;
  }
  return best ? { mid: best.mid, ts: best.ts } : undefined;
}

/* A DEVICE SIGHTED A ROW: "I saw row R", named by its durable identity. Devices
 * report sightings; they never compute state. The engine is the only authority:
 * it resolves the row in its OWN log by identity (the durable key first, the
 * instant as a fallback for a row with no key) and moves the marker forward to
 * that row's position, FORWARD ONLY by log order, never by the device's clock.
 * A sighting that names no row we hold -- it aged out of the log, or came off a
 * longer axis -- is ignored with a log line rather than moving anything.
 * Returns whether the marker moved, so callers can skip the broadcast. */
export function markReadRow(s: ReadStateSession, row: { mid?: string; ts?: number }): boolean {
  let at = -1;
  if (row.mid) at = s.chat.findIndex((c) => c.mid === row.mid);
  if (at < 0 && typeof row.ts === "number" && Number.isFinite(row.ts)) {
    for (let i = 0; i < s.chat.length; i++) if (s.chat[i].ts === row.ts) { at = i; break; }
  }
  if (at < 0) {
    console.log(
      `[readstate] ${s.id}: heard sighting names no row we hold ` +
      `(mid=${row.mid ?? "-"} ts=${row.ts ?? "-"}), ignored`,
    );
    return false;
  }
  return markRead(s, s.chat[at].ts);
}

/* Move the marker forward to this instant. FORWARD ONLY: two devices catching
 * up at once, or a stale ack arriving after a newer read, must not un-read
 * anything. Returns whether anything moved, so callers can skip the broadcast.
 * ONE ARGUMENT, because there is one marker. */
export function markRead(s: ReadStateSession, ts: number): boolean {
  if (ts <= s.heardTs) return false;
  s.heardTs = ts;
  /* Reading settles the ceiling clock: whatever was waiting has been seen, so
   * the ten-minute backstop must not later buzz about something he has
   * already seen. Every path to "read" comes through this function. */
  s.silentSince = undefined;
  /* AND READING SUPERSEDES FILING. He marked it unread to come back to it;
   * this is him coming back to it. */
  s.filedTs = 0;
  deps.scheduleHeardSave(s.id); // reading survives a restart
  /* READ HERE => TAKE IT DOWN THERE. Guarded on
   * unread reaching zero, not merely on the marker moving: reading the first
   * of three replies leaves two waiting, and the banner still tells the
   * truth. */
  if (s.notified && unreadOf(s) === 0) void deps.sendDismissal(s);
  return true;
}

/* Everything currently in the log is read. What "opening the chat" means, and
 * what a device that played the last reply through has effectively done. */
export function markAllRead(s: ReadStateSession): boolean {
  const last = s.chat[s.chat.length - 1];
  if (!last) return false;
  return markRead(s, last.ts);
}

export function markReadOnUtterance(s: ReadStateSession, ts: number): void {
  if (markRead(s, ts)) deps.broadcastSessions();
}

/* MARK IT UNREAD AGAIN: the one marker, moved BACKWARDS. The
 * marker is put back to just before the agent's last message and every view
 * follows for free: the count, the flag, the badge sum, the divider, and
 * where speech resumes. filedTs is set so neither push path fires about a
 * message he just filed; a timestamp decays where a flag would not, so a
 * LATER reply is news again by arithmetic. Returns false when there is
 * nothing of the agent's to be unread, or the chat is unread already. */
export function markUnread(s: ReadStateSession): boolean {
  let last = -1;
  for (let i = s.chat.length - 1; i >= 0; i--) {
    if (s.chat[i].role === "claude") { last = i; break; }
  }
  if (last < 0) return false;
  const ts = s.chat[last].ts - 1;
  if (ts >= s.heardTs) return false;
  s.heardTs = ts;
  s.filedTs = s.chat[last].ts;
  deps.scheduleHeardSave(s.id); // unread survives a restart, exactly as read does
  return true;
}

/* IS EVERYTHING UNREAD HERE SOMETHING HE FILED HIMSELF? The newest agent line
 * is the whole test: he filed everything that was here when he tapped, so if
 * the newest is still one of those, there is nothing he has not seen. Called
 * by the disconnect flush and nowhere else. */
export function filedAndQuiet(s: ReadStateSession): boolean {
  if (!s.filedTs) return false;
  for (let i = s.chat.length - 1; i >= 0; i--) {
    if (s.chat[i].role === "claude") return s.chat[i].ts <= s.filedTs;
  }
  return false;
}

/* ---------------- first-sight seeding (what a fresh snapshot inherits) ---- */

export type SeenRecord = { doneSeq: number; seenDoneSeq: number };

export function doneSeqFor(
  prev: Pick<ReadStateSession, "doneSeq" | "status"> | undefined,
  a: { handle: string; statusHint: string },
  restored?: SeenRecord,
): number {
  const base = prev?.doneSeq ?? restored?.doneSeq ?? 0;
  // no previous observation means no edge to detect, only a state to adopt
  if (!prev) return base;
  return base + (a.statusHint === "done" && prev.status !== "done" ? 1 : 0);
}

export function seenDoneSeqFor(
  prev: Pick<ReadStateSession, "doneSeq" | "status" | "seenDoneSeq"> | undefined,
  a: { handle: string; statusHint: string },
  restored?: SeenRecord,
): number {
  if (prev) return prev.seenDoneSeq;
  if (restored) return restored.seenDoneSeq;
  // first sight, nothing remembered: start level rather than inheriting
  // the mux's idea of unread
  return doneSeqFor(prev, a, restored);
}
