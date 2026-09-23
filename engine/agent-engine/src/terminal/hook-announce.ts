/* HOOK-ANNOUNCED SESSION IDENTITY (localhost-test bug 19).
 *
 * The claude session FILE is authoritative; identity IS the session id.
 * Everything in this module only BINDS A PANE to it. The installed
 * SessionStart/UserPromptSubmit hook (hooks/announce-session.py) POSTs
 * {sessionId, pid, ppid, cwd, herdrPane, tmuxPane} to POST /harness/announce
 * on loopback, and this module turns that into a pane bind:
 *
 *   1. The route resolves the announcing pid to its nearest AGENT ancestor
 *      (the hook's python is a grandchild of the claude that fired it; the
 *      claude pid is the one that outlives the hook). Resolved WHILE THE HOOK
 *      IS STILL ALIVE: the hook blocks on the HTTP response, so the whole
 *      ancestor chain exists during the request.
 *   2. The announce is PARKED (pending, keyed by that agent pid) until a mux
 *      can place it. PID RESOLUTION IS PRIMARY AND SUFFICIENT: TmuxMux
 *      matches the agent pid against each pane's detected agent process on
 *      its next poll and binds on a hit regardless of any witness. The pane
 *      witnesses are SECONDARY, and each lane reads only its own shape: tmux
 *      reads tmuxPane (%N), herdr reads herdrPane (wN:pN, its only evidence
 *      since herdr reports no pids). A foreign-lane or unresolvable witness
 *      is ignored, never blocking: a tmux pane inheriting a stale
 *      HERDR_PANE_ID from the herdr session that started the tmux server
 *      used to shadow the real pane and silently block the bind. Parking is
 *      the designed shape for "the announce arrived before the pane was
 *      first polled", and every announce logs its outcome (bound or parked
 *      with a reason).
 *   3. The resulting bind (pane handle -> sessionId, source hook:announce) is
 *      the strongest identity evidence there is and overrides pre-mint,
 *      parked and guessed links immediately. It persists across engine
 *      restarts (state/hook-binds.json), keyed by the reuse-proof pane handle,
 *      so a restart does not demote an announced pane back to guessing.
 *
 * The nearest-AGENT-ancestor rule is also the anti-theft line the guessing
 * stack needed six patches for: a transient background `claude -p` spawned
 * INSIDE a pane announces too, but its nearest agent ancestor is ITSELF, not
 * the pane's detected (topmost) claude, so its announce never matches a pane
 * and expires. The real claude's announce always matches.
 *
 *   bun test agent-engine/src/terminal/hook-announce.test.ts
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { agentIdOfProc, resolveProcExe, type SessionLink } from "../runtime/agents.ts";
import { ANNOUNCE_ID_RE } from "../runtime/ids.ts";
import { ensureDirSync, stateDir, stateFile } from "../storage/datadir.ts";

/** How long a parked announce waits for its pane to show before it expires.
 *  Generous: a pane always polls within seconds; anything older is a hook
 *  whose claude never surfaced as a pane (a background -p run, a dead pid). */
export const ANNOUNCE_TTL_MS = 5 * 60 * 1000;

export type PendingAnnounce = {
  sessionId: string;
  /** the announcing hook's own pid (what the wire carried) */
  pid: number;
  /** the nearest agent ancestor of `pid` at announce time, or null when the
   *  walk could not find one (the lane witnesses still apply as fallback) */
  agentPid: number | null;
  /** HERDR_PANE_ID from inside the announcing process, if any. Read ONLY by
   *  the herdr lane: a tmux pane routinely inherits a stale herdr id from the
   *  herdr session that started the tmux server, so it must never be allowed
   *  to shadow the tmux witness (the silent-park bug this shape fixes). */
  herdrPane: string | null;
  /** TMUX_PANE (%N) from inside the announcing process, if any. Read ONLY by
   *  the tmux lane. */
  tmuxPane: string | null;
  cwd: string;
  at: number;
  /** ANNOUNCE v2 (adapters lane 2): which harness spoke ("claude", "codex",
   *  "opencode", "pi"), and where this session came from when the harness
   *  said (claude SessionStart `source` + the prior id, codex
   *  `forked_from_id`, pi `previousSessionFile`). Reconcile consults
   *  `link.from` in the session index before any pane matching. */
  harness: string | null;
  link: SessionLink | null;
  /** outcome observability: the parked reason was logged once already */
  parkedLogged?: boolean;
  /** the most recent parked reason, carried so a TTL expiry can say WHY the
   *  announce never bound (retries are idempotent-quiet, so without this the
   *  expiry would be the only line and it would say nothing) */
  lastReason?: string;
};

type Bind = { sessionId: string; pid: number; at: number; link?: SessionLink };

const pending: PendingAnnounce[] = [];
/* The model a harness last announced for a session (pi's extension sends it on
 * start and on every model switch). Fresher than the transcript, which only
 * names a model once a reply lands. */
let liveModels: Map<string, string> | null = null; // lazy: loaded from disk on first use
const MODEL_RE = /^[A-Za-z0-9._:\/\[\]-]{1,120}$/;
const LIVE_MODELS_MAX = 500;
const modelsFile = () => stateFile("live-models.json");

// persisted: an engine restart must not drop the chip back to a stale transcript
function loadModels(): Map<string, string> {
  if (liveModels) return liveModels;
  liveModels = new Map();
  try {
    if (existsSync(modelsFile())) {
      for (const [k, v] of Object.entries(JSON.parse(readFileSync(modelsFile(), "utf-8")) ?? {})) {
        if (typeof v === "string" && MODEL_RE.test(v)) liveModels.set(k, v);
      }
    }
  } catch { /* a bad file only costs the chip its freshness */ }
  return liveModels;
}

function recordModel(sessionId: string, model: string): void {
  const m = loadModels();
  if (m.get(sessionId) === model) return;
  m.delete(sessionId);
  m.set(sessionId, model);
  while (m.size > LIVE_MODELS_MAX) m.delete(m.keys().next().value!);
  try {
    ensureDirSync(stateDir());
    writeFileSync(modelsFile(), JSON.stringify(Object.fromEntries(m)) + "\n");
  } catch (e) {
    console.error("[announce] could not write live-models.json:", e);
  }
}

export function liveModelOf(sessionId: string): string | null {
  return loadModels().get(sessionId) ?? null;
}
let binds: Map<string, Bind> | null = null; // lazy: loaded from disk on first use
const listeners: Array<() => void> = [];

/* THE LIVE-BINDING STEAL GUARD (defense in depth for the 2026-09-18 aiusage-grok
 * bug). A WITNESS-placed announce (a pane named only by an inherited
 * HERDR_PANE_ID / TMUX_PANE, no pid proof) can carry a THIRD PARTY's session id
 * onto a pane that a DIFFERENT harness is live in: grok's claude-compat runs
 * claude's hook, the hook POSTs grok's id with the stale herdr pane, and the
 * pane's live claude binding rolls to a session whose transcript does not exist
 * (the "Ctx n/a" flap). The engine wires a guard here that knows the live
 * session on a pane; when the guard refuses, the witness placement is dropped
 * instead of stealing the bind. A GENUINE rollover (claude /clear, /compact,
 * /resume) is NOT witness-foreign: it re-announces from the pane's own process
 * (same agent pid) or names an id the agent already knows, so the guard passes
 * it. The guard is consulted ONLY on the witness lane and ONLY when the pane's
 * current bind holds a different id, so the pid lane, engine-owned direct binds
 * and idempotent re-announces are untouched. */
export type LiveBindGuard = (
  handle: string,
  incoming: { sessionId: string; pid: number },
  current: { sessionId: string; pid: number },
) => { reason: string } | null;
let liveBindGuard: LiveBindGuard | null = null;

/** Wire (or clear) the live-binding steal guard. Set once at engine start from
 *  a closure that can see the session state; unset in tests that do not want it. */
export function setLiveBindGuard(g: LiveBindGuard | null): void {
  liveBindGuard = g;
}

const bindsFile = () => stateFile("hook-binds.json");

function loadBinds(): Map<string, Bind> {
  if (binds) return binds;
  binds = new Map();
  try {
    if (existsSync(bindsFile())) {
      const raw = JSON.parse(readFileSync(bindsFile(), "utf-8"));
      for (const [h, b] of Object.entries(raw ?? {})) {
        const r = b as Partial<Bind>;
        if (typeof h === "string" && typeof r?.sessionId === "string") {
          binds.set(h, { sessionId: r.sessionId, pid: Number(r.pid) || 0, at: Number(r.at) || 0,
            ...(r.link ? { link: r.link } : {}) });
        }
      }
    }
  } catch (e) {
    console.error("[announce] could not read hook-binds.json:", e);
  }
  return binds;
}

function saveBinds(): void {
  try {
    ensureDirSync(stateDir());
    writeFileSync(bindsFile(), JSON.stringify(Object.fromEntries(loadBinds()), null, 2) + "\n");
  } catch (e) {
    console.error("[announce] could not write hook-binds.json:", e);
  }
}

/** A mux registers to be poked when a new announce lands, so the bind is
 *  applied on an immediate poll rather than the next scheduled one. Returns
 *  the unregister, which stop() must call: the module outlives any one mux. */
export function onHookAnnounce(cb: () => void): () => void {
  listeners.push(cb);
  return () => {
    const i = listeners.indexOf(cb);
    if (i >= 0) listeners.splice(i, 1);
  };
}

/** The announced session for a pane handle, or null when the pane has never
 *  had an announcement. The one read the muxes make per pane per poll. */
export function hookBindFor(handle: string): { sessionId: string; link?: SessionLink } | null {
  const b = loadBinds().get(handle);
  return b ? { sessionId: b.sessionId, ...(b.link ? { link: b.link } : {}) } : null;
}

/** Record (or roll) a pane's announced bind. A re-announce of the same id is
 *  a no-op; a NEW id on the same pane is a roll/resume announced by claude
 *  itself and simply replaces the bind (announce beats announce, latest wins).
 *  Answers whether the store actually changed, so the caller's outcome log
 *  can stay quiet on idempotent re-announces. */
export function recordHookBind(handle: string, sessionId: string, pid: number, link?: SessionLink | null): boolean {
  const cur = loadBinds().get(handle);
  if (cur?.sessionId === sessionId) return false;
  loadBinds().set(handle, { sessionId, pid, at: Date.now(), ...(link ? { link } : {}) });
  saveBinds();
  return true;
}

/** The parked announces still waiting for a pane, TTL-swept. */
export function pendingAnnounces(now: number = Date.now()): readonly PendingAnnounce[] {
  for (let i = pending.length - 1; i >= 0; i--) {
    if (now - pending[i].at > ANNOUNCE_TTL_MS) {
      console.log(`[announce] expired ${pending[i].sessionId}: ${pending[i].lastReason ?? "never resolved"}`);
      pending.splice(i, 1);
    }
  }
  return pending;
}

/** A mux placed a parked announce on a pane: bind it and retire the parking.
 *  `via` is the evidence that placed it (pid mapping or a lane witness); the
 *  ONE outcome log per successful announce is written here, and only when the
 *  bind actually changed, so idempotent re-announces stay quiet. */
export function takePending(p: PendingAnnounce, handle: string, via: "pid" | "witness" = "pid"): void {
  const incomingPid = p.agentPid ?? p.pid;
  /* WITNESS FOREIGN-STEAL REFUSAL. Only the witness lane can be fooled by an
   * inherited pane id, and only when the pane already holds a DIFFERENT live
   * bind; the guard decides whether this is the pane's own rollover or a third
   * party. On a refusal the parking is retired (a transient foreign announcer,
   * e.g. a grok cron, exits; leaving it parked would only re-refuse every lap),
   * and the live bind is left exactly as it was. */
  if (via === "witness" && liveBindGuard) {
    const cur = loadBinds().get(handle);
    if (cur && cur.sessionId !== p.sessionId) {
      const verdict = liveBindGuard(handle, { sessionId: p.sessionId, pid: incomingPid }, { sessionId: cur.sessionId, pid: cur.pid });
      if (verdict) {
        console.log(`[announce] refused ${p.sessionId} (pid ${incomingPid}) -> ${handle}: ${verdict.reason}`);
        const i = pending.indexOf(p);
        if (i >= 0) pending.splice(i, 1);
        return;
      }
    }
  }
  if (recordHookBind(handle, p.sessionId, incomingPid, p.link)) {
    console.log(`[announce] bound ${p.sessionId} -> ${handle} (${via})`);
  }
  const i = pending.indexOf(p);
  if (i >= 0) pending.splice(i, 1);
}

/** A mux finished a resolution pass without placing this announce: log the
 *  reason ONCE per parked announce ("no pane for pid", "unknown witness",
 *  "ttl-wait"). The old shape logged the receipt and then nothing, so a bind
 *  that never happened was silent; every announce now has a visible outcome.
 *  Parked is never final: the announce stays pending and every later
 *  enumeration lap re-resolves it (quietly) until it binds or the TTL sweep
 *  expires it, which logs the reason recorded here. */
export function markParked(p: PendingAnnounce, reason: string): void {
  p.lastReason = reason;
  if (p.parkedLogged) return;
  p.parkedLogged = true;
  console.log(`[announce] parked ${p.sessionId}: ${reason}`);
}

/** Hygiene prune against an AUTHORITATIVE enumeration: a bind whose pane is
 *  gone dies with it. `owns` scopes the prune to the calling mux's own handle
 *  shape, so the tmux poll never prunes a herdr bind or vice versa. The keys
 *  are reuse-proof, so this is tidiness, not correctness. */
export function pruneHookBinds(live: Set<string>, owns: (handle: string) => boolean): void {
  if (loadBinds().size === 0) return; // nothing to prune, nothing to write
  let changed = false;
  for (const h of [...loadBinds().keys()]) {
    if (owns(h) && !live.has(h)) {
      loadBinds().delete(h);
      changed = true;
    }
  }
  if (changed) saveBinds();
}

// ---------------------------------------------------------------- the route

/* Shapes the route accepts. The session id is the harness's own (claude's
 * uuid); validated to the charset a session FILE name can carry (ids.ts
 * ANNOUNCE_ID_RE), since it becomes a transcript lookup key downstream. The
 * witnesses are mux pane ids: herdrPane `wN:pN`, tmuxPane `%N`. */
const SESSION_ID_RE = ANNOUNCE_ID_RE;
const PANE_ENV_RE = /^[A-Za-z0-9%:._-]{1,64}$/;
const HARNESS_RE = /^[a-z][a-z0-9-]{0,31}$/;
const LINK_KINDS = new Set<SessionLink["kind"]>(["clear", "fork", "resume", "compact", "parent", "startup"]);

/** The optional v2 link of an announce body. Two spellings are accepted:
 *  an explicit `link: {kind, from?}` (the adapter lane's plugins), or the
 *  claude hook's raw SessionStart `source` (startup|resume|clear|compact|
 *  fork) with the prior id in `previousSessionId` when the hook knows it.
 *  Anything else is no link: a malformed link must never block the bind. */
export function parseAnnounceLink(b: Record<string, unknown>): SessionLink | null {
  const from = (v: unknown): string | undefined =>
    typeof v === "string" && SESSION_ID_RE.test(v) ? v : undefined;
  const raw = b.link;
  if (raw && typeof raw === "object") {
    const l = raw as Record<string, unknown>;
    if (typeof l.kind === "string" && LINK_KINDS.has(l.kind as SessionLink["kind"])) {
      const f = from(l.from);
      return { kind: l.kind as SessionLink["kind"], ...(f ? { from: f } : {}) };
    }
    return null;
  }
  if (typeof b.source === "string" && LINK_KINDS.has(b.source as SessionLink["kind"])) {
    const f = from(b.previousSessionId);
    return { kind: b.source as SessionLink["kind"], ...(f ? { from: f } : {}) };
  }
  return null;
}

export type AnnounceDeps = {
  /** the nearest-agent-ancestor walk; injectable so seam tests need no real ps */
  resolveAgentPid?: (pid: number) => Promise<number | null>;
  /** full-chain walk: nearest agent ancestor AND whether ANOTHER agent sits
   *  above it (a nested claude, e.g. spawned by a parent claude's tool call).
   *  Nested announcers inherit the parent's pane witnesses, so their
   *  witnesses must be stripped or they stomp the parent's pane bind (the
   *  2026-08-29 flicker bug; the pid lane was already immune by design). */
  resolveAgentChain?: (pid: number) => Promise<{ agentPid: number | null; nested: boolean }>;
  now?: () => number;
};

/** The body of POST /harness/announce. Validates, resolves the agent pid,
 *  parks the announce and pokes every registered mux. Never throws: the hook
 *  on the other end is fail-silent, and so is this side. */
export async function handleAnnounce(
  body: unknown,
  deps: AnnounceDeps = {},
): Promise<{ ok: boolean; error?: string; parked?: boolean }> {
  if (typeof body !== "object" || body === null) return { ok: false, error: "not an object" };
  const b = body as Record<string, unknown>;
  const sessionId = typeof b.sessionId === "string" ? b.sessionId : "";
  const pid = Number(b.pid);
  if (!SESSION_ID_RE.test(sessionId)) return { ok: false, error: "bad sessionId" };
  if (!Number.isInteger(pid) || pid <= 1) return { ok: false, error: "bad pid" };
  const paneField = (k: string): string | null => {
    const raw = typeof b[k] === "string" ? (b[k] as string) : "";
    return PANE_ENV_RE.test(raw) ? raw : null;
  };
  let herdrPane = paneField("herdrPane");
  let tmuxPane = paneField("tmuxPane");
  const cwd = typeof b.cwd === "string" ? b.cwd : "";
  const harness = typeof b.harness === "string" && HARNESS_RE.test(b.harness) ? b.harness : null;
  const link = parseAnnounceLink(b);
  if (typeof b.model === "string" && MODEL_RE.test(b.model)) recordModel(sessionId, b.model);
  /* A CHILD SESSION IS NOT AN AGENT (opencode `parentID`: a subagent of a
   * top-level session). It is acknowledged and never parked: binding it would
   * put a subagent's id on the parent's pane. */
  if (link?.kind === "parent") {
    console.log(`[announce] child session ${sessionId} (parent ${link.from ?? "?"}): not a pane`);
    return { ok: true, parked: false };
  }
  /* Resolved NOW, while the hook still blocks on this response and its
   * ancestor chain is alive. After the hook exits only the agent pid survives
   * in the process table, which is why it is the parking key. */
  let agentPid: number | null = null;
  let nested = false;
  if (deps.resolveAgentChain) {
    ({ agentPid, nested } = await deps.resolveAgentChain(pid).catch(() => ({ agentPid: null, nested: false })));
  } else if (deps.resolveAgentPid) {
    agentPid = await deps.resolveAgentPid(pid).catch(() => null);
  } else {
    ({ agentPid, nested } = await resolveAgentChain(pid).catch(() => ({ agentPid: null, nested: false })));
  }
  if (nested) {
    /* A nested claude inherits HERDR_PANE_ID / TMUX_PANE from the pane owner;
     * binding on those witnesses would re-key the pane to the child session.
     * Its own pid still parks (and expires unmatched), same as a `claude -p`. */
    console.log(`[announce] nested agent announce (session ${sessionId}, pid ${pid}): witnesses stripped`);
    herdrPane = null;
    tmuxPane = null;
  }
  const a: PendingAnnounce = {
    sessionId, pid, agentPid, herdrPane, tmuxPane, cwd, harness, link, at: (deps.now ?? Date.now)(),
  };
  // one parking slot per announcer: a re-announce (UserPromptSubmit belt and
  // braces) replaces its own earlier parking rather than queueing behind it
  for (let i = pending.length - 1; i >= 0; i--) {
    const p = pending[i];
    if (p.pid === a.pid || (a.agentPid !== null && p.agentPid === a.agentPid)) pending.splice(i, 1);
  }
  pending.push(a);
  console.log(`[announce] session ${sessionId} pid ${pid}` +
    `${agentPid !== null ? ` (agent pid ${agentPid})` : ""}` +
    `${herdrPane ? ` herdr-pane ${herdrPane}` : ""}${tmuxPane ? ` tmux-pane ${tmuxPane}` : ""}` +
    `${harness ? ` ${harness}` : ""}${link ? ` link ${link.kind}${link.from ? ` from ${link.from}` : ""}` : ""}`);
  for (const cb of [...listeners]) {
    try { cb(); } catch (e) { console.error("[announce] listener threw:", e); }
  }
  return { ok: true, parked: true };
}

/** Walk UP from `pid` through ppid links (one fresh `ps`) and answer the
 *  nearest ancestor -- pid itself included -- that is a known agent process.
 *  That is the claude the announcing hook ran inside: the hook's own python
 *  and the `sh -c` between it and claude both die with the hook, so the agent
 *  pid is the durable half of the chain. */
export async function resolveAgentPid(pid: number): Promise<number | null> {
  return (await resolveAgentChain(pid)).agentPid;
}

/** Same one-`ps` walk, but the whole chain: the nearest agent ancestor, plus
 *  whether ANOTHER agent process sits above it (announcer is a NESTED agent,
 *  a claude spawned inside a claude; its inherited pane witnesses are lies). */
export async function resolveAgentChain(pid: number): Promise<{ agentPid: number | null; nested: boolean }> {
  let out = "";
  try {
    const proc = Bun.spawn(["ps", "-axo", "pid=,ppid=,comm=,args="], { stdout: "pipe", stderr: "ignore" });
    out = await new Response(proc.stdout).text();
    if ((await proc.exited) !== 0) return { agentPid: null, nested: false };
  } catch {
    return { agentPid: null, nested: false };
  }
  const byPid = new Map<number, { ppid: number; comm: string; args: string }>();
  for (const line of out.split("\n")) {
    const m = line.trim().match(/^(\d+)\s+(\d+)\s+(\S+)(?:\s+(.*))?$/);
    if (!m) continue;
    byPid.set(Number(m[1]), { ppid: Number(m[2]), comm: m[3], args: (m[4] ?? "").trim() });
  }
  let agentPid: number | null = null;
  let nested = false;
  let cur: number | undefined = pid;
  for (let depth = 0; depth < 64 && cur !== undefined && cur > 1; depth++) {
    const node = byPid.get(cur);
    if (!node) break;
    if (agentIdOfProc(node.comm, node.args, () => resolveProcExe(cur!))) {
      if (agentPid === null) agentPid = cur;
      else { nested = true; break; }
    }
    cur = node.ppid;
  }
  return { agentPid, nested };
}

/** TEST ONLY: forget every parked announce, bind and listener, so one test's
 *  identity cannot leak into the next. The persisted file is re-read lazily
 *  after this, so a test that re-points CYC_DATA_DIR gets a fresh store. */
export function resetHookAnnounce(): void {
  pending.length = 0;
  liveModels = null;
  binds = null;
  listeners.length = 0;
}
