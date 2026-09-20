#!/usr/bin/env bun
/* CallYourCode output MCP: the thin doorway between one Claude session and
 * the agent engine. Deliberately minimal so it (almost) never changes -- MCP
 * processes are spawned per session and run the code they were born with, so
 * every line here is a line that can go stale in a running session.
 *
 * It does exactly three things:
 *   1. identity: HERDR_PANE_ID (or VOICE_SESSION_ID). No fallback identity:
 *      an unidentifiable session cannot be routed to, so the tools say so
 *      instead of registering as garbage.
 *   2. STATELESS loopback HTTP to the agent engine: no persistent socket, no
 *      register, no reconnect. Each tool call is ONE POST to /agent/reply
 *      (or /agent/info) naming this session's pane, and the HTTP response IS
 *      the ack. An engine restart cannot strand this process: the very next
 *      POST just reaches the fresh engine. The old persistent /ws register
 *      broke delivery on every restart (a socket left holding a raw pane id
 *      with no session), which is the whole reason this is stateless now.
 *   3. the output tools: POST {pane, kind:"speak"|"chat"|"show", ...} to the
 *      engine, which does all the real work (TTS, caching, routing, chat log)
 *      and answers with the ack. Each POST carries CHANNELS so the engine still
 *      knows what this build can deliver without a register frame. Plus one
 *      question, `info`: ask the engine who the agent on this pane IS (its
 *      stable agent id), so cyc commands get the id explicitly, not from env.
 *
 * The tool SET is fixed at every reply level, on purpose. ListTools is
 * answered once at startup, so anything encoded in the tool list becomes a
 * restart-only setting, and the reply level is a control the user swipes.
 * Which channel to use for a given reply rides on the delivered message
 * instead (agent-engine REPLY_LEVELS).
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { randomUUID } from 'crypto'
import { basename } from 'path'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { resolvePaneId, defaultProcResolver } from './paneid.js'

/* WHERE THE ENGINE IS (one engine identity, item 2). CYC_ENGINE_URL is the
 * canonical knob: "unix:/abs/path.sock" (an http-over-unix socket, a leading ~
 * expanded) or "http://host:port". The old VOICE_ENGINE_URL (a ws:// url) and
 * its VOICE_ENGINE_HTTP_URL override stay as a DEPRECATED fallback for bundle
 * skew -- an old harness config still on the wire -- with a one-time stderr
 * warning. When nothing is set, the local unix socket is preferred if it
 * exists, else the loopback TCP default.
 *
 * This is an INLINE twin of shared/engine-url.ts (resolveEngine), on purpose:
 * the MCP is a separate, dependency-light package that typechecks under
 * nodenext, so it keeps its own tiny copy rather than reach across packages.
 * There is NO ws leg any more -- delivery is stateless HTTP (see the file
 * header) -- so nothing here dials ws; VOICE_ENGINE_URL is only parsed to
 * derive an http base for the deprecated fallback. */
type EngineTarget = { kind: 'unix'; path: string } | { kind: 'tcp'; origin: string }

function engineHome(): string {
  const h = process.env.HOME
  return h && h.trim() ? h : homedir()
}
function expandTilde(p: string): string {
  if (p === '~') return engineHome()
  if (p.startsWith('~/')) return join(engineHome(), p.slice(2))
  return p
}
/* AGENT_PORT the way shared/ports.ts resolves it (inline twin, nodenext): an
 * explicit AGENT_PORT wins, else CYC_PORT_BASE+1, else 10101. The MCP needs it
 * for BOTH the socket name (below) and the TCP loopback default, so an
 * offset-port instance reaches its OWN engine instead of the default 10101. */
function agentPort(): number {
  const finite = (v: string | undefined): number | null => {
    if (v === undefined || v.trim() === '') return null
    const n = Number(v)
    return Number.isFinite(n) ? n : null
  }
  const own = finite(process.env.AGENT_PORT)
  if (own !== null) return own
  const base = finite(process.env.CYC_PORT_BASE)
  if (base !== null) return base + 1
  return 10101
}
function defaultSock(): string {
  const override = process.env.CYC_ENGINE_SOCK
  if (override && override.trim()) return expandTilde(override.trim())
  const dataEnv = process.env.CYC_DATA_DIR
  const base =
    dataEnv && dataEnv.trim() ? dataEnv.trim().replace(/\/+$/, '') : join(engineHome(), '.callyourcode')
  // engine.sock for the default engine, engine-<port>.sock for an offset
  // instance -- must match shared/engine-url.ts defaultSockPath so the MCP
  // reaches the socket the engine actually bound.
  const port = agentPort()
  return join(base, port === 10101 ? 'engine.sock' : `engine-${port}.sock`)
}
let warnedDeprecated = false
function warnDeprecatedOnce(): void {
  if (warnedDeprecated) return
  warnedDeprecated = true
  console.error('[cyc] VOICE_ENGINE_URL is deprecated; set CYC_ENGINE_URL')
}
function resolveEngineTarget(): EngineTarget {
  const canonical = process.env.CYC_ENGINE_URL?.trim()
  if (canonical) {
    if (canonical.startsWith('unix:')) {
      return { kind: 'unix', path: expandTilde(canonical.slice('unix:'.length)) }
    }
    return { kind: 'tcp', origin: new URL(canonical).origin }
  }
  const httpOverride = process.env.VOICE_ENGINE_HTTP_URL?.trim()
  const voice = process.env.VOICE_ENGINE_URL?.trim()
  if (httpOverride || voice) {
    warnDeprecatedOnce()
    if (httpOverride) return { kind: 'tcp', origin: httpOverride.replace(/\/+$/, '') }
    try {
      const u = new URL(voice as string)
      u.protocol = u.protocol === 'wss:' ? 'https:' : 'http:'
      u.pathname = ''
      u.search = ''
      return { kind: 'tcp', origin: u.toString().replace(/\/+$/, '') }
    } catch {
      return { kind: 'tcp', origin: 'http://127.0.0.1:10101' }
    }
  }
  const sock = defaultSock()
  if (existsSync(sock)) return { kind: 'unix', path: sock }
  return { kind: 'tcp', origin: `http://127.0.0.1:${agentPort()}` }
}
const ENGINE_TARGET = resolveEngineTarget()
const ENGINE_LABEL = ENGINE_TARGET.kind === 'unix' ? `unix:${ENGINE_TARGET.path}` : ENGINE_TARGET.origin
const REPLY_PATH = '/agent/reply'
const INFO_PATH = '/agent/info'
function engineFetch(path: string, init: RequestInit): Promise<Response> {
  if (ENGINE_TARGET.kind === 'unix') {
    return fetch(`http://localhost${path}`, { ...init, unix: ENGINE_TARGET.path } as RequestInit & { unix: string })
  }
  return fetch(ENGINE_TARGET.origin + path, init)
}
/* WHO THIS SESSION IS, to the engine. The engine keys a session by its live
 * pane id (server.ts sessionByPane), so the MCP registers with the pane it runs
 * in. herdr stamps HERDR_PANE_ID; plain tmux stamps TMUX_PANE (`%N`) into every
 * pane's environment, which is the same id TmuxMux reports for the pane, so it
 * resolves the same way (#480). VOICE_SESSION_ID stays the explicit
 * override between them. No fallback identity: an unidentifiable session cannot
 * be routed to.
 *
 * OWN ENV FIRST, unchanged. But some harnesses (codex) launch this MCP with a
 * SCRUBBED env while THEIR OWN process still carries the pane id, so when our
 * env yields nothing we walk up the ancestry and recover it from the harness
 * (paneid.ts). Every session that already stamps the id behaves exactly as
 * before; the walk-up is a pure fallback. */
const SESSION_ID = resolvePaneId(process.env, defaultProcResolver, process.ppid)

/* THE MCP TEXT THAT TELLS THE AGENT HOW TO SCHEDULE MESSAGES TO ITSELF (task
 * 357), so the user can just ask this session to set up a reminder instead of
 * opening the app's settings. Short on purpose: the exact CLI shapes, nothing
 * more. Only added to the instructions when this session has an id, since
 * scheduling is per-session. Scheduling lives in the crons plugin, driven from
 * the session's own shell as `cyc plugin crons <op> [json-args]`; the engine's
 * old schedule HTTP routes are gone (crons plugin). */
const SCHEDULE_INSTRUCTIONS = [
  `You run inside CallYourCode, and this session can schedule messages to itself (reminders, or anything on a time or a repeat) through its own CLI. When the user asks you to remind them, or to do something on a schedule, set it up yourself with these commands rather than telling them to open settings. First call this server's info tool to get your agent id; every cyc plugin command names the agent it acts for with --session <agentId>.`,
  `- See what is scheduled: cyc plugin crons list --session <agentId>  (each entry has an id)`,
  `- Repeat (a cron): cyc plugin crons create '{"kind":"repeat","name":"morning-plan","body":"plan the day","cron":"0 9 * * *"}' --session <agentId>  (every hour is "0 * * * *"; add "tz":"Area/City" or omit for the host's zone)`,
  `- One-off: cyc plugin crons create '{"kind":"once","name":"call mum","body":"ring her","at":<epoch ms>}' --session <agentId>`,
  `- Pause, resume or edit one: cyc plugin crons update '{"id":"<id>","enabled":false}' --session <agentId>  (the id comes back from create and from list; enabled, name, body, cron, at and tz can all be patched). Delete one: cyc plugin crons remove '{"id":"<id>"}' --session <agentId>`,
  `- Preview a cron before saving: cyc plugin crons preview '{"cron":"0 9 * * *"}' --session <agentId>`,
].join('\n')
const SESSION_NAME = basename(process.cwd())
/* HOW LONG A speak/chat/show POST WAITS FOR THE ENGINE TO CONFIRM (#447).
 *
 * The response to the POST IS the ack (the engine has logged the message), so
 * this is the one timeout the tool has. A dead engine -- nothing listening --
 * is refused at connect and fails immediately; this bound only bites when the
 * engine accepts the connection but wedges before answering, and a healthy ack
 * lands only after the row write, which is fast. On timeout the fetch is
 * aborted and the tool errors NAMING THE RETRY, so the Stop hook re-sends
 * rather than losing the reply.
 *
 * The env override exists so a test can prove the BOUND without spending it;
 * nothing but a test sets it, so production waits exactly what it always did. */
const CONFIRM_MS = Number(process.env.CYC_MCP_CONFIRM_MS) || 15_000

/* What this build can deliver, sent on every reply POST. A session started
 * before `chat` existed keeps running its old code and will never list it,
 * which is how the engine knows not to ask that session for a written reply.
 * Keep it in the same order as ListTools. */
const CHANNELS = ['speak', 'chat', 'show'] as const

let shuttingDown = false

function log(msg: string): void {
  process.stderr.write(`callyourcode mcp: ${msg}\n`) // stdout is the MCP transport
}
process.on('unhandledRejection', (err) => log(`unhandled rejection: ${err}`))
process.on('uncaughtException', (err) => log(`uncaught exception: ${err}`))

// ------------------------------------------------------- the loopback POST

/* ONE POST, and its JSON body is the ack. `signal` aborts a wedged engine at
 * CONFIRM_MS; a dead engine (nothing listening) rejects at connect, faster. A
 * non-2xx is a transport failure, not an ack, so it throws like a connect error
 * -- the caller turns either into a "retry the tool call" the Stop hook acts on.
 * The engine answers HTTP 200 for BOTH a live session and a not-yet-registered
 * one (ok:false), so 200 always carries a real ack to hand back. */
async function postJson(path: string, body: unknown): Promise<any> {
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), CONFIRM_MS)
  ;(timer as any).unref?.()
  try {
    const res = await engineFetch(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: ctl.signal,
    })
    if (!res.ok) throw new Error(`the engine answered HTTP ${res.status}`)
    return await res.json()
  } finally {
    clearTimeout(timer)
  }
}

/* THE IDEMPOTENCY KEYS of the utterances still awaiting confirmation (#505).
 * speak/chat are at-least-once: a slow ack (the engine's ack lands only after
 * TTS, which outran the 15s wait on a busy box) errors the tool with "Retry the
 * tool call", the agent calls again, and the first delivery ALSO lands -- so the
 * engine logged one reply twice. The fix: mint ONE key per logical utterance and
 * REUSE it on the retry, so the engine records the first arrival and dedupes the
 * rest. A retry is the SAME tool call with the SAME text after a failure, so an
 * unconfirmed text -> key is kept here and reused when that text comes back; the
 * entry is dropped once the engine confirms, so the next identical text is a NEW
 * utterance with a NEW key.
 *
 * A MAP, NOT ONE SLOT (round 2). A single slot lost its key the moment a
 * DIFFERENT text passed through between an original delivery and its retry --
 * exactly the "both" reply, where the agent sends a short spoken line AND a
 * written one in the same turn (or as parallel tool calls). The other text
 * overwrote or cleared the slot, the retry minted a fresh key, and the engine
 * recorded a second copy: the very duplicate #505 kills. Holding one entry per
 * in-flight text lets each retry find its own key. Bounded to a handful, since a
 * turn has at most a couple of unconfirmed replies at once; the oldest is
 * evicted so a stuck entry cannot grow the map without bound.
 *
 * If THIS process dies between attempts the map is gone and that rare case may
 * still duplicate (accepted, #505: one mechanism, no more). */
const UNCONFIRMED_MAX = 8
const unconfirmed = new Map<string, string>() // text -> idempotency key

if (SESSION_ID) log(`ready as ${SESSION_ID} (${SESSION_NAME}); delivering to ${ENGINE_LABEL}`)
else log('no HERDR_PANE_ID/VOICE_SESSION_ID/TMUX_PANE: the output tools will be unavailable')

// ------------------------------------------------------------ mcp server

const mcp = new Server(
  /* Server key `callyourcode` (task 593; was `voice`). Harness tool names
   * derive from it, so a reconnected session calls mcp__callyourcode__speak;
   * sessions running the old process keep mcp__voice__* until they restart,
   * and the engine accepts both (session-events.ts). */
  { name: 'callyourcode', version: '2.0.0' },
  {
    capabilities: { tools: {} },
    instructions: [
      'Messages from the user arrive as ordinary terminal input prefixed "VOICE:" (they spoke it) or "TEXT:" (they typed it). Either way they are in the CallYourCode app on a phone or a tablet, not at this terminal.',
      '',
      "So the terminal is not a reply. Whatever you type there, the user never sees it. Reaching them takes one of this server's tools: speak for something to hear, chat for something to read, show for a file, a diff or an image.",
      '',
      'Every delivered message ends with a short note saying how the user wants that particular reply: as speech, as text, or both. Follow it, and call the tool it names. If a reply ends with no output tool call at all, the user got nothing.',
      '',
      'Speech is short and conversational: no markdown, no code blocks, no file paths read aloud, numbers and names said the way a person says them. The user can cut you off mid-sentence, so lead with the answer.',
      ...(SESSION_ID ? ['', SCHEDULE_INSTRUCTIONS] : []),
    ].join('\n'),
  },
)

const SHOW_DESCRIPTION = [
  'Display a file in the CallYourCode app. Use this instead of reading file contents aloud or pasting them into chat.',
  '',
  'Images appear in the chat itself. Short markdown or diffs appear inline; longer ones become a card that opens a formatted page or a diff viewer.',
  '',
  'An .html file becomes a full-screen interactive page: it runs its own scripts, can send data back (cyc.submit) and keep state (cyc.save / cyc.load). Anything fits in one page: a question round, an editable task list, a log viewer, a chart, a step-through. Look at a working example in callyourcode/engine/mcp/examples/ and adapt.',
  '',
  'Hard limits, all enforced: the page is sandboxed on an opaque origin; it cannot reach the app or engine; alert/confirm/prompt do not exist; https CDNs work, plain http and ws do not; 1MB max or nothing shows; submit bodies 64KB, saved state 256KB; the viewer sets data-cyc-theme="dark|light" on <html>; assume a phone-sized touch screen.',
].join('\n')

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'speak',
      description:
        'Say something out loud to the user. This gets TTS output and is the only way they hear you. Keep it short and conversational: no markdown, no code blocks, no file paths.',
      inputSchema: {
        type: 'object',
        properties: {
          text: { type: 'string', description: 'What to say, as plain spoken prose.' },
        },
        required: ['text'],
      },
    },
    {
      name: 'chat',
      description:
        'Send a written reply to the user, as a message in the CallYourCode chat. Write it as a message rather than as terminal output. Light markdown is fine, for a file, charts or interactive html or a long formatted document use the show tool instead.',
      inputSchema: {
        type: 'object',
        properties: {
          text: { type: 'string', description: 'The written reply.' },
        },
        required: ['text'],
      },
    },
    {
      name: 'show',
      description: SHOW_DESCRIPTION,
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Absolute path of the file to display.' },
        },
        required: ['path'],
      },
    },
    /* Not in CHANNELS: info is a question to the engine, not a way to deliver
     * anything to the user. The engine resolves WHO this connection is from its
     * registered pane, so the answer is right even when this process's env
     * carries no agent identity at all (hand-started panes). */
    {
      name: 'info',
      description:
        "Get this agent's identity from the engine: agentId (the stable ag-... id every cyc command takes), name, cwd and harness. Call it whenever a cyc command needs your own agent id, and pass that id explicitly.",
      inputSchema: { type: 'object', properties: {} },
    },
  ],
}))

mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
  if (req.params.name === 'show') return handleShow(req.params.arguments as any)
  if (req.params.name === 'info') return handleInfo()
  if (req.params.name === 'speak' || req.params.name === 'chat') {
    return handleSay(req.params.name, req.params.arguments as any)
  }
  return { content: [{ type: 'text', text: `unknown tool: ${req.params.name}` }], isError: true }
})

/* speak and chat are the same message on the same POST; the engine decides what
 * happens to it (TTS for one, not for the other). Kept as one function so the
 * two channels cannot drift apart down here. */
async function handleSay(kind: 'speak' | 'chat', args: any) {
  const unreachable = kind === 'speak' ? 'the user cannot hear you' : 'the user cannot read you'
  try {
    const text = String(args?.text ?? '').trim()
    if (!text) throw new Error('text is empty, there is nothing to send')
    if (!SESSION_ID) {
      throw new Error(
        'this session has no HERDR_PANE_ID, so the engine cannot route to it. Answer in the terminal instead.',
      )
    }
    /* Reuse this text's unconfirmed key when this is its retry; otherwise this
     * is a new utterance, so mint a key, remember it, and evict the oldest so
     * the map stays bounded (#505). Keyed per text, so a different reply in the
     * same turn cannot take this one's key. */
    let key = unconfirmed.get(text)
    if (!key) {
      key = randomUUID()
      unconfirmed.set(text, key)
      while (unconfirmed.size > UNCONFIRMED_MAX) {
        unconfirmed.delete(unconfirmed.keys().next().value as string)
      }
    }
    const msgId = randomUUID()
    /* POST AND WAIT FOR THE ENGINE TO CONFIRM IT LOGGED THIS (#447). The HTTP
     * response IS the ack: success means the engine has the message in its chat
     * log. A refused/wedged/erroring engine throws below and the tool tells the
     * agent to retry, so the Stop hook re-sends rather than dropping the reply. */
    let m: any
    try {
      m = await postJson(REPLY_PATH, {
        pane: SESSION_ID,
        kind,
        text,
        msgId,
        key,
        channels: CHANNELS,
      })
    } catch (err) {
      const why =
        (err as any)?.name === 'AbortError'
          ? `agent engine did not confirm within ${CONFIRM_MS / 1000}s, so ${unreachable}. Retry the tool call.`
          : `agent engine unreachable at ${ENGINE_LABEL}${REPLY_PATH}, so ${unreachable}. Retry the tool call.`
      throw new Error(why)
    }
    if (!m?.ok) {
      // The entry stays in `unconfirmed` on purpose: the agent's retry reuses
      // this key, so the engine dedupes it against whichever attempt did land
      // (#505).
      throw new Error(`${m?.message || 'the engine rejected the message'}. Retry the tool call.`)
    }
    // Confirmed: this utterance is done, so the next identical text is new.
    unconfirmed.delete(text)
    return {
      content: [
        {
          type: 'text',
          text: `${kind === 'speak' ? 'spoke' : 'sent to the chat'} (msgId: ${msgId})`,
        },
      ],
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return { content: [{ type: 'text', text: `${kind} failed: ${msg}` }], isError: true }
  }
}

/* WHO AM I, answered by the engine, never by env. The engine keys the POSTed
 * pane to a session, the session to the stable agent id -- so the answer is
 * right even for a hand-started pane whose env was never stamped with an agent
 * id. The agent passes the returned agentId explicitly to every cyc command. */
async function handleInfo() {
  try {
    if (!SESSION_ID) {
      throw new Error('this session has no HERDR_PANE_ID, so the engine cannot identify it.')
    }
    let m: any
    try {
      m = await postJson(INFO_PATH, { pane: SESSION_ID })
    } catch {
      throw new Error(`agent engine unreachable at ${ENGINE_LABEL}${INFO_PATH}.`)
    }
    if (!m.ok) throw new Error(m.message)
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            agentId: m.agentId,
            name: m.name,
            cwd: m.cwd,
            harness: m.harness,
          }),
        },
      ],
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return { content: [{ type: 'text', text: `info failed: ${msg}` }], isError: true }
  }
}

async function handleShow(args: any) {
  try {
    const path = String(args?.path ?? '').trim()
    if (!path) throw new Error('path is empty')
    if (!SESSION_ID) {
      throw new Error('this session has no HERDR_PANE_ID, so the engine cannot route to it.')
    }
    let m: any
    try {
      m = await postJson(REPLY_PATH, { pane: SESSION_ID, kind: 'show', path, channels: CHANNELS })
    } catch {
      throw new Error(`agent engine unreachable at ${ENGINE_LABEL}${REPLY_PATH}.`)
    }
    if (!m.ok) throw new Error(m.message)
    return { content: [{ type: 'text', text: `${m.message}: ${path}` }] }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return { content: [{ type: 'text', text: `show failed: ${msg}` }], isError: true }
  }
}

await mcp.connect(new StdioServerTransport())

function shutdown(): void {
  if (shuttingDown) return
  shuttingDown = true
  process.exit(0)
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
