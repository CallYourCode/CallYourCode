// herdr adapter: the engine's window into the terminal.
//
// herdr's socket speaks newline-delimited JSON: {id, method, params} out,
// {id, result|error} back, plus {event, data} lines on a subscribed
// connection. Facts probed against a live herdr (protocol 16):
//
//   - `session.snapshot` -> result.snapshot.agents[] is the full agent list.
//   - One `events.subscribe` per connection; the connection then only emits
//     events (further requests on it are ignored).
//   - `pane.agent_status_changed` subscriptions require a concrete pane_id,
//     so the event connection is rebuilt when the agent pane set changes.
//   - herdr REPLAYS a backlog of past events on every subscribe, and closing
//     a tab emits only `tab_closed` (no `pane_closed` for its panes). So
//     lifecycle events are treated purely as "resnapshot now" triggers; the
//     snapshot is the only truth, and the connection is rebuilt only when
//     the snapshot shows a different agent pane set (never in response to
//     an event alone, or replays would reconnect forever).
//   - Event names arrive both dotted and underscored ("pane_created",
//     "pane.agent_status_changed"); normalize before matching.
//   - `pane.send_text` types but does not submit; `pane.send_keys ["enter"]`
//     submits; `["ctrl+c"]` interrupts a running turn.

import { basename, join } from "node:path";
import { homedir } from "node:os";
import { classifyPaneBox, refusesDelivery, SGR, type BoxVerdict, type PaneBox } from "./blocked.ts";
import { ANNOUNCED_SOURCE, normalizeAgentId, type AgentSessionRef } from "../runtime/agents.ts";
import { hookBindFor, markParked, onHookAnnounce, pendingAnnounces, pruneHookBinds, takePending } from "./hook-announce.ts";
import { stillAwaitingSubmit } from "./tmux.ts";
import type { AgentStatus, MuxAgent, Multiplexer } from "./mux.ts";

// AgentStatus and the agent shape now live on the multiplexer seam (mux.ts), so
// herdr and tmux agree on them. Re-exported and aliased here so herdr.ts's own
// code, and everything that imported these from herdr.ts, reads unchanged.
export type { AgentStatus };
export type HerdrAgent = MuxAgent;
// Screen-parse cluster moved to blocked.ts (S1); re-exported so every existing
// import from herdr.ts reads unchanged.
export { classifyPaneBox, refusesDelivery, SGR };
export type { BoxVerdict, PaneBox };

/* The spawn-hardening budgets (newTab below). Prompt wait capped at 5s like
 * the tmux path; up to three type attempts verified ~150ms after typing; up
 * to three Enter re-sends ~500ms apart. */
const SPAWN_PROMPT_CAP_MS = 5_000;
const SPAWN_TYPE_TRIES = 3;
const SPAWN_VERIFY_MS = 150;
const SPAWN_POLL_MS = 500;
const SPAWN_RESEND_TRIES = 3;
const SPAWN_READ_LINES = 60;

/** True when the whole launch command is sitting typed on the screen. The
 *  command wraps at the pane width, so the check flattens the capture (ANSI
 *  stripped, line breaks removed) and asks for CONTAINMENT of the full
 *  command string. This is the check a tail match cannot do: the live
 *  2026-09-22 failure ate only the FIRST character (`env` -> `nv ...`), so
 *  the tail was intact while the command was ruined. Pure; exported for the
 *  unit test, which uses that exact capture. */
export function commandTypedIntact(capture: string, command: string): boolean {
  // whitespace-insensitive on both sides: a wrap point can fall on a space of
  // the command and the terminal may pad or trim around it, so spacing is not
  // evidence; every other byte of the command must be present, in order.
  const flat = capture.replace(SGR, "").replace(/\s+/g, "");
  return flat.includes(command.replace(/\s+/g, ""));
}

type SnapshotAgent = {
  pane_id: string;
  agent?: string | null;
  agent_status: AgentStatus;
  cwd?: string | null;
  /* herdr's per-pane session handle. `value` is the opaque id (claude uuid,
   * codex thread id, opencode session id); `kind`/`source`/`agent` were added
   * when herdr grew per-agent integrations and are absent on an older herdr, so
   * they are optional and default sensibly (kind "id", agent = the pane agent). */
  agent_session?: { value: string; kind?: string | null; source?: string | null; agent?: string | null } | null;
  workspace_id?: string | null;
  tab_id?: string | null;
  display_agent?: string | null;
  state_change_seq?: number | null;
};

type SnapshotWorkspace = {
  workspace_id: string;
  number: number;
  label?: string | null;
  tab_count?: number | null;
};

type SnapshotTab = {
  tab_id: string;
  workspace_id: string;
  number: number;
  label?: string | null;
};

/* HOW LONG ONE herdr RPC MAY TAKE BEFORE IT IS A FAILURE.
 *
 * Read on every call rather than captured at import, and that is the whole of
 * the difference: production sets nothing and gets 5000, exactly as it always
 * did, while a seam test that needs a WEDGED pane -- one that takes the request
 * and never answers -- can shorten the round trip at file scope. Frozen at
 * import it could not, because the module is evaluated by the test file's own
 * import statement, before a single line of the file runs.
 *
 * Five seconds is the shipped number and it is a measurement, not a guess: a
 * pane that has not answered in five is a pane something is wrong with. Nothing
 * in production writes this variable. */
const rpcTimeoutMs = (): number => Number(process.env.HERDR_RPC_TIMEOUT_MS) || 5000;
const RETRY_MIN_MS = 1000;
const RETRY_MAX_MS = 15000;
// Metadata stamps (display_agent, e.g. teleport's turn timer) emit NO event
// on herdr <= 0.7.4, and even 0.7.5's pane.updated cannot cover TTL expiry.
// A slow resnapshot poll keeps those fresh; everything else is event-driven.
const POLL_MS = 15000;

// Events whose only meaning to us is "the agent pane set (or its labels or
// metadata) may have changed". pane_focused is here because focusing a pane
// in the terminal is what flips herdr's done (finished, unseen) to idle
// (seen); pane_updated (herdr >= 0.7.5) fires on metadata stamps.
const LIFECYCLE_EVENTS = new Set([
  "pane_created",
  "pane_closed",
  "pane_exited",
  "pane_agent_detected",
  "pane_focused",
  "pane_updated",
  "tab_closed",
  "tab_renamed",
  "workspace_closed",
  "workspace_renamed",
]);

function socketPath(): string {
  return process.env.HERDR_SOCKET_PATH ?? join(homedir(), ".config", "herdr", "herdr.sock");
}

/* THE SOCKET TAKES WHAT IT TAKES, AND SAYS SO IN THE RETURN VALUE.
 *
 * `sock.write(frame)` was called once and its answer thrown away. A unix
 * socket accepts what fits in its send buffer and returns that count; here
 * that is 8192 bytes. Measured: a 62,076-byte frame returned 8192 and the
 * other 53,884 bytes were never sent. herdr then waits for the rest of a line
 * that is not coming, the RPC times out, and the message is dropped.
 *
 * That is not an exotic size. Around 8,000 characters of ordinary pasted text
 * fails; 6,000 passes. It has been failing that way for as long as this
 * function has existed -- a message carrying several attachments simply made
 * an everyday composition able to reach it.
 *
 * So the frame is written until it is gone: what the socket refuses is kept
 * and written again from `drain`, which is Bun telling us the buffer has room.
 * The RPC timeout still bounds the whole thing, so a socket that never drains
 * fails the way it always did rather than hanging.
 */
function writeAll(sock: import("bun").Socket, rest: Uint8Array): Uint8Array {
  while (rest.length) {
    const n = sock.write(rest);
    // 0 means "full, try again on drain"; anything negative is a closed socket
    // and the close/error handler is what answers for that.
    if (n <= 0) return rest;
    rest = rest.subarray(n);
  }
  return rest;
}

/** One request, one response, over a fresh connection. */
async function rpc(method: string, params: unknown, sock?: string): Promise<any> {
  return new Promise((resolve, reject) => {
    let buf = "";
    let settled = false;
    let conn: import("bun").Socket | null = null;
    let pending = new TextEncoder().encode(JSON.stringify({ id: "1", method, params }) + "\n");
    const done = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };
    const timer = setTimeout(
      () =>
        done(() => {
          try {
            conn?.end(); // a timed-out connection must not linger open
          } catch {}
          reject(new Error(`herdr rpc ${method}: timeout`));
        }),
      rpcTimeoutMs(),
    );
    Bun.connect({
      unix: sock ?? socketPath(),
      socket: {
        open(sock) {
          conn = sock;
          pending = writeAll(sock, pending);
        },
        drain(sock) {
          pending = writeAll(sock, pending);
        },
        data(sock, chunk) {
          buf += chunk.toString();
          const i = buf.indexOf("\n");
          if (i < 0) return;
          try {
            const m = JSON.parse(buf.slice(0, i));
            if (m.error) {
              done(() => reject(new Error(`herdr ${method}: ${m.error.code}: ${m.error.message}`)));
            } else {
              done(() => resolve(m.result));
            }
          } catch (e) {
            done(() => reject(e as Error));
          }
          sock.end();
        },
        error(_sock, e) {
          done(() => reject(e));
        },
        close() {
          done(() => reject(new Error(`herdr rpc ${method}: connection closed`)));
        },
      },
    }).catch((e) => done(() => reject(e)));
  });
}

export class HerdrClient implements Multiplexer {
  /* WHICH herdr THIS CLIENT TALKS TO, injected rather than read from the
   * environment. Production passes nothing and socketPath() answers, exactly as
   * before. A test hands it the path of a FakeHerdr it started in its own tmp
   * directory, so two tests in one process can each drive their own herdr and
   * neither has to mutate HERDR_SOCKET_PATH out from under the other. */
  private readonly sock: string | undefined;
  constructor(sockPath?: string) {
    this.sock = sockPath?.trim() || undefined;
  }

  private agents = new Map<string, SnapshotAgent>();
  private workspaces = new Map<string, SnapshotWorkspace>();
  private tabs = new Map<string, SnapshotTab>();
  private listeners: Array<(agents: HerdrAgent[]) => void> = [];
  private eventSock: import("bun").Socket | null = null;
  private stopped = false;
  private retryMs = RETRY_MIN_MS;
  private generation = 0; // invalidates stale event connections
  private refreshing = false;
  private refreshQueued = false;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  /** the unregister for this client's hook-announce poke (see start/stop) */
  private offHookAnnounce: (() => void) | null = null;
  // herdr 0.7.4 rejects the pane.updated subscription ("unknown variant");
  // detected on the first subscribe failure, then left out of the next ones
  private paneUpdatedSupported = true;

  /** cb fires with the full agent list on snapshot and on every change. */
  onAgents(cb: (agents: HerdrAgent[]) => void): void {
    this.listeners.push(cb);
    if (this.agents.size) cb(this.list());
  }

  async sendText(paneId: string, text: string): Promise<void> {
    await rpc("pane.send_text", { pane_id: paneId, text }, this.sock);
  }

  /** keys like "enter", "ctrl+c". */
  async sendKeys(paneId: string, ...keys: string[]): Promise<void> {
    await rpc("pane.send_keys", { pane_id: paneId, keys }, this.sock);
  }

  /* What is on the pane's screen right now, newest at the bottom. ONE reader,
   * for every caller, and it hands back ANSI.
   *
   * `source` takes one of visible | recent | recent_unwrapped | detection
   * (herdr rejects anything else and names the four in the error). `visible`
   * is the rendered viewport, which is what a person looking at the pane would
   * see, and it is also what a dialog IS: a modal drawn over the bottom of the
   * viewport. `recent` would drag the whole turn in with it and a question from
   * three tools ago would still be sitting in the text long after it was
   * answered. Probed against a live herdr: result.read.text, "\n"-joined,
   * NESTED -- reading result.text gets an empty string and a parser that
   * quietly finds nothing on every screen.
   *
   * `format` takes `text` or `ansi` and DEFAULTS TO STRIPPED TEXT. This asks
   * for `ansi` and never for `strip_ansi`, because ANSI IS THE SUPERSET:
   * colour can be thrown away by a caller that only wants words
   * (`parseAsk(text.replace(SGR, ""))`), and it cannot be recovered by one that
   * needs it. classifyPaneBox needs it -- a DIM prompt marker is the only
   * evidence that an input box is empty rather than holding a draft -- so a
   * `strip_ansi: true` here is one caller destroying the byte another depends
   * on. There were briefly two readPanes disagreeing about exactly that.
   *
   * `truncated` is herdr saying it did not give you the whole thing, and it is
   * returned rather than dropped: a partial screen is not a screen anything
   * should classify from. Half a choice list still parses.
   *
   * NO DEFAULT FOR `lines`, deliberately. The two readers this replaces
   * defaulted to 30 and 60; both call sites already pass a number, and a
   * default is how that drift restarts. */
  async readPane(paneId: string, lines: number): Promise<{ text: string; truncated: boolean }> {
    const res = await rpc("pane.read",
      { pane_id: paneId, source: "visible", lines, format: "ansi" }, this.sock);
    const text = res?.read?.text;
    return {
      text: typeof text === "string" ? text : "",
      truncated: res?.read?.truncated === true,
    };
  }

  /** Rename the pane itself, so the new name shows in herdr's own panel too. */
  async renamePane(paneId: string, label: string): Promise<void> {
    await rpc("pane.rename", { pane_id: paneId, label }, this.sock);
  }

  /** Close the pane. The agent list stops listing it, and the session goes
   * dead here on the next snapshot. */
  async closePane(paneId: string): Promise<void> {
    await rpc("pane.close", { pane_id: paneId }, this.sock);
  }

  /** Which workspace a pane belongs to, so a new tab can be opened beside it. */
  workspaceOf(paneId: string): string | null {
    return this.agents.get(paneId)?.workspace_id ?? null;
  }

  /** Every directory that already has an agent, newest workspace order first.
   * These are the only places worth offering as "start one here": somewhere
   * you already work, rather than a path to be typed on a phone. */
  knownCwds(): string[] {
    const out: string[] = [];
    for (const a of this.list()) {
      if (a.cwd && !out.includes(a.cwd)) out.push(a.cwd);
    }
    return out;
  }

  /* New tab in a workspace, running a command. Returns the new pane id.
   *
   * THE ID IS NESTED, exactly as pane.read's text is, and for nine days this
   * read it off the top:
   *
   *     res.pane_id ?? res.panes?.[0]?.pane_id
   *
   * herdr puts neither there. Its own schema (`herdr api schema`, server 0.7.3,
   * protocol 16) says tab.create answers
   *
   *     { type: "tab_created", tab: TabInfo, root_pane: PaneInfo }
   *
   * and PaneInfo is what carries `pane_id`. Both guesses were undefined, so
   * every /new-session threw here and answered 502, and the app said "Could not
   * start it" with nothing behind it. The 2026-08-05 report: a new session in
   * the home directory just failed -- and it had never once worked, in 66
   * engine lifetimes of the log. */
  async newTab(opts: { workspaceId?: string | null; cwd: string; label?: string; command: string }): Promise<string> {
    const res = (await rpc("tab.create", {
      ...(opts.workspaceId ? { workspace_id: opts.workspaceId } : {}),
      cwd: opts.cwd,
      ...(opts.label ? { label: opts.label } : {}),
      focus: false,
    }, this.sock)) as { root_pane?: { pane_id?: string } };
    const paneId = res?.root_pane?.pane_id;
    if (!paneId) throw new Error("tab.create returned no pane");
    /* THE SAME HARDENING THE TMUX PATH GOT (165743c), because the same seam
     * broke here live (2026-09-22, MusicBrowser reopen on k8plus): the blind
     * 400ms sleep typed the launch while an oh-my-zsh "update? [Y/n]" prompt
     * was consuming stdin, the first character was eaten (`env` -> `nv`,
     * command not found) and claude never started. Three steps:
     *   1. wait for the prompt to be painted before typing (awaitPrompt);
     *   2. VERIFY THE TYPED LINE by whole-command containment (a head-mangled
     *      command leaves the tail intact, so a tail check cannot catch it);
     *      a mangled line is ABANDONED WITH CTRL+C, not ctrl+u, and retyped
     *      after a fresh prompt. ctrl+c is load-bearing: ctrl+u clears only to
     *      the start of the CURRENT line, so a long command that already
     *      wrapped keeps its earlier lines and the retype concatenates onto
     *      them (proven live the same night: a long pi launch became
     *      `...cyc-output.jsenv CYC_...`). ctrl+c abandons the whole multi-line
     *      input, so the retype always starts clean;
     *   3. confirm the Enter actually submitted (the tmux dropped-Enter
     *      rescue), resending while the launch still sits typed on the line
     *      and no agent has come up on the pane. */
    await this.awaitPrompt(paneId);
    for (let attempt = 0; attempt < SPAWN_TYPE_TRIES; attempt++) {
      await this.sendText(paneId, opts.command);
      await new Promise((r) => setTimeout(r, SPAWN_VERIFY_MS));
      const { text } = await this.readPane(paneId, SPAWN_READ_LINES).catch(() => ({ text: "" as string }));
      if (commandTypedIntact(text, opts.command)) break;
      if (attempt === SPAWN_TYPE_TRIES - 1) break; // out of budget: submit what is there
      await this.sendKeys(paneId, "ctrl+c");        // abandon the WHOLE input, wrapped lines and all
      await this.awaitPrompt(paneId);               // wait for the fresh prompt before retyping
    }
    await this.sendKeys(paneId, "enter");
    await this.confirmSubmitted(paneId, opts.command);
    return paneId;
  }

  /** Poll the pane until any non-whitespace output is painted (the shell's
   *  prompt), capped, so keys cannot land before the shell reads them. The
   *  tmux path's awaitPrompt, on herdr's reader. */
  private async awaitPrompt(paneId: string): Promise<void> {
    const deadline = Date.now() + SPAWN_PROMPT_CAP_MS;
    for (;;) {
      const { text } = await this.readPane(paneId, SPAWN_READ_LINES).catch(() => ({ text: "" as string }));
      if (text.replace(SGR, "").trim().length > 0) return;
      if (Date.now() >= deadline) return;
      await new Promise((r) => setTimeout(r, 50));
    }
  }

  /** The dropped-Enter rescue, herdr edition. Bounded; stops the instant an
   *  agent is detected on the pane (never a stray Enter into a running agent)
   *  or the launch left the input line. */
  private async confirmSubmitted(paneId: string, command: string): Promise<void> {
    for (let attempt = 0; attempt < SPAWN_RESEND_TRIES; attempt++) {
      await new Promise((r) => setTimeout(r, SPAWN_POLL_MS));
      if (this.agents.get(paneId)?.agent) return; // the agent painted: submitted
      const { text } = await this.readPane(paneId, SPAWN_READ_LINES).catch(() => ({ text: "" as string }));
      if (!text) continue; // a failed read says nothing; try again
      // "zsh" stands in for the foreground shell: herdr has no comm field, and
      // the agent check above already covered the running-agent case.
      if (!stillAwaitingSubmit("zsh", text.replace(SGR, ""), command)) return;
      await this.sendKeys(paneId, "enter");
    }
  }

  /** Connect, snapshot, subscribe. Retries forever until stop(). */
  start(): void {
    this.stopped = false;
    // a fresh hook announce resnapshots at once, so the announced bind lands
    // without waiting for the next lifecycle event or slow poll
    this.offHookAnnounce ??= onHookAnnounce(() => void this.announcePoke());
    void this.runLoop();
    this.pollTimer = setInterval(() => void this.pollRefresh(), POLL_MS);
  }

  stop(): void {
    this.stopped = true;
    this.generation++;
    this.eventSock?.end();
    this.eventSock = null;
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    this.offHookAnnounce?.();
    this.offHookAnnounce = null;
  }

  /** One serialized resnapshot+emit, triggered by a hook announce. Any failure
   *  is left to the normal loop: the parked announce is drained by whichever
   *  snapshot next succeeds. */
  private async announcePoke(): Promise<void> {
    if (this.stopped || this.refreshing) return;
    this.refreshing = true;
    try {
      await this.snapshot();
      this.emit();
    } catch {
      // connection down: the run loop's retry will snapshot and drain
    } finally {
      this.refreshing = false;
    }
  }

  // ------------------------------------------------------------- internals

  /**
   * Agents in herdr's "spaces" panel order: workspace order, then tab order,
   * then pane order (the snapshot's own array order within a tab).
   */
  list(): HerdrAgent[] {
    const all = [...this.agents.values()].sort((x, y) => {
      const wx = this.workspaces.get(x.workspace_id ?? "")?.number ?? 1e9;
      const wy = this.workspaces.get(y.workspace_id ?? "")?.number ?? 1e9;
      if (wx !== wy) return wx - wy;
      const tx = this.tabs.get(x.tab_id ?? "")?.number ?? 1e9;
      const ty = this.tabs.get(y.tab_id ?? "")?.number ?? 1e9;
      return tx - ty; // sort is stable: snapshot order breaks the tie
    });
    const byName = new Map<string, number>();
    for (const a of all) {
      const base = a.cwd ? basename(a.cwd) : a.pane_id;
      byName.set(base, (byName.get(base) ?? 0) + 1);
    }
    return all.map((a) => {
      const base = a.cwd ? basename(a.cwd) : a.pane_id;
      const ws = this.workspaces.get(a.workspace_id ?? "");
      const tab = this.tabs.get(a.tab_id ?? "");
      const tabLabel = tab ? (tab.label || String(tab.number)) : null;
      // the TUI hides the tab when the workspace has only that one tab and it
      // was never manually named; is_auto_named is not on the socket, so
      // approximate: auto-named tabs wear their own number as the label
      const tabHidden = ws?.tab_count === 1 && tab !== undefined && tabLabel === String(tab.number);
      // The pane's agent, normalized once here (herdr:opencode -> opencode, etc).
      const agent = normalizeAgentId(a.agent ?? "");
      // Whatever session handle herdr reported for the pane, for ANY agent. kind
      // defaults to "id" (the only shape an older herdr sent); source names who
      // filled it so the log can tell a codex thread id from a claude uuid.
      /* THE EVIDENCE HIERARCHY: an ANNOUNCED bind -- the harness
       * itself said "session Y, pid N" through the hook (claude), the notify
       * (codex), the plugin (opencode) or the pi socket, resolved to this pane
       * by its HERDR_PANE_ID -- overrides herdr's own newest-jsonl guess
       * immediately, for EVERY harness (the documented evidence order). herdr's
       * value stays the fallback for panes that have never announced (an agent
       * with no announce mechanism, or an announce-delivery failure). */
      const announced = hookBindFor(a.pane_id);
      const agentSession: AgentSessionRef | null = announced
        ? { id: announced.sessionId, kind: "id", source: ANNOUNCED_SOURCE, ...(announced.link ? { link: announced.link } : {}) }
        : a.agent_session?.value
        ? {
            id: a.agent_session.value,
            kind: a.agent_session.kind === "path" ? "path" : "id",
            source: a.agent_session.source ?? `herdr:${agent}`,
          }
        : null;
      return {
        paneId: a.pane_id,
        name: (byName.get(base) ?? 0) > 1 ? `${base} (${a.pane_id})` : base,
        cwd: a.cwd ?? "",
        status: a.agent_status ?? "unknown",
        agent,
        agentSession,
        workspace: ws ? (ws.label || String(ws.number)) : (a.workspace_id ?? ""),
        tab: tabHidden ? null : tabLabel,
        displayAgent: a.display_agent ?? null,
        stateChangeSeq: a.state_change_seq ?? 0,
      };
    });
  }

  private emit(): void {
    const snapshot = this.list();
    for (const cb of this.listeners) {
      try {
        cb(snapshot);
      } catch (e) {
        console.error("[herdr] onAgents listener threw:", e);
      }
    }
  }

  private async snapshot(): Promise<void> {
    const result = await rpc("session.snapshot", {}, this.sock);
    const snap = result?.snapshot ?? {};
    // WHICH PANES ARE SESSIONS AT ALL: every pane the mux stamped with an agent,
    // whatever the agent (invariant L1). The literal "claude" used to be written
    // here, then HARNESS.id -- one id, so every codex/opencode pane was invisible
    // by construction, which is exactly what he reported. A pane with no agent
    // stamp is not a session and is still dropped; that semantics is unchanged.
    // The per-pane `agent` is carried onto the MuxAgent (list) so each row is
    // tagged with its own agent and named honestly.
    const rawPanes: SnapshotAgent[] = (snap.agents ?? []) as SnapshotAgent[];
    const agents: SnapshotAgent[] = rawPanes.filter(
      (a: SnapshotAgent) => a.agent != null && String(a.agent).trim() !== "",
    );
    this.agents = new Map(agents.map((a) => [a.pane_id, a]));
    /* EVERY pane herdr reports, stamped or not. `this.agents` above is the
     * STAMPED subset -- the panes that are sessions in their own right. The
     * witness match below needs the wider view: a pane herdr has SEEN but not
     * yet classified (agent_status "unknown", no `agent` field) is a real pane
     * an announce can legitimately witness, and gating the bind on herdr having
     * classified it is exactly the intermittent-capture bug (a node-launched pi
     * herdr is slow to stamp never bound). Keyed the same way, so a witness
     * lookup and a bind-prune both see the pane the instant it exists. */
    const allPanes = new Map<string, SnapshotAgent>(
      rawPanes.map((a) => [a.pane_id, a]),
    );
    this.workspaces = new Map(
      ((snap.workspaces ?? []) as SnapshotWorkspace[]).map((w) => [w.workspace_id, w]),
    );
    this.tabs = new Map(((snap.tabs ?? []) as SnapshotTab[]).map((t) => [t.tab_id, t]));
    /* THE ANNOUNCE RESOLUTION, herdr lane. herdr reports no pane pids, so pid
     * mapping cannot apply here and this lane's OWN witness carries: the
     * announcing claude's HERDR_PANE_ID, which names one pane for the
     * daemon's whole life. Only herdrPane is read; tmuxPane is the other
     * lane's witness and a foreign or absent witness never blocks, it just
     * parks with a logged reason. Parked announces whose pane is in this
     * snapshot bind now; binds whose agent pane left the snapshot are pruned
     * (a fresh claude in the same herdr pane must not inherit the exited
     * one's announced uuid). Scoped away from tmux's composite
     * `%N~pid~epoch` handles. */
    for (const p of [...pendingAnnounces()]) {
      const a = p.herdrPane ? allPanes.get(p.herdrPane) : undefined;
      const stamp = a ? normalizeAgentId(a.agent ?? "") : "";
      const declared = p.harness ? normalizeAgentId(p.harness) : "";
      /* THE herdrPane WITNESS IS THE IDENTITY. The announcing harness read its
       * own HERDR_PANE_ID out of its own env and told us the exact pane it runs
       * in, so a witness pane that EXISTS in the snapshot is unambiguous. The
       * pane's agent stamp is ONLY an anti-theft cross-check against a STALE
       * HERDR_PANE_ID that resolved to a pane now owned by a DIFFERENT harness
       * (E5b: binding it would put one harness's id on another's pane).
       *
       * So reject ONLY a POSITIVE cross-harness mismatch: the announce declares
       * a harness AND the pane carries a RESOLVED stamp AND the two are
       * different known harnesses. An EMPTY/unresolved stamp is NOT a mismatch
       * -- herdr has simply not classified the pane yet, which is the common,
       * lasting case for a node-launched pi -- so bind on the witness. This
       * makes capture independent of herdr's classification: pi (and any
       * harness herdr is slow to stamp) binds the first tick its announce is
       * seen and its witness pane is present. A harness-less announce (the
       * claude hook, the codex notify) still binds on the witness alone. */
      const harnessMismatch = declared !== "" && stamp !== "" && declared !== stamp;
      if (a && !harnessMismatch) takePending(p, p.herdrPane!, "witness");
      else markParked(p, p.herdrPane ? (a ? "harness mismatch" : "unknown witness") : "ttl-wait");
    }
    /* Prune against EVERY pane herdr still reports, stamped or not: an announced
     * pi pane herdr has not classified is still a live pane, and its bind must
     * survive until the pane actually leaves the snapshot (a fresh harness in
     * the same herdr pane must still not inherit the exited one's uuid). */
    pruneHookBinds(new Set(allPanes.keys()), (h) => !h.includes("~"));
  }

  /**
   * Slow-cadence resnapshot: catches display_agent stamps and TTL expiries,
   * which have no event on herdr <= 0.7.4. Runs in place through the same
   * serialization flag as refresh(); if the agent pane SET changed, the event
   * connection is ended so the run loop resubscribes with the right panes.
   */
  private async pollRefresh(): Promise<void> {
    if (this.stopped || this.refreshing || !this.eventSock) return;
    this.refreshing = true;
    try {
      const gen = this.generation;
      const before = this.agents;
      await this.snapshot();
      if (gen !== this.generation) return;
      this.emit();
      const setChanged =
        before.size !== this.agents.size || [...this.agents.keys()].some((id) => !before.has(id));
      if (setChanged) this.eventSock?.end();
    } catch (e) {
      console.error("[herdr] poll refresh:", e);
    } finally {
      this.refreshing = false;
    }
  }

  private async runLoop(): Promise<void> {
    while (!this.stopped) {
      const gen = ++this.generation;
      try {
        await this.snapshot();
        this.emit();
        this.retryMs = RETRY_MIN_MS;
        await this.watch(gen); // resolves when the event connection ends
      } catch (e) {
        if (this.stopped) return;
        console.error(`[herdr] ${String(e)}; retrying in ${this.retryMs}ms`);
        await Bun.sleep(this.retryMs);
        this.retryMs = Math.min(this.retryMs * 2, RETRY_MAX_MS);
      }
    }
  }

  /**
   * One event connection: pane/tab/workspace lifecycle plus per-pane agent
   * status for every currently known agent pane. Resolves (so the run loop
   * resnapshots and resubscribes) when the connection drops or a refresh
   * finds the agent pane set changed.
   */
  private watch(gen: number): Promise<void> {
    const subscriptions: unknown[] = [
      { type: "pane.created" },
      { type: "pane.closed" },
      { type: "pane.exited" },
      { type: "pane.agent_detected" },
      { type: "pane.focused" }, // seen-flag flips: done -> idle on focus
      { type: "tab.closed" },
      { type: "tab.renamed" },
      { type: "workspace.closed" },
      { type: "workspace.renamed" },
      // metadata changes (display_agent stamps); herdr >= 0.7.5 only, 0.7.4
      // rejects it -- detected below and dropped from the retry
      ...(this.paneUpdatedSupported ? [{ type: "pane.updated" }] : []),
      ...[...this.agents.keys()].map((paneId) => ({
        type: "pane.agent_status_changed",
        pane_id: paneId,
      })),
    ];

    return new Promise((resolve, reject) => {
      let buf = "";
      let settled = false;
      /* Same partial-write rule as rpc(). This frame is one line per agent
       * pane, so it is nowhere near the 8 KB the send buffer takes -- but it
       * is the same call with the same silent truncation waiting in it, and
       * one of the two spellings being right is how the other one survives. */
      let pending = new TextEncoder().encode(
        JSON.stringify({ id: "sub", method: "events.subscribe", params: { subscriptions } }) + "\n",
      );
      const finish = (err?: Error) => {
        if (settled) return;
        settled = true;
        err ? reject(err) : resolve();
      };

      Bun.connect({
        unix: this.sock ?? socketPath(),
        socket: {
          open: (sock) => {
            this.eventSock = sock;
            pending = writeAll(sock, pending);
          },
          drain: (sock) => {
            pending = writeAll(sock, pending);
          },
          data: (sock, chunk) => {
            buf += chunk.toString();
            let i;
            while ((i = buf.indexOf("\n")) >= 0) {
              const line = buf.slice(0, i);
              buf = buf.slice(i + 1);
              if (gen !== this.generation) {
                finish(); // before end(): close fires re-entrantly and would reject
                sock.end();
                return;
              }
              try {
                this.onLine(JSON.parse(line), gen, sock, finish);
              } catch {
                // unparseable line; ignore
              }
            }
          },
          error: (_sock, e) => finish(e),
          close: () => finish(this.stopped ? undefined : new Error("event connection closed")),
        },
      }).catch((e) => finish(e as Error));
    });
  }

  private onLine(
    m: { id?: string; error?: { message: string }; event?: string; data?: Record<string, any> },
    gen: number,
    sock: import("bun").Socket,
    finish: (err?: Error) => void,
  ): void {
    if (m.error) {
      // Any error line here kills the subscription. Unparseable subscriptions
      // come back with an EMPTY id (herdr fails before reading it), so match
      // on the error itself, not the id. herdr 0.7.4 rejects pane.updated
      // ("unknown variant"): remember, and resubscribe without it (the run
      // loop retries); the poll covers metadata changes instead.
      if (this.paneUpdatedSupported && /pane\.updated/.test(m.error.message ?? "")) {
        this.paneUpdatedSupported = false;
        console.log("[herdr] pane.updated unsupported (herdr <= 0.7.4); polling for metadata");
      }
      finish(new Error(`subscribe failed: ${m.error.message}`));
      return;
    }
    if (m.id === "sub") return; // {"result":{"type":"subscription_started"}}
    if (!m.event || !m.data) return;

    const kind = m.event.replace(/\./g, "_");

    if (kind === "pane_agent_status_changed") {
      const a = this.agents.get(String(m.data.pane_id));
      if (a) {
        a.agent_status = m.data.agent_status as AgentStatus;
        if (typeof m.data.state_change_seq === "number") a.state_change_seq = m.data.state_change_seq;
        this.emit();
      }
      return;
    }

    if (LIFECYCLE_EVENTS.has(kind)) void this.refresh(gen, sock, finish);
  }

  /**
   * Resnapshot in place (serialized; a burst of lifecycle events coalesces
   * into at most one queued rerun) and emit. Only if the agent pane SET
   * changed does the event connection get rebuilt, because only then do the
   * per-pane status subscriptions need to change.
   */
  private async refresh(
    gen: number,
    sock: import("bun").Socket,
    finish: (err?: Error) => void,
  ): Promise<void> {
    if (this.refreshing) {
      this.refreshQueued = true;
      return;
    }
    this.refreshing = true;
    try {
      const before = this.agents;
      await this.snapshot();
      if (gen !== this.generation) return;
      this.emit();
      const setChanged =
        before.size !== this.agents.size || [...this.agents.keys()].some((id) => !before.has(id));
      if (setChanged) {
        this.refreshQueued = false;
        finish(); // before end(): close fires re-entrantly and would reject
        sock.end();
        return;
      }
    } catch (e) {
      if (gen !== this.generation) return;
      finish(e as Error);
      sock.end();
      return;
    } finally {
      this.refreshing = false;
    }
    if (this.refreshQueued) {
      this.refreshQueued = false;
      void this.refresh(gen, sock, finish);
    }
  }
}
