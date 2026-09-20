// The opencode HarnessReader over the existing OPENCODE_TRANSCRIPT
// (transcripts.ts). It is registered in the default READERS table
// (adapters/mux-adapter.ts), replacing the readerFromTranscript duplicate that
// stood in for it. It also still reads as the shape for a reader you write
// yourself.
//
// HONEST BY CONSTRUCTION. Every implemented method delegates to the
// fixture-proven OPENCODE_TRANSCRIPT (the live opencode.db, or a captured JSON
// dump). Every capability opencode does not actually implement returns the
// documented empty shape and never throws: title() is null, runs() is [], and
// parseScreen is omitted. The locate() result can be a `db#sessionId`
// path, which is the one non-file path shape in the seam and is documented here
// on purpose.

import { OPENCODE_TRANSCRIPT, splitOpenCodePath } from "../chat/transcripts.ts";
import type { SessionEvent } from "../sessions/session-events.ts";
import type { HarnessReader } from "./types.ts";

/* ----------------------------------------------------- the activity tail
 *
 * opencode's live store is sqlite (opencode.db: session + message + part), NOT
 * an append-only file, so its activity source is the POLL form of the declared
 * slot (readers/types.ts): `since(path, cursor)` answers every part row of the
 * session with `time_updated > cursor`, and the adapter polls it on the tail
 * heartbeat, stat-gated on the db + wal files.
 *
 * The part shape is MEASURED, not guessed: captured 2026-09-05 from a real
 * opencode 1.18.19 run against a throwaway XDG_DATA_HOME --
 *
 *   {"type":"tool","tool":"bash","callID":"bash_1","state":{"status":"completed",
 *    "input":{"command":"cat note.txt","timeout":10000},"output":"hello world\n",
 *    "title":"cat note.txt","time":{...}}}   (part id prt_..., time_created ms)
 *
 * and the error twin ({... "state":{"status":"error","input":{...},"error":...}).
 * Only TERMINAL tool parts (completed / error) become rows: a pending/running
 * part is skipped but still advances the cursor, and its completion touches
 * `time_updated` again, so it is re-seen then -- while logSession's h|sid|rid
 * key (rid = the part id) makes any double-sighting collapse to one row.
 * Compaction and interrupts are NOT mapped: this machine's db and a live
 * capture show no on-disk record for either (session.time_compacting is a
 * column, its written shape unverified), and unverified shapes do not ship.
 * Named plainly in the lane report as the opencode follow-up. */

const OC_TEXT_CAP = 200; // claude's TEXT_CAP for tool one-liners

function ocCap(s: string): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > OC_TEXT_CAP ? t.slice(0, OC_TEXT_CAP) + "…" : t;
}

type OcPartRow = { id: string; time_created: number; time_updated: number; data: any };

function ocToolEvent(row: OcPartRow): SessionEvent | null {
  const d = row.data;
  if (!d || d.type !== "tool") return null;
  const status = d.state?.status;
  if (status !== "completed" && status !== "error") return null; // not terminal yet
  const tool = typeof d.tool === "string" && d.tool ? d.tool : "tool";
  const title = typeof d.state?.title === "string" ? d.state.title.trim() : "";
  const cmd = typeof d.state?.input?.command === "string" ? d.state.input.command : "";
  const what = title || cmd;
  const text = ocCap(what ? `${tool}: ${what}` : tool) + (status === "error" ? " (failed)" : "");
  return { uuid: row.id, ts: row.time_created, kind: "tool", tool, text };
}

/** Every activity event of the session newer than `cursor` (ms, the part row's
 *  time_updated), plus the new cursor; null when the store is unreadable.
 *  Accepts the locate's `db#sessionId` shape, and a captured `.json#sessionId`
 *  dump the way the transcript reads do. Exported for the fixture tests. */
export async function opencodeEventsSince(path: string, cursor: number):
  Promise<{ events: SessionEvent[]; cursor: number } | null> {
  const { db, sessionId } = splitOpenCodePath(path);
  if (!sessionId) return null;
  const f = Bun.file(db);
  if (!(await f.exists())) return null;
  let rows: OcPartRow[];
  if (db.endsWith(".json")) {
    let dump: any;
    try { dump = JSON.parse(await f.text()); } catch { return null; }
    rows = (Array.isArray(dump?.parts) ? dump.parts : [])
      .filter((p: any) => (p?.session_id ?? sessionId) === sessionId)
      .map((p: any) => ({ id: String(p.id ?? ""), time_created: Number(p.time_created ?? 0),
        time_updated: Number(p.time_updated ?? p.time_created ?? 0), data: p.data }))
      .filter((r: OcPartRow) => r.id && r.time_updated > cursor)
      .sort((a: OcPartRow, b: OcPartRow) => a.time_updated - b.time_updated || (a.id < b.id ? -1 : 1));
  } else {
    try {
      const { Database } = await import("bun:sqlite");
      const sqlite = new Database(db, { readonly: true });
      try {
        rows = (sqlite.query(
          "select id, time_created, time_updated, data from part where session_id = ? and time_updated > ? order by time_updated, id",
        ).all(sessionId, cursor) as Array<{ id: string; time_created: number; time_updated: number; data: string }>)
          .map((r) => {
            let data: any = null;
            try { data = JSON.parse(r.data); } catch { /* an unparsable row maps to no event */ }
            return { id: r.id, time_created: r.time_created, time_updated: r.time_updated, data };
          });
      } finally {
        sqlite.close();
      }
    } catch {
      return null; // locked/corrupt/missing driver: the next poll retries
    }
  }
  const events: SessionEvent[] = [];
  let next = cursor;
  for (const row of rows) {
    if (row.time_updated > next) next = row.time_updated;
    const ev = ocToolEvent(row);
    if (ev) events.push(ev);
  }
  return { events, cursor: next };
}

export const opencodeReader: HarnessReader = {
  tag: "opencode",

  // reads-only, the same shape as codex: model + pct off the transcript read.
  capabilities: { context: "transcript" },

  detect(input) {
    return input.kindStamp === "opencode";
  },

  // The opencode locate: ~/.local/share/opencode/opencode.db, or a JSON dump.
  locate: OPENCODE_TRANSCRIPT.locate,

  // Working/idle edges from opencode role / step-start / step-finish records.
  turnEdge: OPENCODE_TRANSCRIPT.turnEdge,

  // The activity tail: terminal tool parts off the db, polled (see above).
  sessionEvents: { mode: "poll", since: opencodeEventsSince },

  contextPct: OPENCODE_TRANSCRIPT.contextPct,
  model: OPENCODE_TRANSCRIPT.model,

  // Conversation turns joined from message + text parts.
  messages: OPENCODE_TRANSCRIPT.messages,

  /* HOW THE ENGINE STARTS (AND RESUMES) OPENCODE, mirroring readers/codex.ts.
   * Verified live against opencode 1.18.19 (`opencode --help`):
   *   -s, --session   session id to continue   [string]
   *   --auto          auto-approve permissions that are not explicitly
   *                   denied (dangerous!)
   * So `opencode --session <ses_id>` resumes by id on the default TUI command
   * (--fork is start-not-resume, like pi's, and is not used). `--auto` is the
   * cyc trust-model analog of claude's --dangerously-skip-permissions and
   * codex's --dangerously-bypass-approvals-and-sandbox: the user's own agent on
   * their own machine, so the app never strands on an approval prompt.
   * SIDE EFFECT: a launch command also opens the restart route (session-ops.ts)
   * AND the /compact path (compactSession, sessions/session-verbs.ts:79) for
   * opencode. /compact is a real opencode TUI slash command (verified: the
   * 1.18.19 binary carries the literal `/compact` alongside its other TUI verbs
   * /new, /share, /help, /init, /clear, /undo, /redo, /sessions), so typing it
   * into an opencode pane is the intended action, not a six-character paste. */
  launch: {
    command: "opencode --auto",
    resume: (sessionId: string) => `opencode --auto --session ${sessionId}`,
  },

  // Not implemented for opencode: no title reader, no agent-run parser.
  async title() { return null; },
  async runs() { return []; },
};
