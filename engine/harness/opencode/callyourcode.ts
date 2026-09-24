/* CallYourCode opencode plugin: the two claude hooks, ported to opencode's
 * real extension surface (verified against opencode 1.18.19 on this box).
 *
 * Piece 1, "tool.execute.before" == claude's PreToolUse bash guard
 * (hooks/enforce-bash-async.py). opencode's `bash` tool takes
 * {command, timeout?, workdir?} and has NO run_in_background parameter, so
 * that arm of the contract does not exist here. What survives:
 *   timeout set and <= 60000 ms  -> allow
 *   setsid / nohup / shell `&`   -> block (nothing wakes the agent)
 *   otherwise                    -> block, ask for a capped timeout
 * Long jobs: write output to a file and poll it in short calls. Blocking is
 * done by throwing; opencode feeds the message back to the model.
 *
 * Piece 2, event "session.idle" == claude's Stop hook
 * (hooks/enforce-voice-reply.py). opencode has no blocking Stop hook, so the
 * nearest real mechanism is: when the session goes idle, judge the engine's
 * reply-state exactly the way the claude hook does, and if the turn owed the
 * user a reply that never went out, inject the same nudge as a follow-up
 * prompt. The hook is DUMB, matching the claude one: did ANY reply reach the
 * user after a delivery this turn? No level, no channel demand. Contract:
 *   - engine state in <dataDir>/state/reply-state.json, acks in
 *     <dataDir>/state/reply-acks/<pane>.json. The data dir is CYC_DATA_DIR or
 *     ~/.callyourcode, resolved at RUNTIME from env, agreeing with the claude
 *     hook (hooks/enforce-voice-reply.py:68-70) and the engine's write
 *     (agent-engine/src/chat/reply-trace.ts:96). CYC_STATE_DIR pins the state dir
 *     directly for tests, which must never touch the running engine's state.
 *   - session identified by HERDR_PANE_ID / VOICE_SESSION_ID / TMUX_PANE,
 *     falling back to a UNIQUE cwd match
 *   - any output channel (speak/chat/show) counts; which one is not read
 *   - a delivery is judged exactly once (ack watermark written before the
 *     verdict), never older than 1 h
 *   - every error path does nothing (fails open)
 */

import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

const MARKER = "[enforce-voice-reply]"
const MAX_TIMEOUT_MS = 60_000
const STALE_AFTER_MS = 60 * 60 * 1000

// Mirror of hooks/enforce-voice-reply.py:68-70, same precedence: the state dir
// is CYC_STATE_DIR, else <CYC_DATA_DIR || ~/.callyourcode>/state. Resolved per
// call so a test can point the env at its own tree after import.
const DATA_DIR = () => process.env.CYC_DATA_DIR || path.join(os.homedir(), ".callyourcode")
const STATE_DIR = () => process.env.CYC_STATE_DIR || path.join(DATA_DIR(), "state")
const STATE_FILE = () => path.join(STATE_DIR(), "reply-state.json")
const ACK_DIR = () => path.join(STATE_DIR(), "reply-acks")

const DETACH_RE = /(?<![\w./-])(setsid|nohup)(?![\w-])/i

/* Port of enforce-bash-async.py has_background_amp: an unquoted `&` that is
 * not `&&` and not part of a redirect (`&>`, `>&`, `2>&1`) backgrounds the
 * job behind the harness's back. Quoting and escaping respected. */
function hasBackgroundAmp(cmd: string): boolean {
  let i = 0
  const n = cmd.length
  let quote: string | null = null
  while (i < n) {
    const c = cmd[i]
    if (quote) {
      if (c === "\\" && quote === '"') { i += 2; continue }
      if (c === quote) quote = null
      i += 1
      continue
    }
    if (c === "\\") { i += 2; continue }
    if (c === "'" || c === '"') { quote = c; i += 1; continue }
    if (c === "&") {
      if (i + 1 < n && cmd[i + 1] === "&") { i += 2; continue }
      if (i + 1 < n && cmd[i + 1] === ">") { i += 2; continue }
      const prev = i > 0 ? cmd[i - 1] : ""
      if (prev === ">") { i += 1; continue }
      return true
    }
    i += 1
  }
  return false
}

/* The bash-guard verdict: null means allow, a string is the block reason.
 * Reachable for tests via CallYourCode.testables (see file end). */
function bashGuardReason(args: unknown): string | null {
  if (typeof args !== "object" || args === null) return null
  const a = args as Record<string, unknown>
  const command = a.command
  if (typeof command !== "string" || !command.trim()) return null

  const m = DETACH_RE.exec(command)
  if (m) {
    return (
      `BLOCKED: \`${m[1]}\` detaches the process, so nothing wakes you when it finishes ` +
      "and the user hears silence. Drop it and re-run with a timeout <= 60000 ms; for a " +
      "long job, redirect its output to a file and poll that file in short commands."
    )
  }
  if (hasBackgroundAmp(command)) {
    return (
      "BLOCKED: a shell `&` backgrounds the job behind the harness's back, so nothing " +
      "wakes you when it finishes. Remove the `&` and give the command a timeout <= 60000 ms " +
      "(quote the argument if the `&` was meant literally, e.g. in a URL); for a long job, " +
      "redirect output to a file and poll it in short commands."
    )
  }

  let timeout = a.timeout
  if (typeof timeout === "string") {
    const parsed = Number.parseFloat(timeout.trim())
    timeout = Number.isNaN(parsed) ? undefined : parsed
  }
  if (typeof timeout === "number" && timeout > 0 && timeout <= MAX_TIMEOUT_MS) return null
  if (typeof timeout === "number" && timeout > MAX_TIMEOUT_MS) {
    return (
      `BLOCKED: timeout ${Math.trunc(timeout)}ms is longer than ${MAX_TIMEOUT_MS}ms. While a ` +
      "foreground command runs you cannot answer the user, and in a voice conversation going " +
      `quiet is indistinguishable from having died. Lower the timeout to <= ${MAX_TIMEOUT_MS}ms; ` +
      "for anything slow (installs, builds, test suites) redirect output to a file and poll it " +
      "in short commands."
    )
  }
  return (
    "BLOCKED: this command has no timeout, so it could hang the conversation for an " +
    "unbounded time, and while it runs you cannot answer the user. Re-run it with " +
    `timeout <= ${MAX_TIMEOUT_MS} (ms); for anything slow (installs, builds, downloads, ` +
    "test suites) redirect output to a file and poll it in short commands."
  )
}

// ---------------------------------------------------------------------------
// Reply-guard: straight port of the enforce-voice-reply.py decision pipeline.

function readJson(file: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(file, "utf-8"))
  } catch {
    return null
  }
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v)
}

function paneId(env: Record<string, string | undefined> = process.env): string | null {
  return env.HERDR_PANE_ID || env.VOICE_SESSION_ID || env.TMUX_PANE || null
}

/* (pane, entry) for this session, or null. An opencode session now announces
 * its own harness session id to the engine (see announceSession below), so a
 * harness session id CAN exist for one; this reply-guard lookup still keys on
 * the pane id with the unique-cwd fallback, ported as-is from the claude hook. */
function findSession(
  state: unknown,
  pane: string | null,
  cwd: string | null,
): [string, Record<string, unknown>] | null {
  if (!isObj(state) || !isObj(state.sessions)) return null
  const live: Record<string, Record<string, unknown>> = {}
  for (const [k, v] of Object.entries(state.sessions)) {
    if (typeof k === "string" && isObj(v)) live[k] = v
  }
  if (pane && live[pane]) return [pane, live[pane]]
  if (cwd) {
    const hits = Object.keys(live).filter((k) => live[k].cwd === cwd)
    if (hits.length === 1) return [hits[0], live[hits[0]]]
  }
  return null
}

function ackPath(pane: string): string {
  const safe = pane.replace(/[^A-Za-z0-9_.-]/g, "_") || "unknown"
  return path.join(ACK_DIR(), safe + ".json")
}

function readAck(pane: string): number {
  const ack = readJson(ackPath(pane))
  if (!isObj(ack)) return 0
  const ts = ack.deliveredThrough
  return typeof ts === "number" ? ts : 0
}

function writeAck(pane: string, ts: number): void {
  try {
    fs.mkdirSync(ACK_DIR(), { recursive: true })
    const final = ackPath(pane)
    const tmp = `${final}.${process.pid}.tmp`
    fs.writeFileSync(tmp, JSON.stringify({ deliveredThrough: ts, at: Date.now() }))
    fs.renameSync(tmp, final)
  } catch {
    /* a failed ack changes no verdict */
  }
}

/* The outstanding delivery timestamps: recorded, not yet judged, not ancient.
 * A dumb list of stamps -- no level, no channel demand, nothing to interpret. */
function outstanding(entry: Record<string, unknown>, ackTs: number, nowMs: number): number[] {
  const out: number[] = []
  const deliveries = Array.isArray(entry.deliveries) ? entry.deliveries : []
  for (const d of deliveries) {
    if (!isObj(d)) continue
    const ts = d.ts
    if (typeof ts !== "number") continue
    if (ts <= ackTs || nowMs - ts > STALE_AFTER_MS) continue
    out.push(ts)
  }
  return out
}

/* Did any reply reach the user at or after `sinceMs`? A reply that went out
 * BEFORE the message arrived answered something else. Which channel it was is
 * not read -- an MCP reply is an MCP reply. */
function repliedSince(entry: Record<string, unknown>, sinceMs: number): boolean {
  const replies = Array.isArray(entry.replies) ? entry.replies : []
  for (const r of replies) {
    if (!isObj(r)) continue
    const ts = r.ts
    if (typeof ts !== "number") continue
    if (ts >= sinceMs) return true
  }
  return false
}

function reasonFor(): string {
  return (
    `${MARKER} MISSED REPLY: you answered into this terminal, and nobody is reading it. ` +
    "The user is in the CallYourCode app on a phone or a tablet; text printed here " +
    "never reaches them, so as far as they can tell you did not answer. Anything that " +
    "reaches them counts: `speak` for something to hear, `chat` for something to read, " +
    "`show` for a file or a diff. Call one now with your answer, then stop."
  )
}

/* The whole judgment as one pure step: null means nothing to do, a string is
 * the nudge to deliver. Acking is the caller's side effect. */
function judge(
  entry: Record<string, unknown>,
  ackTs: number,
  nowMs: number,
): { nudge: string | null; ackThrough: number } | null {
  const pending = outstanding(entry, ackTs, nowMs)
  if (pending.length === 0) return null
  const ackThrough = Math.max(...pending)
  if (repliedSince(entry, Math.min(...pending))) return { nudge: null, ackThrough }
  return { nudge: reasonFor(), ackThrough }
}

// ---------------------------------------------------------------------------
// Session-id announce: tell the engine which pane/pid an opencode session id
// belongs to, so a restart-in-resume can relaunch `opencode --session <id>`
// and the reader can bind the pane to the session and tail its events.
//
// claude announces from its SessionStart/UserPromptSubmit hook and codex from
// config.toml `notify` (engine/hooks/announce-session.py); opencode has no such
// hook, so the plugin's `event` handler is the announce seam. It fires on the
// EARLIEST event that carries a session identity (session.created on a fresh
// run, session.updated on a resume; see the event handler for the verification)
// rather than waiting for session.idle at the end of a turn, so the pane binds
// before the reader would otherwise record a null session id.

const ANNOUNCE_TIMEOUT_MS = 2000

// One announce per opencode session id per plugin process. The engine's
// recordHookBind is idempotent (hook-announce.ts:145-151), so a dropped retry
// is harmless: we mark a sid announced on first attempt and never re-POST it.
const announcedSessions = new Set<string>()

/* POST the session id + pid/pane/cwd witnesses to the engine's announce
 * endpoint, fail-silent: same doctrine as the reply guard below, never throw,
 * never log noisily. Every failure (dead engine, closed port, timeout) is
 * swallowed. Reachable for tests via CallYourCode.testables (see file end).
 *
 * `pid` is this plugin process's own pid. The plugin runs inside opencode's
 * server process, which is opencode's own child in the pane; the engine's
 * announce route walks UP from this pid to the nearest agent process (agents.ts
 * knows `opencode`) and matches that against the pane's detected agent, exactly
 * as it does for the claude hook's pid. `eventName` records which plugin event
 * triggered the announce (observability only; the engine does not read it). */
/* Where this machine's engine listens, found the way the reply tools and the
 * claude hook find it: CYC_ENGINE_URL (http(s):// or unix:<path>), else the
 * local engine socket if it exists, else loopback AGENT_PORT (CYC_PORT_BASE+1,
 * 10101). A hardcoded 10101 sent a second user's stack (engine on 20101) its
 * announces to nobody (2026-09-24, the pi extension had the same bug).
 * Self-contained: opencode loads a copy of this file, so it imports nothing. */
function engineTarget(env: Record<string, string | undefined>): { origin: string; unix?: string } {
  const home = env.HOME || os.homedir()
  const tilde = (p: string) => (p.startsWith("~/") ? path.join(home, p.slice(2)) : p)
  const raw = (env.CYC_ENGINE_URL || "").trim()
  if (raw.startsWith("unix:")) return { origin: "http://localhost", unix: tilde(raw.slice(5)) }
  if (raw) return { origin: new URL(raw).origin }
  const num = (v?: string) => (v && Number.isFinite(Number(v)) ? Number(v) : null)
  const port = num(env.AGENT_PORT) ?? ((num(env.CYC_PORT_BASE) ?? null) !== null ? num(env.CYC_PORT_BASE)! + 1 : 10101)
  const dataDir = (env.CYC_DATA_DIR || "").trim() || path.join(home, ".callyourcode")
  const sock = (env.CYC_ENGINE_SOCK || "").trim()
    ? tilde(env.CYC_ENGINE_SOCK!.trim())
    : path.join(dataDir, port === 10101 ? "engine.sock" : `engine-${port}.sock`)
  if (fs.existsSync(sock)) return { origin: "http://localhost", unix: sock }
  return { origin: `http://127.0.0.1:${port}` }
}

async function announceSession(
  sessionID: string,
  cwd: string | null,
  eventName: string,
  env: Record<string, string | undefined> = process.env,
): Promise<void> {
  try {
    if (!sessionID || announcedSessions.has(sessionID)) return
    announcedSessions.add(sessionID)
    const body = JSON.stringify({
      sessionId: sessionID,
      pid: process.pid,
      cwd: cwd ?? null,
      herdrPane: env.HERDR_PANE_ID ?? null,
      tmuxPane: env.TMUX_PANE ?? null,
      harness: "opencode",
      event: eventName,
    })
    const target = engineTarget(env)
    await fetch(`${target.origin}/harness/announce`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
      signal: AbortSignal.timeout(ANNOUNCE_TIMEOUT_MS),
      ...(target.unix ? { unix: target.unix } : {}),
    } as RequestInit)
  } catch {
    /* fails silent, always */
  }
}

// ---------------------------------------------------------------------------
// The plugin. Input shape verified by a probe plugin on this box:
// { client, project, worktree, directory, experimental_workspace, serverUrl, $ }

export const CallYourCode = async ({ client, directory }: any) => {
  return {
    "tool.execute.before": async (input: any, output: any) => {
      let reason: string | null = null
      try {
        if (!input || input.tool !== "bash") return
        reason = bashGuardReason(output?.args)
      } catch {
        return // a bug in the guard must never trap a session
      }
      if (reason) throw new Error(reason)
    },

    event: async ({ event }: any) => {
      try {
        if (!event) return
        const type = event.type

        // EARLIEST announce. Verified against opencode 1.18.19 (probe plugin,
        // real event stream): on a fresh run `session.created` is the FIRST
        // event carrying a session identity; on a `--session <id>` resume
        // `session.created` does not fire and `session.updated` is the first
        // event (both precede `session.idle`, which only fires once the turn
        // completes). Both carry the full Session in `properties.info`, so the
        // session id AND the subagent parent are known inline with no client
        // round-trip. Announcing on both binds the pane as early as the event
        // surface allows, in every launch path; announceSession is idempotent
        // (once per id), so the flood of later `session.updated`s is a no-op.
        if (type === "session.created" || type === "session.updated") {
          const info = event.properties?.info
          const sessionID = info?.id
          if (!sessionID) return
          // A subagent session carries a parentID (a `ses_` id). Never announce
          // it: binding it would put a child's id on the parent's pane. Read
          // inline from the Session, so no client call is needed on this lane.
          if (info.parentID || info.parentId) return
          void announceSession(sessionID, directory ?? null, type)
          return
        }

        if (type !== "session.idle") return
        const sessionID = event.properties?.sessionID
        if (!sessionID) return

        // Subagent turns are not the conversation; skip sessions with a parent.
        // session.idle carries only the id, so classify via the client (the
        // announcedSessions guard means the eager created/updated lane usually
        // already bound this id and the reply guard is all that is left here).
        try {
          const got = await client.session.get({ sessionID })
          const info = got?.data ?? got
          if (info && (info.parentID || info.parentId)) return
        } catch {
          /* cannot classify: treat as top-level, same as the claude hook
           * judging a session it CAN identify */
        }

        // Tell the engine this pane owns sessionID (fire-and-forget, fail
        // silent). Belt-and-braces behind the created/updated lane: heals an
        // engine that was down when the earlier events fired.
        void announceSession(sessionID, directory ?? null, "session.idle")

        const state = readJson(STATE_FILE())
        if (state === null) return // no engine: nothing to enforce
        const found = findSession(state, paneId(), directory ?? null)
        if (!found) return // not a session the engine knows
        const [pane, entry] = found

        const verdict = judge(entry, readAck(pane), Date.now())
        if (!verdict) return
        // Judged now, once, whatever the verdict.
        writeAck(pane, verdict.ackThrough)
        if (!verdict.nudge) return

        await client.session.prompt({
          sessionID,
          parts: [{ type: "text", text: verdict.nudge }],
        })
      } catch {
        /* fails open, always */
      }
    },
  }
}

/* Test access. A property on the factory, NOT extra module exports: opencode
 * invokes every export of a plugin file as a plugin factory, so helper
 * exports would break loading (observed live: the loader awaits each export
 * and expects a hooks object back). */
;(CallYourCode as any).testables = {
  hasBackgroundAmp,
  bashGuardReason,
  paneId,
  findSession,
  outstanding,
  repliedSince,
  reasonFor,
  judge,
  announceSession,
  engineTarget,
  announcedSessions,
  STATE_FILE,
  ACK_DIR,
}
