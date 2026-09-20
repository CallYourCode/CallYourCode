/* THE MCP SOCKET (L4 interface): how a session's own MCP process talks to
 * this engine over /ws -- `register` binds the socket as the session's
 * voice-out channel, and the session role's frames (speak/chat/show) route to
 * the reply and show handlers. The mux resolves the raw pane id to the opaque
 * handle core keys sessions by; core never sees the pane id.
 */

import { sessionByHandle, resolveSession, nameOverrideOf, type Session } from "../sessions/session-state.ts";
import { claudeTitleOf } from "../sessions/context-cache.ts";
import { titleOf } from "../sessions/title.ts";
import { send } from "../transport/wire.ts";
import { onSpeak, onChat } from "../chat/reply.ts";
import { onShow } from "../chat/show-handler.ts";
import type { Sock } from "../transport/sock.ts";

export type McpDeps = {
  /** the mux's pane-id -> opaque-handle resolution */
  resolveHandle(id: string): string | null;
};

let deps: McpDeps | null = null;
export function initMcp(d: McpDeps): void {
  deps = d;
}

export function onRegister(ws: Sock, m: any) {
  const id = String(m.id ?? "").trim();
  if (!id) return;

  // A re-register on the same id repoints voice-out at the newest socket but
  // keeps the chat log -- this is also how a dead non-herdr session comes
  // back to life. The old socket is deliberately NOT closed: two live MCP
  // processes can hold the same pane id (a backgrounded claude inherits the
  // spawning pane's HERDR_PANE_ID), and closing the loser made it reconnect
  // and re-register, which closed the other one, forever -- one register per
  // second until restart. A stale socket that stays open costs nothing: its
  // speak still routes by its own sessionId, and it cleans up when its
  // process exits.
  /* The MCP knows only its mux pane id (HERDR_PANE_ID / TMUX_PANE). The mux
   * resolves that to the opaque handle core keys sessions by; core never sees
   * the pane id. `ws.data.sessionId` then holds the PUBLIC id, which is what
   * onReply/onShow/close look the session up by. Falls back to the raw id so a
   * socket that is not a mux pane still gets held (the branch below). */
  const handle = deps?.resolveHandle(id) ?? null;
  const prev = handle ? sessionByHandle(handle) : resolveSession(id);

  ws.data.role = "session";
  ws.data.sessionId = prev?.id ?? id;

  /* What this MCP build can deliver. An MCP answers ListTools once, at startup,
   * so the tool set is a property of the PROCESS, and the only moment it can
   * report it is here. A build older than the declaration says nothing, and that
   * is recorded as nothing rather than guessed at: an empty list means "did not
   * say", and no decision is ever made on the strength of a guess. */
  const channels = Array.isArray(m.channels)
    ? m.channels.filter((c: unknown) => typeof c === "string").slice(0, 16)
    : [];

  if (prev) {
    // A speak MCP registering with a mux pane id IS that pane's voice-out
    // socket. Merge; the mux keeps owning name, cwd, and liveness.
    prev.ws = ws;
    prev.channels = channels;
    /* No hook-state write here any more: the Stop hook is verbosity-unaware, so
     * an MCP's channel list is not something it reads. `channels` still lives on
     * the session for askFor's wording bend. */
    send(ws, { t: "registered" });
    console.log(`[session] ~ ${id} voice-out attached (${prev.name}) [${channels.join(" ")}]`);
    return;
  }

  // Herdr is the source of truth: sessions exist only as herdr panes. An MCP
  // registering with an id herdr does not know (a stale process, a claude
  // running outside herdr, a subagent) gets an ack so speak still resolves,
  // but no session is created and nothing is broadcast. If herdr later
  // reports that pane, the next re-register merges normally.
  send(ws, { t: "registered" });
  console.log(`[session] ? ${id} (${m.name}) not a live agent -- socket held, no session created`);
}


/* WHO IS THE AGENT ON THIS CONNECTION (the MCP `info` tool). The engine is the
 * one party that reliably knows: the socket registered with its pane, and the
 * pane resolves to the session that carries the stable agent id. Env cannot be
 * trusted for this (hand-started panes never got CYC_AGENT_ID injected), which
 * is why the MCP asks here instead of reading its own environment. */
export function onInfo(ws: Sock, m: any) {
  const sid = ws.data.sessionId;
  /* Resolve FRESH, not from register time: a socket that registered before its
   * pane was a live session holds its raw pane id, so retry the same
   * pane -> handle resolution register uses. */
  let s = sid ? resolveSession(sid) : undefined;
  if (!s && sid) {
    const handle = deps?.resolveHandle(sid) ?? null;
    if (handle) s = sessionByHandle(handle);
  }
  if (!s) {
    send(ws, { t: "info", reqId: m.reqId, ok: false,
      message: "this connection is not a registered agent" });
    return;
  }
  send(ws, { t: "info", reqId: m.reqId, ok: true, ...agentInfo(s) });
}

/* WHO THIS SESSION IS, as the `info` tool reports it. Shared by the /ws onInfo
 * frame and the loopback POST /agent/info route, so both answer with the same
 * stable agent id, display name, cwd and harness. */
export function agentInfo(s: Session): { agentId: string; name: string; cwd: string; harness: string } {
  return {
    agentId: s.agentId,
    name: titleOf(nameOverrideOf(s.id), claudeTitleOf(s), s.name).text,
    cwd: s.cwd,
    harness: s.agent.id,
  };
}

/** The session role's frame routing: one place, shared by the ws message
 *  handler, so the role's vocabulary is spelled once. */
export async function dispatchSessionFrame(ws: Sock, m: any): Promise<void> {
  if (m.t === "register") onRegister(ws, m);
  else if (m.t === "info") onInfo(ws, m);
  else if (m.t === "speak") await onSpeak(ws, m);
  else if (m.t === "chat") await onChat(ws, m);
  else if (m.t === "show") await onShow(ws, m);
}
