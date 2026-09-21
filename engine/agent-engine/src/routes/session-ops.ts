/* ROUTES: rename/settings/unread/order, agent-message, new-session, exit, restart (L4 interface; blueprint 4b row 29).
 * Extracted verbatim from server.ts routeRequest; each handler answers a
 * Response or null (not mine). The auth gates stay per-route
 * (requireOwner/requireLocal), exactly as the if-chain had them. */

import type { RoutesCtx } from "./ctx.ts";
import { PaneNotReady, type MultiplexerAdapter } from "../adapters/mux-adapter.ts";
import { AGENT_ID_RE, isHarnessSessionId } from "../runtime/ids.ts";
import { agentMetaFile } from "../storage/datadir.ts";
import { stat } from "node:fs/promises";
import { JSON_BODY_MAX_BYTES, readJsonCapped } from "../storage/body-limits.ts";
import { logChat, stampTs } from "../chat/chatlog.ts";
import { type ChatMsg } from "../chat/chatmsg.ts";
import { claudeTitleOf } from "../sessions/context-cache.ts";
import { deliverToAgent } from "../chat/deliver.ts";
import { json, requireLocal, requireOwner } from "../transport/httpx.ts";
import { nextOrder } from "../chat/order.ts";
import { restartPane } from "../chat/pane-deliver.ts";
import { markAllRead, markUnread, unreadOf } from "../sessions/readstate.ts";
import { restartConfirmed, restartLogsToChat, restartTell } from "../terminal/restart.ts";
import { adoptAgentId, agentMetas, applySessionSettings, freshAgentId, getManualOrder, isRecentCwd, nameOverrideOf, recentCwds, sessions, setManualOrder, setNameOverride, settingsOf, type Session, type SessionSettings } from "../sessions/session-state.ts";
import { withAgentEnv } from "../runtime/agent-env.ts";
import { programToken } from "../adapters/pi-launch.ts";
import { broadcastSessions, sessionList } from "../sessions/sessions-frame.ts";
import { titleOf } from "../sessions/title.ts";
import { broadcast } from "../transport/wire.ts";

/* THE RESTART PRE-FLIGHT, factored out of the /restart route as a pure function
 * so the mode/sid/command decision is unit-testable without restartPane's
 * quit-watch or a live pane. Given a session, the requested mode and the mux
 * adapter's launch capability, it returns either the exact command to type (and
 * the id it resumes to) or the refusal (status + sentence) the route returns
 * verbatim. */
export type RestartPreflight =
  | { ok: false; status: number; error: string }
  | { ok: true; cmd: string; sid: string | null };

export function restartPreflight(
  s: Pick<Session, "agent" | "agentId" | "harnessSessionId">,
  mode: "fresh" | "resume",
  adapter: Pick<MultiplexerAdapter, "launchCommand" | "resumeCommand">,
): RestartPreflight {
  /* THE ID TO RESUME TO is this harness's own, whatever the harness. carry.ts
   * and reconcile.ts set harnessSessionId for every agent (claude, codex,
   * opencode, pi), so this ONE field is the resume id for all of them (contract
   * stage 3 retired the claude-only second field; it could never hold a value
   * this one did not). */
  const sid = s.harnessSessionId;
  if (mode === "resume" && !sid) {
    return { ok: false, status: 400,
      error: "this engine has never seen a session id for that pane, so there is " +
        "nothing to resume. Restart it fresh." };
  }
  /* The id goes on a command line, and it comes from another process (a
   * harness's hook, its notify, its plugin, or the pi socket). It is a harness
   * session id (a uuid for claude/codex/pi, a ses_ id for opencode), held to
   * the ONE grammar in ids.ts before it touches a command line; neither grammar
   * admits a shell metacharacter, so a pane id or a label can never reach the
   * shell as one. */
  if (sid && mode === "resume" && !isHarnessSessionId(sid)) {
    return { ok: false, status: 400, error: "that pane's session id is not a plain id" };
  }
  /* Both the fresh command and the resume form come from this agent's reader
   * launch capability (adapters/), so the one description of how to start it
   * lives there. The route refuses a reader with no launch command by name up
   * front; this belt returns the same 409 so the pure decision is complete. */
  const base = mode === "resume"
    ? adapter.resumeCommand(s.agent.id, sid!)
    : adapter.launchCommand(s.agent.id);
  if (!base) {
    return { ok: false, status: 409, error: `restart is not supported for ${s.agent.name} yet` };
  }
  /* Prefix the launch/resume command with this session's EXISTING stable id
   * (cyc-cli plan section 3): a restart re-types the start command, so it is the
   * one moment a hand-started pane that never had CYC_AGENT_ID gets it, and a
   * pane that did keeps the same id it already answered to. */
  return { ok: true, cmd: withAgentEnv(base, s.agentId), sid };
}

export async function sessionOpsRoutes(ctx: RoutesCtx, req: Request, url: URL, path: string,
  server: import("bun").Server): Promise<Response | null> {

  // Pinned bar: the session's subagent/workflow runs (running + recent),
  // parsed from the same jsonl. Same pane-id-only confinement as above.
  const sag = path.match(/^\/session-agents\/(.+)$/);
  if (sag && req.method === "GET") {
    // Content (subagent runs): the tunnel and the host only,
    // gated before the session lookup so a refused peer cannot tell 403 from 404.
    const denied = await requireOwner(req, server);
    if (denied) return denied;
    const s = sessions.get(decodeURIComponent(sag[1]));
    if (!s) return json({ error: "no session file" }, 404);
    /* The pinned-bar read moves behind the adapter (conversationRuns). The
     * runs live in the CLAUDE jsonl, so the id passed is claude's own or null
     * (the old claudeSessionId, derived from the agent kind);
     * a non-claude row passes null and gets the same no-file 404. */
    const r = await ctx.adapter.conversationRuns(s.cwd, s.agent.id === "claude" ? s.harnessSessionId : null);
    if (!r.logExists) return json({ error: "no session file" }, 404);
    return json({ sessionAgentId: s.agentId, runs: r.runs });
  }

  /* EVERY AGENT ON THIS ENGINE, for the `cyc` CLI (cyc-cli plan section 2).
   *
   * The one GET that returns the session list with the fields a local control
   * tool needs: the stable agent id (the explicit id every `cyc agent` and
   * `cyc plugin` command takes; an agent learns its own from the MCP `info`
   * tool), the display name, the cwd, the live mux handle (`pane`, internal,
   * never shown), the harness type, status/liveness, and the harness session
   * id the ops routes key on.
   *
   * requireLocal, not requireOwner: this is on-machine agent control (the app
   * has the ws sessions frame and never needs it), so like /agent-message it
   * answers the engine host only -- no tunnel, no tailnet peer. */
  if (req.method === "GET" && path === "/agents") {
    const denied = requireLocal(req, server);
    if (denied) return denied;
    const mux = (process.env.CYC_MUX ?? "tmux").trim().toLowerCase() === "herdr" ? "herdr" : "tmux";
    const agents = [...sessions.values()].map((s) => ({
      agentId: s.agentId,
      name: titleOf(nameOverrideOf(s.id), claudeTitleOf(s), s.name).text,
      cwd: s.cwd,
      pane: s.muxHandle,
      harness: s.agent.id,
      status: s.status,
      alive: s.alive,
      sessionId: s.id,
    }));
    return json({ ok: true, mux, agents });
  }

  /* OUT-OF-TREE ADAPTER: stop ONE running agent row (piagent's pi-lane kill).
   * The stopping capability is injected by the composition root behind
   * CYC_PIAGENT_ADAPTER; with no handler registered the vanilla
   * engine has no such route (404), behaviour-identical to the flag unset. Core
   * still resolves the session, the transcript, and the requested agentId; the
   * handler owns which run it will stop and how. Unknown agentId is a 404; a
   * matched run whose process is already gone is {ok:false,error:"not running"}. */
  const sagStop = path.match(/^\/session-agents\/(.+)\/stop$/);
  if (sagStop && req.method === "POST") {
    const denied = await requireOwner(req, server);
    if (denied) return denied;
    if (!ctx.agentStopHandler) return json({ error: "not found" }, 404);
    const s = sessions.get(decodeURIComponent(sagStop[1]));
    /* Resolve+read the runs behind the adapter (conversationRuns does
     * exactly the sessionFilePath + exists + readAgentRuns this route used to
     * do inline). A missing session or absent transcript is the same 404. */
    const r = await ctx.adapter.conversationRuns(s?.cwd ?? "", s?.agent.id === "claude" ? s.harnessSessionId : null);
    if (!r.logExists) return json({ ok: false, error: "no session file" }, 404);
    const got = await readJsonCapped(req, JSON_BODY_MAX_BYTES);
    if (!got.ok) return got.response;
    const agentId = String((got.value as { agentId?: unknown })?.agentId ?? "");
    if (!agentId) return json({ ok: false, error: "agentId required" }, 400);
    const res = await ctx.agentStopHandler(r.runs, agentId);
    if (res.ok) return json({ ok: true });
    return res.status ? json({ ok: false, error: res.error }, res.status)
                      : json({ ok: false, error: res.error });
  }


  if (req.method === "POST" && path.startsWith("/session/") && path.endsWith("/rename")) {
    const denied = await requireOwner(req, server);
    if (denied) return denied;
    const id = decodeURIComponent(path.slice("/session/".length, -"/rename".length));
    const s = sessions.get(id);
    if (!s) return json({ ok: false, error: "no such session" }, 404);
    const got = await readJsonCapped(req, JSON_BODY_MAX_BYTES);
    if (!got.ok) return got.response;
    const body = got.value as { name?: unknown };
    const name = typeof body.name === "string" ? body.name.trim().slice(0, 80) : "";
    let inHerdr = false;
    if (s.viaMux && name) {
      try {
        /* The rename pane op goes through the adapter's spawn-side verb. */
        await ctx.adapter.rename(s.muxHandle, name);
        inHerdr = true;
      } catch (e) {
        console.warn(`[names] herdr refused to rename ${s.id}:`, (e as Error)?.message);
      }
    }
    if (name) setNameOverride(id, name);
    else setNameOverride(id, null);
        broadcastSessions();
    return json({ ok: true, name, inHerdr });
  }


  /* Mark a conversation unread, or read, from the list.
   *
   * takes `read` and dialogsContextMenu's two menu rows share a single onClick
   * (src/components/dialogsContextMenu.ts:375). Two routes would be two places
   * to keep the marker's rules in.
   *
   * ON THE ENGINE AND NOT IN THE PAGE, for the reason the marker is on the
   * engine at all: a badge the phone drew for itself would be gone on the
   * tablet, gone after a reload, and undone by the very next sessions frame.
   * broadcastSessions is what puts it on his other device, and it is the same
   * call a rename makes.
   *
   * `ok: false` when nothing moved -- no agent message to be unread, or it is
   * already in the state asked for -- so the app can say so rather than leaving
   * a menu item that looks like it did something. */
  if (req.method === "POST" && path.startsWith("/session/") && path.endsWith("/unread")) {
    const denied = await requireOwner(req, server);
    if (denied) return denied;
    const id = decodeURIComponent(path.slice("/session/".length, -"/unread".length));
    const s = sessions.get(id);
    if (!s) return json({ ok: false, error: "no such session" }, 404);
    const got = await readJsonCapped(req, JSON_BODY_MAX_BYTES);
    if (!got.ok) return got.response;
    const body = got.value as { read?: unknown };
    const moved = body.read === true ? markAllRead(s) : markUnread(s);
    if (moved) broadcastSessions();
    return json({ ok: moved, unread: unreadOf(s), heardTs: s.heardTs });
  }


  /* Reorder the chat list. The app sends the WHOLE order it is now showing
   * rather than "this one moved from 3 to 1": a diff has to be applied against
   * the list the sender was looking at, and with three devices watching one
   * order that list is not reliably the one we hold.
   *
   * broadcastSessions is what makes the other two devices rearrange live, and
   * it is the same call a rename makes: the order is part of the sessions
   * frame, so there is no second channel to invent. */
  if (req.method === "POST" && path === "/sessions/order") {
    const denied = await requireOwner(req, server);
    if (denied) return denied;
    const got = await readJsonCapped(req, JSON_BODY_MAX_BYTES);
    if (!got.ok) return got.response;
    const body = got.value as { order?: unknown };
    if (!Array.isArray(body.order)) return json({ ok: false, error: "order must be a list of ids" }, 400);
    setManualOrder(nextOrder(getManualOrder(), body.order));
    broadcastSessions();
    return json({ ok: true, order: sessionList().map((s) => s.id) });
  }


  /* THE GET /session/<id>/settings ROUTE IS GONE. The engine exposes no remote
   * HTTP read for a session's settings: the app receives them in the websocket
   * sessions frame, and local inspection is `cyc`'s job. Only the POST (the
   * write the app makes over the tunnel) remains below. */

  /* This session's other overrides: mute and the bell.
   *
   * A partial update: only the keys sent change, `null` clears one back to
   * "follow the global default". The voice override above keeps its own
   * endpoint because empty-string-means-clear was already its contract.
   *
   * `speed` and `activity` are not accepted any more (both are one app-level
   * switch now), and a client that sends only those gets the 400 below rather
   * than a silent 200 over a store that kept nothing. */
  if (req.method === "POST" && path.startsWith("/session/") && path.endsWith("/settings")) {
    /* A session preference (mute / the bell) written by an enrolled device.
     * It used to be the one exemption from the localhost gate; it takes the
     * same requireOwner as every other mutating route now (the enrolled device
     * reaches it over the sealed tunnel, the host over loopback), so the
     * exemption is gone: an un-paired tailnet peer cannot flip another
     * person's bell. */
    const denied = await requireOwner(req, server);
    if (denied) return denied;
    const id = decodeURIComponent(path.slice("/session/".length, -"/settings".length));
    if (!sessions.has(id)) return json({ ok: false, error: "no such session" }, 404);
    const got = await readJsonCapped(req, JSON_BODY_MAX_BYTES);
    if (!got.ok) return got.response;
    const body = got.value as Record<string, unknown>;
    const patch: Partial<Record<keyof SessionSettings, boolean | null>> = {};
    for (const k of ["muted", "notify"] as const) {
      if (typeof body[k] === "boolean" || body[k] === null) patch[k] = body[k] as boolean | null;
    }
    if (!Object.keys(patch).length) return json({ ok: false, error: "nothing to set" }, 400);
    applySessionSettings(id, patch);
    console.log(`[settings] ${id} ${JSON.stringify(settingsOf(id))}`);
    return json({ ok: true, settings: settingsOf(id) });
  }


  /* THE SCHEDULE ROUTES ARE GONE. Schedules ride the ONE requireOwner'd
   * /plugin/crons/rpc/<op> route now (list/create/update/remove/preview); the
   * crons plugin owns the whole vertical. */

  /* SEND A MESSAGE ON A SESSION (#513, narrowed to input-only by #515). ONE
   * route now, next to the schedule ones and sharing their conventions: the
   * session id is the claude uuid (or the pane id before claude mints one), an
   * unknown one is a 404, and the envelope is the same { ok, ... }. His
   * instruction was KEEP IT SIMPLE: a plain "<author>: <text>", author always
   * named, no schema beyond that.
   *
   * There is NO chat-message sibling any more (#515): no route may write a chat
   * row on a script's behalf, because that is impersonation. The only way words
   * reach his chat is the agent's OWN MCP saying them; a script can feed the
   * agent input and let it decide what, if anything, to say.
   *
   * Validation: author and text are non-empty strings and text is within
   * ctx.sendMsgMax; anything else is a 400 with a plain reason. No auth beyond what
   * the sibling schedule routes have -- the same trust model. */
  const validateSend = (b: Record<string, unknown>):
    { author: string; text: string } | { error: string } => {
    const author = typeof b.author === "string" ? b.author.trim() : "";
    const text = typeof b.text === "string" ? b.text.trim() : "";
    if (!author || !text) return { error: "author and text must both be non-empty strings" };
    /* THE AUTHOR IS ONE HONEST LINE, and this is the load-bearing check. The
     * delivered line is "<author>: <text>", so a newline (or any control char)
     * embedded in the author forges a SECOND speaker: author "Example\nDemoAgent"
     * renders as two lines, the second of which reads as DemoAgent saying the
     * text -- a message DemoAgent never sent, attributed to it, which defeats the
     * one guarantee this feature makes ("the sender is always identified").
     * trim() only strips the ends, so embedded ones survive; reject them here.
     * TEXT is deliberately NOT guarded: a multi-line body under one honest
     * author prefix is a legitimate message (a usage report over several lines),
     * and the prefix stays honest because the author cannot break out of it. */
    if (/[\u0000-\u001f\u007f-\u009f]/.test(author)) {
      return { error: "author must be a single line with no control characters or line breaks" };
    }
    if (text.length > ctx.sendMsgMax) {
      return { error: `text is longer than the ${ctx.sendMsgMax}-character limit` };
    }
    return { author, text };
  };

  /* FEED INPUT TO THE AGENT (#515, input-only). Land "<author>: <text>" in the
   * pane so the agent reads it, and that is ALL: no role:"user" chat row, no
   * role:"claude" row, no reply-level instruction, no Stop-hook arming. It goes
   * through deliverToAgent, the SAME shared path a fired schedule uses -- a
   * message fed INTO the session, not one FROM a person, so nothing litters the
   * chat and silence is a valid outcome. This is what a governor script (a usage
   * report, a work note) and a cron want; the agent ingests it and decides what,
   * if anything, to say through its own MCP. Replaces the one-off schedules
   * DemoAgent's notify-done abuses today, which fire two seconds late and leave a
   * dead row in the crons panel.
   *
   * A pane that cannot take it right now (offline, on a permission prompt, herdr
   * refusing) is a 503 carrying why and whether it is retriable, the same
   * distinction deliverToAgent draws for a schedule. */
  if (req.method === "POST" && path.startsWith("/session/") && path.endsWith("/agent-message")) {
    const denied = requireLocal(req, server);
    if (denied) return denied;
    const id = decodeURIComponent(path.slice("/session/".length, -"/agent-message".length));
    const s = sessions.get(id);
    if (!s) return json({ ok: false, error: "no such session" }, 404);
    const got = await readJsonCapped(req, JSON_BODY_MAX_BYTES);
    if (!got.ok) return got.response;
    const b = got.value as Record<string, unknown>;
    const v = validateSend(b);
    if ("error" in v) return json({ ok: false, error: v.error }, 400);
    const res = await deliverToAgent(s, { how: v.author, text: v.text });
    if (!res.ok) {
      return json({ ok: false, error: res.why ?? "the message was not delivered",
        retriable: res.retriable ?? false }, 503);
    }
    return json({ ok: true, ts: res.ts });
  }


  /* Where a new session could go: the directories that already have one on
   * this host. Typing a path on a phone is not a thing anyone wants to do.
   *
   * AND `home`, WHICH IS ALWAYS THERE. `places` is empty on a host with no
   * agent running, which is exactly the host you want to start one on, and the
   * app's plus menu had nothing to show and said so. Home is a directory this
   * user always has, so the menu always has at least one thing in it (his
   * words, 2026-08-05: "the plus button should include a home option as first
   * ... so there is always one option to show").
   *
   * It is reported rather than assumed because there is no path to assume: see
   * ctx.engineHome. An app talking to an engine too old to send it simply gets no
   * Home row, which is what this endpoint said yesterday.
   *
   * AND `def`, THE PREFERRED DEFAULT: the engine's own checkout. On macOS
   * every fresh directory an agent works in costs a TCC permission prompt,
   * and the checkout the engine runs from is the one directory already
   * blessed. With a known checkout, home is EXCLUDED from `places`: every
   * tap on it could land an agent in an unblessed folder and cost a prompt
   * (decided 2026-08-23). The `home` field itself stays in the response for
   * identity and older apps. With no known checkout, def is home and the
   * answer is exactly what this route said before. An app too old to read
   * `def` ignores it and defaults the way it always has. */
  if (path === "/new-session/places") {
    // The directory list is a session op (leak-audit MOVE): the tunnel and the
    // host only, so a tailnet peer cannot enumerate this host's
    // working directories over plain HTTP.
    const denied = await requireOwner(req, server);
    if (denied) return denied;
    /* The cwd list comes from the adapter, not the raw ctx.mux. */
    const known = ctx.adapter.knownCwds().slice(0, 12);
    const def = ctx.engineRepo ?? ctx.engineHome;
    const repo = ctx.engineRepo;
    // a known checkout drops home from the list; no checkout leaves it alone
    const offered = repo && repo !== ctx.engineHome
      ? known.filter((cwd) => cwd !== ctx.engineHome) : known;
    const places = repo && !offered.includes(repo)
      ? [repo, ...offered] : offered;
    /* The harnesses the plus menu may offer, each with a live PATH probe on
     * the engine host (a reader that declares a launch but whose program is not
     * installed comes back available:false). programToken("") is "" only for a
     * launch with no program token, and binaryOnPath("") is false. The app owns
     * presentation and offers only the available ones; READERS order (claude
     * first) is preserved so the default choice is the top row. */
    const harnesses = ctx.adapter.launchableKinds().map(({ kind, command }) => ({
      kind, available: ctx.binaryOnPath(programToken(command) ?? ""),
    }));
    /* Folders any agent ran in before, minus the ones already offered as live
     * (places) plus home and the engine checkout, so a folder never shows in
     * both groups. */
    const recent = recentCwds(new Set([
      ...places, ctx.engineHome, ...(ctx.engineRepo ? [ctx.engineRepo] : []),
    ]));
    return json({ places, home: ctx.engineHome, def, harnesses, recent });
  }


  /* THE + MENU'S "RECENTLY CLOSED" LIST. Closing a chat closes the pane but the
   * agent meta survives on disk (nothing deletes it), so an agent this engine
   * owns can be reopened under its old identity. This lists the newest few dead
   * ones: every meta with no LIVE session, newest meta.json mtime first, five
   * at most. `canResume` says whether it has a session id to --resume onto. */
  if (req.method === "GET" && path === "/agents/recently-closed") {
    const denied = await requireOwner(req, server);
    if (denied) return denied;
    const rows: Array<{ agentId: string; name: string; harness: string; cwd: string;
      canResume: boolean; mtime: number }> = [];
    for (const meta of agentMetas.values()) {
      if (sessions.get(meta.agentId)?.alive) continue; // a live agent is not "closed"
      let mtime = 0;
      try { mtime = (await stat(agentMetaFile(meta.agentId))).mtimeMs; } catch { continue; }
      rows.push({
        agentId: meta.agentId,
        name: meta.name ?? "",
        harness: meta.harness ?? "claude",
        cwd: meta.cwd ?? "",
        canResume: !!meta.sessionId,
        mtime,
      });
    }
    rows.sort((a, b) => b.mtime - a.mtime);
    return json(rows.slice(0, 5).map(({ mtime: _mtime, ...r }) => r));
  }


  /* Start one. A tab in the same workspace as an existing agent, running
   * claude in the chosen directory; the pane shows up as a session on the next
   * snapshot, which is what the app waits for.
   *
   * EVERY ANSWER IS LOGGED, NOT JUST THE ONE THAT WORKED. This route used to
   * write a line only after the tab existed, so both refusals were invisible:
   * when he reported "i tried to start a new session in home and it just
   * failed" (2026-08-05), the log said nothing whatsoever, and the absence read
   * like a request that never arrived rather than one that was answered 502.
   * A route nobody can see failing is a route nobody can fix. */
  if (req.method === "POST" && path === "/new-session") {
    const denied = await requireOwner(req, server);
    if (denied) return denied;
    const got = await readJsonCapped(req, JSON_BODY_MAX_BYTES);
    if (!got.ok) return got.response;
    const body = got.value as { cwd?: unknown; near?: unknown; harness?: unknown;
      agentId?: unknown; resume?: unknown };
    const near = typeof body.near === "string" ? body.near : "";
    /* THE THREE THINGS A SPAWN NEEDS, resolved by one of two paths below: the
     * folder to run in, the exact launch command, the stable id to bind. */
    let cwd: string;
    let launch: string;
    let aid: string;
    let harness: string | undefined;
    const wantAgentId = typeof body.agentId === "string" ? body.agentId : "";
    if (wantAgentId) {
      /* REOPEN A RECENTLY-CLOSED AGENT (the + menu's "Recently closed" row). The
       * body names an agent this engine already owns; its cwd and harness come
       * from the META, never the body. The meta cwd is honoured even where the
       * allowlist would refuse it -- it was this engine's own agent, not an
       * arbitrary folder. resume===true replays the harness's own --resume verb
       * onto the stored session id so the OLD conversation reopens; otherwise it
       * starts fresh but STILL under the old id, so name/photo/chat all survive. */
      if (!AGENT_ID_RE.test(wantAgentId)) {
        console.log(`[new-session] refused ${wantAgentId}: not an agent id`);
        return json({ ok: false, error: "not an agent id" }, 400);
      }
      const meta = agentMetas.get(wantAgentId);
      if (!meta) {
        console.log(`[new-session] refused ${wantAgentId}: no such agent`);
        return json({ ok: false, error: "no such agent" }, 400);
      }
      if (sessions.get(wantAgentId)?.alive) {
        console.log(`[new-session] refused ${wantAgentId}: already live`);
        return json({ ok: false, error: "that agent is already open" }, 409);
      }
      cwd = typeof meta.cwd === "string" ? meta.cwd : "";
      if (!cwd) {
        console.log(`[new-session] refused ${wantAgentId}: meta has no cwd to reopen in`);
        return json({ ok: false, error: "that agent has no folder to reopen in" }, 400);
      }
      harness = meta.harness ?? "claude";
      /* The resume verb only when we asked for it AND the agent has a session id
       * AND its reader has one; else the reader's fresh launch. */
      const resumeCmd = body.resume === true && meta.sessionId
        ? ctx.adapter.resumeCommand(harness, meta.sessionId) : null;
      const cmd = resumeCmd ?? ctx.adapter.launchCommand(harness);
      if (!cmd) {
        console.log(`[new-session] refused ${wantAgentId}: unknown harness ${harness}`);
        return json({ ok: false, error: `unknown harness: ${harness}` }, 400);
      }
      const prog = programToken(cmd);
      if (!prog || !ctx.binaryOnPath(prog)) {
        console.log(`[new-session] refused ${wantAgentId}: ${harness} is not installed on this host`);
        return json({ ok: false, error: `${harness} is not installed on this host`, harness }, 400);
      }
      launch = cmd;
      aid = wantAgentId; // reopen under the OLD id, so its identity is kept
    } else {
      cwd = typeof body.cwd === "string" ? body.cwd : "";
      if (!cwd) {
        console.log("[new-session] refused: no cwd in the request");
        return json({ ok: false, error: "cwd required" }, 400);
      }
      /* only somewhere we already run, PLUS this user's own home and the
       * engine's own checkout: this endpoint must not become a way to start a
       * shell anywhere on the machine. Neither addition widens the rule: both
       * are this process's own user's directories (the checkout is the code
       * this very server runs from), so they grant no reach it did not have. */
      if (cwd !== ctx.engineHome && cwd !== ctx.engineRepo &&
          !ctx.adapter.knownCwds().includes(cwd) && !isRecentCwd(cwd)) {
        console.log(`[new-session] refused ${cwd}: not home (${ctx.engineHome}), not the ` +
          `engine checkout (${ctx.engineRepo}), not one of [${ctx.adapter.knownCwds().join(" ")}] ` +
          `and not in the pane-binding history`);
        return json({ ok: false, error: "unknown directory" }, 400);
      }
      /* WHICH HARNESS. Absent or "" means claude, byte-identical to what this
       * route did before an old app never sends the field. A named harness is
       * resolved to its launch command through the same reader table a restart
       * uses, then re-probed on PATH (TOCTOU: the menu could be minutes old).
       * Both refusals are logged and answered 400 BEFORE any tab is spawned. */
      harness = typeof body.harness === "string" && body.harness ? body.harness : undefined;
      launch = ctx.claudeCommand;
      if (harness) {
        const cmd = ctx.adapter.launchCommand(harness);
        if (!cmd) {
          console.log(`[new-session] refused ${cwd}: unknown harness ${harness}`);
          return json({ ok: false, error: `unknown harness: ${harness}` }, 400);
        }
        launch = cmd;
      }
      /* PROBE THE CHOSEN LAUNCH ON PATH, the default claude included. With no
       * named harness the app sends nothing and we default to claude, so an
       * engine that has no claude installed used to spawn a dead shell and the
       * app hung on "started, but it has not appeared here yet". Refuse 400
       * BEFORE any tab is spawned, the same shape the named-harness case uses. */
      {
        const name = harness ?? "claude";
        const prog = programToken(launch);
        if (!prog || !ctx.binaryOnPath(prog)) {
          console.log(`[new-session] refused ${cwd}: ${name} is not installed on this host`);
          /* A TYPED refusal: `harness` names the missing binary so the app can
           * show the server's own sentence rather than the misleading
           * "started, but it has not appeared here yet" (listPane landStarted). */
          return json({ ok: false, error: `${name} is not installed on this host`, harness: name }, 400);
        }
      }
      /* PRE-MINT the stable agent id and inject it into the child's env at spawn
       * (cyc-cli plan section 3). The engine picks the id, hands it to the agent
       * as CYC_AGENT_ID, and binds it to the returned handle below; the CLI in
       * that pane then resolves self straight from the env with no fallback. */
      aid = freshAgentId();
    }
    try {
      /* Spawning a tab goes through the ctx.adapter. workspaceOf(near) and the
       * cwd-derived label are the adapter's now; the wire reply still names the
       * handle `paneId` so the app sees the exact frame it always did. */
      const { handle: paneId } = await ctx.adapter.spawn({
        cwd,
        nearHandle: near || null,
        /* THE SAME COMMAND /session/:id/restart types, and the same one he
         * types by hand: see ctx.claudeCommand for why a session started from a
         * phone must not open on "do you trust this folder". Prefixed with the
         * pre-minted agent id so the child knows what it is. */
        command: withAgentEnv(launch, aid),
      });
      /* Bind the pre-minted id to the fresh handle; reconcile resolves the
       * pane to this agent (rule 2) and its announce fills the session id. */
      adoptAgentId(paneId, aid);
      console.log(`[new-session] ${paneId} in ${cwd} (${aid}, ${harness ?? "claude"})`);
      /* `agentId` is the pre-minted STABLE id, returned alongside the transient
       * pane handle. The app matches the new session by this id: the pane handle
       * is re-keyed to the announced claude uuid moments later (carry.ts), so a
       * caller waiting on the handle never sees the session and would false-toast
       * "not appeared". The stable id survives that re-key. */
      return json({ ok: true, paneId, agentId: aid });
    } catch (e) {
      const why = (e as Error)?.message ?? "could not start it";
      console.error(`[new-session] failed in ${cwd}: ${why}`);
      return json({ ok: false, error: why }, 502);
    }
  }


  /* Close the pane. herdr drops it from the agent list, and the next snapshot
   * marks the session dead here, which is what makes the row go away. */
  if (req.method === "POST" && path.startsWith("/session/") && path.endsWith("/exit")) {
    const denied = await requireOwner(req, server);
    if (denied) return denied;
    const id = decodeURIComponent(path.slice("/session/".length, -"/exit".length));
    const s = sessions.get(id);
    if (!s) return json({ ok: false, error: "no such session" }, 404);
    if (!s.viaMux) return json({ ok: false, error: "not a live agent" }, 400);
    try {
      /* Closing the pane goes through the adapter's spawn-side verb. */
      await ctx.adapter.close(s.muxHandle);
    } catch (e) {
      return json({ ok: false, error: (e as Error)?.message ?? "close failed" }, 502);
    }
    return json({ ok: true });
  }


  /* RESTART THE AGENT, KEEPING THE PANE.
   *
   * His: "it can already start a session so it should be able to close and
   * start again". It can, and the pane is the part that must not move. The
   * app's chat is keyed host|pane, so closing the tab and opening another
   * hands him an empty chat beside an orphaned one; and the working directory
   * is load bearing, because the voice MCP is `.mcp.json` in the repo and a
   * session started anywhere else comes back mute. Quitting the agent where it
   * stands keeps both for free: the shell is already in the right place and
   * the pane id never changes.
   *
   * TWO MODES, NEVER ONE THAT GUESSES. `fresh` starts with no memory
   * of anything; `resume` comes back knowing the conversation. "Restart it"
   * and "start it over" are different intentions, and the second throwing away
   * a day of context by accident would be infuriating, so the caller names
   * which one and this endpoint never picks.
   *
   * `resume` needs the session id herdr reports for the pane. Without one,
   * `--resume` opens claude's own picker in the terminal: a chooser nobody in
   * the app can answer, in a pane that had a working agent a moment ago. It is
   * refused by name instead.
   */
  if (req.method === "POST" && path.startsWith("/session/") && path.endsWith("/restart")) {
    const denied = await requireOwner(req, server);
    if (denied) return denied;
    const id = decodeURIComponent(path.slice("/session/".length, -"/restart".length));
    const s = sessions.get(id);
    if (!s) return json({ ok: false, error: "no such session" }, 404);
    if (!s.viaMux) return json({ ok: false, error: "not a live agent" }, 400);
    /* AN AGENT THIS ENGINE WILL NOT LAUNCH IS REFUSED BY NAME (the mux
     * reader's launch capability). Restart types a start command into the pane;
     * for an agent whose reader has no launch command the engine does not know
     * that command, and guessing one is how a working pane gets a shell error
     * typed into it. claude, codex and opencode all carry a launch command now,
     * so restart is supported for them; an agent whose reader omits one (a
     * hand-started pi, a reader not yet written) is still refused here, the
     * honest answer being that restart is not supported for it. */
    if (!ctx.adapter.launchCommand(s.agent.id)) {
      return json({ ok: false,
        error: `restart is not supported for ${s.agent.name} yet` }, 409);
    }
    const got = await readJsonCapped(req, JSON_BODY_MAX_BYTES);
    if (!got.ok) return got.response;
    const body = got.value as { mode?: unknown };
    const mode = body.mode === "resume" ? "resume" : body.mode === "fresh" ? "fresh" : null;
    if (!mode) return json({ ok: false, error: "mode must be fresh or resume" }, 400);
    /* The mode/sid/command decision is a pure function (restartPreflight), so
     * it is unit-testable without the quit-watch or a live pane; the route owns
     * the mux round trip below, the helper owns the decision the route returns
     * verbatim. */
    const pre = restartPreflight(s, mode, ctx.adapter);
    if (!pre.ok) return json({ ok: false, error: pre.error }, pre.status);
    const { cmd, sid } = pre;
    /* `ok` IS THE SIGHTING, NOT THE REQUEST.
     *
     * It used to be the literal `true`, which made every one of these a
     * success: the command going in was the whole test. So "the command was
     * typed and nothing has started" arrived at the app as a restart that
     * worked, and so did a `--resume` that came straight back saying there is
     * no such conversation. `ok` now says one thing -- we SAW claude come back
     * -- and `verdict` says which of the four things we saw, so the app can
     * decline to call it a restart without parsing the sentence. */
    try {
      const sighting = await restartPane(s, mode, cmd);
      const tell = restartTell(sighting, mode);
      /* THE CHAT LOG IS NOT THE TOAST. A sentence written here is in his
       * history for good, so only a sighting earns one (restartLogsToChat).
       * "This cannot say whether it restarted" is a fine thing to flash at
       * somebody who just pressed the button and a terrible thing to find in
       * the transcript of a session that came back fine. */
      if (restartLogsToChat(sighting)) {
        const msg: ChatMsg = { id: s.id, role: "claude", text: tell, ts: stampTs(s) };
        logChat(s, msg);
        broadcast({ t: "chat", ...msg });
      }
      return json({ ok: restartConfirmed(sighting), verdict: sighting.seen, mode,
        resumed: mode === "resume" ? sid : null, tell });
    } catch (e) {
      const why = e instanceof PaneNotReady ? e.tell : (e as Error)?.message ?? "restart failed";
      console.error(`[restart] ${s.id}: ${why}`);
      return json({ ok: false, verdict: "refused", error: why }, 502);
    }
  }

  return null;
}
