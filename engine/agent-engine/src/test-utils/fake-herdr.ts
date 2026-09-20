/* THE FAKE HERDR, extracted verbatim from notify-harness.ts.
 *
 * Every measured pane behaviour is preserved exactly, because every one of them
 * was checked against a live claude pane and three versions of the delivery fix
 * failed on a terminal behaviour a test file had merely asserted: typing
 * appends, enter submits only a NONEMPTY box, ctrl+c is eaten by a running turn
 * and empties an idle box, ctrl+u clears nothing, pane.read honours `format`
 * and paints the dim suggestion into an empty box.
 *
 * What changed is only who may use it. It used to serve one boot harness; it
 * now serves a unix socket at a per-test tmp path that a seam test hands
 * straight to `new HerdrClient(sockPath)`, so a seam test drives the REAL
 * MuxAdapter over the REAL herdr JSON-RPC framing with no engine process
 * anywhere.
 */

import { until } from "./wait.ts";

export const PANE = "w1:p1";

/* THE cwd EVERY FAKE PANE REPORTS. Claude Code keys its transcripts by cwd, so a
 * spec that authors a transcript (the #571 roll continuity check stats them)
 * needs the one the engine will compute the path from. */
export const HARNESS_CWD = "/tmp/notify-harness";

/** The harness session id a pane reports when a test seeded none: a UUID
 *  (v4-shaped) derived from the pane id, so it is the same on every snapshot
 *  and every restart, and a test that thinks in panes can find the row by
 *  it (the e2e harness and wire-core do exactly that). */
export function defaultSessionIdOf(paneId: string): string {
  const h = new Bun.CryptoHasher("sha256").update(`fake-herdr pane ${paneId}`).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

/* THE PUSH WINDOW EVERY HARNESS ENGINE RUNS ON, and the only copy of the
 * number. Import it; do not write 10_000 in a spec again.
 *
 * Production batches over ten seconds aligned to the wall clock. A spec that
 * waits that out for every "was it pushed" answer spends its
 * whole life asleep -- 72 seconds of literal Bun.sleep in notify.test.ts and 42
 * in unread.test.ts, for a decision the engine made in the first millisecond.
 *
 * SHORT, NOT ABSENT, which is the line that matters: two replies in one window
 * still arrive as ONE push, a dismissal inside the window still cancels the new
 * message it belongs to, and the window is still aligned to the wall clock
 * rather than started by the first message. Every property these specs assert
 * about batching is still being exercised; only the waiting is smaller.
 *
 * Two seconds rather than a few hundred ms because the alignment assertion has
 * to survive a machine running thirty engines: a push is expected within a
 * quarter of a window of the boundary, and a quarter of two seconds is 500ms of
 * room. */
export const BATCH_MS = 2_000;

/* herdr, reduced to the two calls the engine makes: one snapshot with claude
 * panes, and an event subscription that never says anything.
 *
 * `panes` defaults to the one pane every notification test wants. A test about
 * the ORDER of the chat list needs more than one row to have an order at all,
 * and the panes arrive in the order given: this fake is the only place herdr's
 * "spaces" sort exists, so the list it hands over IS herdr's order. */
/* ONE FAKE, not two.
 *
 * Two branches grew a fake herdr at the same time and they wanted different
 * halves of it: the delivery guard needs a rendered input box, ANSI, and a way
 * to make a keystroke refuse; the blocked-agent work needs a whole screen it
 * supplies itself, a `truncated` flag, and a status it can flip with the engine
 * being told. Both halves are here, over one piece of state, because two fakes
 * for one herdr is the same drift as two parsers for one screen.
 *
 * `rpcs` is every pane call the engine made, IN ORDER, which is the only place
 * what an agent actually receives can be read: the real herdr types it into a
 * terminal and nothing else on this side sees it. "Did ONE message go to the
 * session" is a question about the send_texts in here; "is a retry safe" is a
 * question about what came immediately before one. `keys` and `texts` are views
 * of that same list rather than a second record of it.
 *
 * A LINE CAN ARRIVE IN PIECES, and this fake used to assume it did not: it
 * split each chunk and dropped whatever did not parse. A frame larger than the
 * socket's send buffer arrives as several chunks, so the fake would have
 * refused the very messages that made the engine's own partial-write bug
 * visible, and a test of it would have failed against a fixed engine. Buffered
 * to the newline, like the real client.
 *
 * `failKeys` lets a test make a keystroke refuse, which is the failure that
 * strands a typed body in a real pane. It is given every send_keys in order so
 * a test can fail, say, only the enters. */
/** Ways a test can move the pane behind the engine's back, the way a person
 *  at the keyboard would. */
export type Hooks = {
  clearInput?: (pane: string) => void;
  setScreen?: (pane: string, screen: string | null) => void;
  /* THE STRANDED-BODY CASE, measured: an enter that RETURNS SUCCESS but does
   * not submit -- claude takes a rapid burst as one bracketed paste and an enter
   * inside that window becomes a newline in the input instead of a submit. The
   * next enter on `pane` does NOT clear/submit the input (the body stays sitting
   * there) and pins `screenAfter` as what pane.read then answers, so the
   * post-enter confirm reads a box that still has content. One-shot. */
  strandNextEnter?: (pane: string, screenAfter: string) => void;
  /** The next enter submits, but the box repaints empty only after
   *  `clearAfterMs`: the first post-enter read gets `stillHolding`, a later
   *  read gets `cleared`. Exercises the slow-clear re-read (false-strand fix). */
  slowClearNextEnter?: (pane: string, stillHolding: string, cleared: string, clearAfterMs: number) => void;
  /* THE TRANSCRIPT-ECHO CASE, measured on codex/opencode: a conversational TUI
   * SUBMITS the message (the box empties, the agent receives it) and ALSO echoes
   * the just-submitted user text into its on-screen transcript. So after a
   * SUCCESSFUL send the body is still on the full screen, above an empty box.
   * The next submit on `pane` clears/submits the input as normal AND pins a
   * screen showing the body in the transcript with the box empty, so the
   * post-enter read carries the body even though it was delivered. One-shot. */
  echoSubmitIntoTranscript?: (pane: string) => void;
};

export type FakeHerdr = {
  stop: (closeActive?: boolean) => void;
  /** what pane.read answers with, per pane, INSTEAD of the screen this fake
   *  would draw for itself. A test moves the dialog on by assigning a different
   *  screen, exactly as the terminal would.
   *
   *  THE POINT IS THAT THE TEST SUPPLIES REAL BYTES. This fake used to
   *  synthesise a "prompt" screen with no input box in it, so no test could
   *  ever ask what happens when a chooser pattern and a healthy input box are
   *  BOTH on screen -- which is exactly the case that made a live session
   *  unsendable-to. A harness that invents its own screens agrees with whatever
   *  the code believes. Store ANSI here: the read strips it when the caller did
   *  not ask for ansi, so what a screen holds is what a real capture holds. */
  screens: Map<string, string>;
  /** panes whose next pane.read comes back flagged `truncated`, as the real
   *  herdr does when it could not give you the whole screen */
  truncated: Set<string>;
  /* A PANE THAT TAKES THE REQUEST AND NEVER ANSWERS: a wedged terminal.
   *
   * Not the same failure as `failKeys`, and that is the point. A refusal comes
   * back, so the engine learns something and moves on within a round trip.
   * Silence is what herdr does when the pane behind it will not answer -- a
   * terminal mid-redraw, an agent that has stopped reading its tty -- and it is
   * the only shape that can hold a queue. The connection stays open, so nothing
   * here is a close the client could notice. */
  stalled: Set<string>;
  /** hold every pane rpc this long before answering it, correctly. A pane that
   *  is SLOW and completely fine, which a timeout must never refuse. */
  slow: { ms: number };
  /** every pane call, in order */
  rpcs: Array<{ method: string; pane: string; text?: string; keys?: string[] }>;
  /** every send_keys and send_text this fake was asked for, in order. The proof
   *  that a refused answer really did not press anything. Views over `rpcs`. */
  readonly keys: Array<{ paneId: string; keys: string[] }>;
  readonly texts: Array<{ paneId: string; text: string }>;
  /** flip a pane's agent_status AND tell the engine, the way herdr does: an
   *  event on the subscribed connection, not a silent change nobody hears. */
  setStatus: (paneId: string, status: string) => void;
  /** stop (or resume) listing an agent on that pane, plus the lifecycle event
   *  that makes the engine go and look. What claude exiting looks like.
   *  Resolves once the engine has come back for the list. */
  setAgentGone: (paneId: string, gone: boolean) => Promise<void>;
  /** the same conversation comes back on a DIFFERENT pane: its claude session id
   *  (agent_session) is carried onto `toPane`, `fromPane` stops being listed, and
   *  the engine is made to resnapshot. This is a restart that mints a new pane --
   *  the case the stable-session-id keying exists for. Resolves once the engine
   *  has come back for the list. */
  becomePane: (fromPane: string, toPane: string) => Promise<void>;
  /** claude on THIS pane finally minted its session uuid: agent_session flips
   *  from null to the uuid on the same pane, and herdr fires pane.agent_detected
   *  so the engine resnapshots. This is the no-session-id limbo ending (#405) --
   *  distinct from becomePane, where the conversation moves to a DIFFERENT pane.
   *  Resolves once the engine has come back for the list. */
  mintSession: (paneId: string, uuid: string) => Promise<void>;
  /** claude on this pane ROLLS its session uuid WITHOUT the process dying:
   *  agent_session flips from one uuid to another on the same pane, the way
   *  auto-compaction mints a fresh transcript mid-conversation. The pane never
   *  leaves the snapshot, so its session stays alive across the change -- the
   *  process continuity #571's carry keys on. Resolves once the engine has come
   *  back for the list. */
  rollSession: (paneId: string, uuid: string) => Promise<void>;
  /** the old claude EXITS and a brand-new one starts in the SAME pane under a
   *  new uuid. Distinct from rollSession (same process) and becomePane (restart
   *  onto a DIFFERENT pane): the pane is reused but the old claude is gone, so
   *  its session must already be dead (setAgentGone) when this fires. That
   *  deadness is the discriminator that stops the newcomer inheriting the old
   *  chat. Resolves once the engine has come back for the list. */
  respawnSession: (paneId: string, uuid: string) => Promise<void>;
};

export function fakeHerdr(path: string, agentStatus = "idle", panes: string[] = [PANE],
                         rpcs: FakeHerdr["rpcs"] = [],
                         failKeys?: (keys: string[]) => boolean,
                         submitted?: { pane: string; text: string }[],
                         hooks?: Hooks,
                         sessionIds: Map<string, string> = new Map(),
                         noSession: Set<string> = new Set(),
                         /* WHICH AGENT EACH PANE RUNS, herdr's own per-pane stamp.
                          * Defaults to claude for every pane, so every existing
                          * caller is unchanged. A test that wants a mixed fleet
                          * (claude + codex + opencode) maps pane -> agent id here;
                          * this is what proves invariant L1, that the engine lists
                          * every stamped pane whatever the agent. A `herdr:` prefix
                          * survives to the wire so normalization can be proven. */
                         agentOf: Map<string, string> = new Map()): FakeHerdr {
  const status = new Map(panes.map((id) => [id, agentStatus]));
  /** what each pane's input box is holding right now */
  const input = new Map<string, string>();
  /** is a turn running in this pane: decides whether the first ctrl+c is eaten
   *  by the interrupt or empties the box (measured, both) */
  const turnRunning = new Map<string, boolean>(panes.map((p) => [p, agentStatus === "working"]));
  const screens = new Map<string, string>();
  const truncated = new Set<string>();
  const stalled = new Set<string>();
  const slow = { ms: 0 };
  /* PANES THIS FAKE HAS STOPPED LISTING AN AGENT ON.
   *
   * The agent list used to be `panes`, fixed at construction, so no test could
   * ever make an agent GO AWAY -- and an agent going away is half of what a
   * restart is. `waitForAgentGone` could never return true, the route always
   * 502'd on the fake, and `verdict` and `tell` (the app's only source of truth
   * about the outcome) were unguarded: mutating either to a constant failed
   * nothing. Dropping a pane is what herdr reports when claude exits. */
  const gone = new Set<string>();
  /** how many times the engine has asked for the agent list. The engine's own
   *  `alive` is whatever the last of these said, so "it has resnapshotted since
   *  the event" is exactly "it has caught up". */
  let snapshots = 0;
  /** how many tabs /new-session has asked this fake to make */
  let madeTabs = 0;
  let seq = 1;
  let eventSock: import("bun").Socket | null = null;
  if (hooks) {
    hooks.setScreen = (pane: string, screen: string | null) => {
      if (screen === null) screens.delete(pane);
      else screens.set(pane, screen);
    };
  }
  /* Emptying the input WITHOUT the engine being told, which is a person
   * pressing ctrl+c at the keyboard. Nothing the engine remembers about its
   * own actions can cover that, so it is the case that separates "I checked
   * the pane" from "I believe what I noted down". */
  if (hooks) hooks.clearInput = (pane: string) => input.set(pane, "");
  /* Panes whose next enter must strand rather than submit, mapped to the screen
   * pane.read then answers (a box that still holds the body). One-shot. */
  const strandOnce = new Map<string, string>();
  if (hooks) hooks.strandNextEnter = (pane: string, screenAfter: string) =>
    strandOnce.set(pane, screenAfter);
  /* Panes whose next enter SUBMITS but whose busy TUI clears the box only
   * after `clearAfterMs`: the first post-enter read holds the body, the
   * re-strand read finds it gone. One-shot. */
  const slowClearOnce = new Map<string, { stillHolding: string; cleared: string; clearAfterMs: number }>();
  if (hooks) hooks.slowClearNextEnter = (pane, stillHolding, cleared, clearAfterMs) =>
    slowClearOnce.set(pane, { stillHolding, cleared, clearAfterMs });
  /* Panes whose next enter SUBMITS normally and then echoes the submitted body
   * into the transcript, pinning a screen that holds the body above an empty
   * box. One-shot. */
  const echoOnce = new Set<string>();
  if (hooks) hooks.echoSubmitIntoTranscript = (pane: string) => echoOnce.add(pane);
  /* WHICH WORKSPACE A PANE IS IN, read off its own id.
   *
   * Every pane in this harness has always been named `<workspace>:<pane>`,
   * because that is herdr's own shape, and until now the fake threw the first
   * half away and put every pane in one workspace called w1. That made it
   * impossible to ask this engine anything about GROUPING -- a test for tabs
   * per workspace could only ever see one workspace, which is the shape where
   * the feature and its absence look identical.
   *
   * A pane with no colon in it is one workspace's worth on its own, which is
   * what a single-pane test means by it. */
  const wsOf = (pane: string) => (pane.includes(":") ? pane.slice(0, pane.indexOf(":")) : "w1");
  const wsIds = () => [...new Set(panes.filter((id) => !gone.has(id)).map(wsOf))];
  const snapshot = () => ({
    snapshot: {
      agents: panes.filter((id) => !gone.has(id)).map((id, i) => {
        // The pane's agent stamp: claude unless the test mapped it otherwise. The
        // raw value (herdr: prefix and all) goes on the wire so the engine's own
        // normalization is what is under test, not the harness's.
        //
        // AN EMPTY MAPPING IS AN UNSTAMPED PANE, not the claude default: herdr
        // has SEEN the pane (it is in the snapshot, agent_status "unknown") but
        // has not classified its agent, so the `agent` field is absent entirely.
        // This is the live pi case -- a node-launched harness herdr is slow to
        // stamp -- and the row omits `agent` exactly as herdr's own does.
        const mapped = agentOf.get(id);
        const unstamped = mapped === "";
        const agent = mapped ?? "claude";
        const norm = agent.replace(/^herdr:/, "").toLowerCase();
        return {
        pane_id: id, ...(unstamped ? {} : { agent }),
        agent_status: unstamped ? "unknown" : (status.get(id) ?? agentStatus),
        /* The session handle (herdr's agent_session). DEFAULTS TO A UUID DERIVED
         * FROM THE PANE ID (defaultSessionIdOf), one per pane, stable across
         * snapshots and restarts, so a spec can go on addressing a session by its
         * pane while the engine sees a harness-shaped id: a pane id in this field
         * is refused at the shape gate (ids.ts), the way v1's pane-keyed sessions
         * leaked pane ids into real metas (defect B). A test that
         * needs its own id -- a restart onto a new pane, a roll -- seeds
         * `sessionIds`. It carries `kind`/`source`/`agent`, the shape a per-agent
         * herdr integration fills; the engine only lifts it into
         * harnessSessionId when the agent is claude. */
        /* A pane herdr has seen but whose agent has NOT yet minted a session id:
         * agent_session is null. This is the no-session-id limbo (#405) -- the
         * engine keys such a pane by its pane id until mintSession fires. */
        cwd: HARNESS_CWD,
        agent_session: noSession.has(id) ? null
          : { value: sessionIds.get(id) ?? defaultSessionIdOf(id), kind: "id", source: `herdr:${norm}`, agent: norm },
        workspace_id: wsOf(id), tab_id: `t${i + 1}`, state_change_seq: seq,
      };
      }),
      workspaces: wsIds().map((w, n) => ({
        workspace_id: w, number: n + 1, label: w === "w1" ? "probe" : w,
        tab_count: panes.filter((id) => !gone.has(id) && wsOf(id) === w).length,
      })),
      tabs: panes.map((p, i) => ({ tab_id: `t${i + 1}`, workspace_id: wsOf(p), number: i + 1, label: String(i + 1) })),
    },
  });
  const buf = new Map<import("bun").Socket, string>();
  const server = Bun.listen({
    unix: path,
    socket: {
      data(sock, chunk) {
        let held = (buf.get(sock) ?? "") + chunk.toString();
        let i: number;
        while ((i = held.indexOf("\n")) >= 0) {
          const line = held.slice(0, i);
          held = held.slice(i + 1);
          if (!line.trim()) continue;
          let m: any;
          try { m = JSON.parse(line); } catch { continue; }
          const pane = String(m.params?.pane_id ?? "");
          const isPane = typeof m.method === "string" && m.method.startsWith("pane.");
          /* THE WEDGED PANE TAKES THE REQUEST AND ANSWERS NOTHING -- and does
           * nothing either: no text appended, no enter submitted. Both halves
           * matter. A fake that silently applied the keystroke and only withheld
           * the reply would make "the message survived" a bookkeeping question;
           * here the agent genuinely never got it, which is the thing the
           * engine has to notice and say. The rpc is still recorded, because
           * "the engine tried" and "the agent received it" are separate
           * questions and only `submitted` answers the second. */
          if (isPane && stalled.has(pane)) {
            rpcs?.push({ method: m.method, pane,
              ...(m.method === "pane.send_text" ? { text: String(m.params?.text ?? "") } : {}),
              ...(m.method === "pane.send_keys" ? { keys: (m.params?.keys ?? []).map(String) } : {}) });
            continue;
          }
          /* A SLOW PANE DOES THE WORK AND ANSWERS LATE, which is the opposite
           * case and the one a timeout must not refuse. herdr applies the
           * keystroke when it gets it; only the reply is late. */
          const wire = (frame: string) => {
            if (isPane && slow.ms > 0) {
              setTimeout(() => { try { sock.write(frame); } catch { /* gone */ } }, slow.ms);
            } else sock.write(frame);
          };
          if (m.method === "session.snapshot") {
            snapshots++;
            wire(JSON.stringify({ id: m.id, result: snapshot() }) + "\n");
          } else if (m.method === "pane.send_text") {
            const t = String(m.params?.text ?? "");
            rpcs?.push({ method: m.method, pane, text: t });
            input.set(pane, (input.get(pane) ?? "") + t); // typing APPENDS, as it does
            wire(JSON.stringify({ id: m.id, result: {} }) + "\n");
          } else if (m.method === "pane.send_keys") {
            const keys = (m.params?.keys ?? []).map(String);
            rpcs?.push({ method: m.method, pane, keys });
            if (failKeys?.(keys)) {
              wire(JSON.stringify({ id: m.id,
                error: { code: -1, message: `refused ${keys.join("+")}` } }) + "\n");
            } else {
              /* The measured behaviour of a real claude pane. Every line here
               * was checked on one, because three versions of the delivery fix
               * failed on a terminal behaviour this file had simply asserted.
               *
               *   enter at an EMPTY box submits nothing at all;
               *   ctrl+c empties an IDLE box in one press, but mid-turn the
               *     first press is eaten by the interrupt and the body stays;
               *   ctrl+u does NOT empty a wrapped body (300 chars went from 5
               *     rows to 4), so it clears nothing here either. */
              if (keys.includes("enter")) {
                const strandTo = strandOnce.get(pane);
                const slowTo = slowClearOnce.get(pane);
                if (strandTo !== undefined) {
                  /* The enter succeeds but does NOT submit: the body stays in the
                   * input and pane.read now answers a box that still holds it. */
                  strandOnce.delete(pane);
                  screens.set(pane, strandTo);
                } else if (slowTo !== undefined) {
                  /* The enter SUBMITS (a user record lands), but the busy TUI
                   * has not repainted the box empty yet: the FIRST post-enter
                   * read still shows the body; the SECOND read (after the
                   * re-strand settle) shows it cleared. The engine must treat
                   * this as consumed, not stranded. */
                  slowClearOnce.delete(pane);
                  const held = input.get(pane) ?? "";
                  if (held) { submitted?.push({ pane, text: held }); input.set(pane, ""); }
                  screens.set(pane, slowTo.stillHolding); // first read
                  setTimeout(() => screens.set(pane, slowTo.cleared), slowTo.clearAfterMs);
                } else {
                  const held = input.get(pane) ?? "";
                  if (held) {
                    submitted?.push({ pane, text: held }); input.set(pane, "");
                    /* A conversational TUI echoes the just-submitted body into
                     * its transcript, above a now-empty box. Pin that screen so
                     * the post-enter read carries the body even though it WAS
                     * delivered. One-shot. */
                    if (echoOnce.has(pane)) {
                      echoOnce.delete(pane);
                      screens.set(pane, ["(transcript)", `you: ${held}`, "",
                        "─".repeat(60), "❯ ", "─".repeat(60), "  model · ctx 1%"].join("\n"));
                    }
                  }
                }
              }
              if (keys.includes("ctrl+c")) {
                if (turnRunning.get(pane)) turnRunning.set(pane, false); // eaten by the interrupt
                else input.set(pane, "");
              }
              wire(JSON.stringify({ id: m.id, result: {} }) + "\n");
            }
          } else if (m.method === "tab.create") {
            /* A NEW TAB, WITH THE PANE ID WHERE HERDR PUTS IT: nested under
             * `root_pane`, never at the top (herdr api schema, server 0.7.3,
             * protocol 16; see newsession.test.ts for the nine days that cost).
             *
             * The pane it names is a pane this fake does not otherwise list,
             * exactly as a real one is not an agent until claude registers on
             * it, so anything the engine then types into it lands in `rpcs`
             * and `typed()` like any other keystroke. That is what lets a test
             * ask the only question that matters here: which command a session
             * started from the app is started with. */
            madeTabs++;
            rpcs?.push({ method: m.method, pane: "", text: String(m.params?.cwd ?? "") });
            wire(JSON.stringify({ id: m.id, result: {
              type: "tab_created",
              tab: { tab_id: `tnew${madeTabs}`, workspace_id: m.params?.workspace_id ?? "w1",
                number: 90 + madeTabs, label: String(90 + madeTabs), focused: false,
                pane_count: 1, agent_status: "unknown" },
              root_pane: { pane_id: `w9:p${madeTabs}`, terminal_id: `tm${madeTabs}`,
                workspace_id: m.params?.workspace_id ?? "w1", tab_id: `tnew${madeTabs}`,
                focused: false, agent_status: "unknown", revision: 1,
                cwd: m.params?.cwd ?? null },
            } }) + "\n");
          } else if (m.method === "events.subscribe") {
            eventSock = sock;
            wire(JSON.stringify({ id: m.id, result: { ok: true } }) + "\n");
            // and then stay quiet, holding the connection open
          } else if (m.method === "pane.read") {
            /* Rendered the way claude renders it, byte for byte where it
             * matters, because that is what the engine parses.
             *
             * THE DIM SUGGESTION IS THE POINT. An empty box does not stay
             * blank: a few seconds after it empties claude paints a suggestion
             * into it in SGR 2, and herdr's default `text` format strips that
             * away, so a stripped read calls an empty box occupied. This fake
             * used to return a blank box and therefore agreed with a parser
             * that could not survive contact with a real pane.
             *
             * Measured forms, reproduced here exactly:
             *   empty + suggestion : '❯ \x1b[0m\x1b[2mnow echo goodbye\x1b[0m\r'
             *   typed 120 chars    : '❯ SHORTBODY aaa…\r'          (no SGR)
             *   typed 2000 chars   : '❯ [Pasted text #1][Pasted text #2]\r' */
            const held = input.get(pane) ?? "";
            /* A pane can also be showing a CHOOSER instead of an input box --
             * a permission or plan prompt -- and then there is no box at all
             * and enter answers the question. `screens` serves a capture the
             * test supplies, because a harness that can only render input boxes
             * agrees with any code that assumes there is always one. */
            const drawn = screens.has(pane)
              ? screens.get(pane)!
              : ["(transcript)", "", "─".repeat(60),
                 `❯ ${held
                   ? (held.length > 900 ? "[Pasted text #1][Pasted text #2]" : held)
                   : "\x1b[0m\x1b[2mnow echo goodbye\x1b[0m"}\r`,
                 "─".repeat(60), "  model · ctx 1%"].join("\n");
            /* AND IT HONOURS `format`, which is the whole reason the merged
             * reader can be tested at all.
             *
             * herdr's `pane.read` defaults to ANSI-STRIPPED text and only
             * returns escapes when asked for `format: "ansi"`; `strip_ansi`
             * strips them back out again. A fake that ignored both would answer
             * the same bytes either way, and then nothing at all asserts that
             * readPane asks for ansi -- a `strip_ansi: true` slipped back in
             * would stay green here and refuse delivery on every live pane with
             * a turn running, because the dim suggestion and a typed draft are
             * the same characters without the colour. */
            const ansi = m.params?.format === "ansi" && m.params?.strip_ansi !== true;
            const text = ansi ? drawn : drawn.replace(/\x1b\[[0-9;]*m/g, "");
            wire(JSON.stringify({ id: m.id,
              result: { type: "pane_read", read: { pane_id: pane, source: "visible", text,
                truncated: truncated.has(pane) } } }) + "\n");
          } else {
            wire(JSON.stringify({ id: m.id, result: {} }) + "\n");
          }
        }
        buf.set(sock, held);
      },
      open() {}, close(sock) { buf.delete(sock); }, error() {},
    },
  });
  return {
    stop: (closeActive?: boolean) => server.stop(closeActive),
    screens,
    truncated,
    stalled,
    slow,
    rpcs,
    /* VIEWS, not a second record. Both branches wanted the same list under
     * different names and shapes; keeping two arrays would have let one of them
     * be right about what was pressed while the other was not. */
    get keys() {
      return rpcs.filter((r) => r.method === "pane.send_keys")
        .map((r) => ({ paneId: r.pane, keys: r.keys ?? [] }));
    },
    get texts() {
      return rpcs.filter((r) => r.method === "pane.send_text")
        .map((r) => ({ paneId: r.pane, text: r.text ?? "" }));
    },
    /* THE AGENT QUITS, OR COMES BACK. herdr answers this by simply not listing
     * the pane in `session.snapshot` any more, and by firing a lifecycle event
     * so nobody waits for the slow resnapshot. `pane.exited` is the one claude
     * exiting produces; the client treats every lifecycle event as "resnapshot
     * now", which is what makes the engine's `alive` flip. */
    /* TWENTY SECONDS, not five, and it is a bound on a HANG rather than a
     * budget. This resolves as soon as the engine has come back for the agent
     * list, which is one unix-socket round trip and normally takes a
     * millisecond; the number only decides how long a wedged engine takes to
     * produce a readable message instead of a mystery. Five seconds was
     * generous alone and not generous under sixteen workers and a hundred and
     * twenty-nine files, where it failed about one full-suite run in three.
     * Nothing waits this out when things work. */
    async setAgentGone(paneId, isGone) {
      if (isGone) gone.add(paneId); else gone.delete(paneId);
      seq++;
      const before = snapshots;
      try {
        eventSock?.write(JSON.stringify({
          event: "pane.exited", data: { pane_id: paneId, state_change_seq: seq },
        }) + "\n");
      } catch { /* nobody subscribed yet */ }
      /* AWAITED ON THE ENGINE COMING BACK TO ASK, not on a sleep. Until it has
       * resnapshotted its `alive` still says what the old list said, and a test
       * that raced that would pass or fail on machine speed. */
      await until(() => snapshots !== before, { timeoutMs: 20_000,
        what: "the engine to come back for the agent list" });
    },
    async mintSession(paneId, uuid) {
      // the uuid appears on the SAME pane: null agent_session becomes a value
      noSession.delete(paneId);
      sessionIds.set(paneId, uuid);
      seq++;
      const before = snapshots;
      try {
        eventSock?.write(JSON.stringify({
          event: "pane.agent_detected", data: { pane_id: paneId, state_change_seq: seq },
        }) + "\n");
      } catch { /* nobody subscribed yet */ }
      await until(() => snapshots !== before, { timeoutMs: 20_000,
        what: "the engine to come back for the agent list" });
    },
    async rollSession(paneId, uuid) {
      // the SAME live pane reports a NEW uuid: agent_session goes uuid -> uuid
      // with the pane never leaving the snapshot (so its session stays alive).
      sessionIds.set(paneId, uuid);
      seq++;
      const before = snapshots;
      try {
        eventSock?.write(JSON.stringify({
          event: "pane.agent_detected", data: { pane_id: paneId, state_change_seq: seq },
        }) + "\n");
      } catch { /* nobody subscribed yet */ }
      await until(() => snapshots !== before, { timeoutMs: 20_000,
        what: "the engine to come back for the agent list" });
    },
    async respawnSession(paneId, uuid) {
      // a brand-new claude starts in a reused pane: bring the pane back into the
      // snapshot under a NEW uuid. The caller marks the old session dead first.
      gone.delete(paneId);
      noSession.delete(paneId);
      sessionIds.set(paneId, uuid);
      if (!panes.includes(paneId)) panes.push(paneId);
      seq++;
      const before = snapshots;
      try {
        eventSock?.write(JSON.stringify({
          event: "pane.agent_detected", data: { pane_id: paneId, state_change_seq: seq },
        }) + "\n");
      } catch { /* nobody subscribed yet */ }
      await until(() => snapshots !== before, { timeoutMs: 20_000,
        what: "the engine to come back for the agent list" });
    },
    async becomePane(fromPane, toPane) {
      // carry the claude session id onto the new pane, so the engine sees the
      // same conversation move rather than a fresh one appear
      const sid = sessionIds.get(fromPane) ?? defaultSessionIdOf(fromPane);
      sessionIds.set(toPane, sid);
      status.set(toPane, status.get(fromPane) ?? agentStatus);
      turnRunning.set(toPane, turnRunning.get(fromPane) ?? false);
      if (!panes.includes(toPane)) panes.push(toPane);
      gone.add(fromPane);
      seq++;
      const before = snapshots;
      try {
        eventSock?.write(JSON.stringify({
          event: "pane.exited", data: { pane_id: fromPane, state_change_seq: seq },
        }) + "\n");
      } catch { /* nobody subscribed yet */ }
      await until(() => snapshots !== before, { timeoutMs: 20_000,
        what: "the engine to come back for the agent list" });
    },
    setStatus(paneId, next) {
      status.set(paneId, next);
      seq++;
      try {
        eventSock?.write(JSON.stringify({
          event: "pane.agent_status_changed",
          data: { pane_id: paneId, agent_status: next, state_change_seq: seq },
        }) + "\n");
      } catch { /* nobody subscribed yet */ }
    },
  };
}
