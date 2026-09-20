/* The opencode plugin's session-id announce.
 *
 * Hermetic, no product boot: the announce POSTs to a local Bun.serve on a
 * random port with AGENT_PORT pointed at it. Proves the once-per-sid guard,
 * the POST body, the parentID skip (through the real event handler), and the
 * fail-silent behaviour on a dead port. Drives CallYourCode.testables. */

import { afterEach, expect, test } from "bun:test"
import { CallYourCode } from "./callyourcode.ts"

const t = (CallYourCode as any).testables as {
  announceSession: (
    sessionID: string,
    cwd: string | null,
    eventName: string,
    env?: Record<string, string | undefined>,
  ) => Promise<void>
  announcedSessions: Set<string>
}

type Captured = { path: string; body: any }

// A capturing announce endpoint on a random free port. Returns the port and
// the list of bodies it received; stop() shuts it down.
function serveCapture() {
  const captured: Captured[] = []
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url)
      let body: any = null
      try {
        body = await req.json()
      } catch {
        body = null
      }
      captured.push({ path: url.pathname, body })
      return new Response("ok")
    },
  })
  return { port: server.port, captured, stop: () => server.stop(true) }
}

afterEach(() => {
  // The once-per-sid guard is module-level; clear it so each test starts fresh.
  t.announcedSessions.clear()
})

test("exactly one POST per session id, with the contract body", async () => {
  const s = serveCapture()
  const env = {
    AGENT_PORT: String(s.port),
    HERDR_PANE_ID: "w1:p3",
    TMUX_PANE: "%7",
  }
  try {
    await t.announceSession("ses_one", "/home/me/proj", "session.created", env)
    // A second call with the same sid must not POST again, even from a later
    // event: the announce is idempotent per session id for the plugin's life.
    await t.announceSession("ses_one", "/home/me/proj", "session.updated", env)
  } finally {
    s.stop()
  }

  expect(s.captured.length).toBe(1)
  const req = s.captured[0]
  expect(req.path).toBe("/harness/announce")
  expect(req.body).toMatchObject({
    sessionId: "ses_one",
    pid: process.pid,
    cwd: "/home/me/proj",
    herdrPane: "w1:p3",
    tmuxPane: "%7",
    harness: "opencode",
    event: "session.created",
  })
})

test("witnesses fall back to null when the env is bare", async () => {
  const s = serveCapture()
  const env = { AGENT_PORT: String(s.port) }
  try {
    await t.announceSession("ses_bare", null, "session.created", env)
  } finally {
    s.stop()
  }
  expect(s.captured.length).toBe(1)
  expect(s.captured[0].body).toMatchObject({
    sessionId: "ses_bare",
    cwd: null,
    herdrPane: null,
    tmuxPane: null,
    harness: "opencode",
  })
})

test("a session with a parentID never POSTs (through the event handler)", async () => {
  const s = serveCapture()
  const prevPort = process.env.AGENT_PORT
  const prevState = process.env.CYC_STATE_DIR
  // Point the handler's default env at our capture server and an empty state
  // dir, so a wrongful announce would be caught and the reply guard no-ops.
  process.env.AGENT_PORT = String(s.port)
  process.env.CYC_STATE_DIR = "/nonexistent-cyc-state-dir-for-test"
  const client = {
    session: { get: async () => ({ data: { parentID: "ses_parent_of" } }) },
  }
  try {
    const plugin: any = await CallYourCode({ client, directory: "/home/me/proj" })
    await plugin.event({
      event: { type: "session.idle", properties: { sessionID: "ses_child" } },
    })
  } finally {
    s.stop()
    if (prevPort === undefined) delete process.env.AGENT_PORT
    else process.env.AGENT_PORT = prevPort
    if (prevState === undefined) delete process.env.CYC_STATE_DIR
    else process.env.CYC_STATE_DIR = prevState
  }
  expect(s.captured.length).toBe(0)
})

test("a top-level session announces through the event handler", async () => {
  const s = serveCapture()
  const prevPort = process.env.AGENT_PORT
  const prevState = process.env.CYC_STATE_DIR
  process.env.AGENT_PORT = String(s.port)
  process.env.CYC_STATE_DIR = "/nonexistent-cyc-state-dir-for-test"
  const client = {
    session: { get: async () => ({ data: { id: "ses_top" } }) }, // no parentID
  }
  try {
    const plugin: any = await CallYourCode({ client, directory: "/home/me/proj" })
    await plugin.event({
      event: { type: "session.idle", properties: { sessionID: "ses_top" } },
    })
    // The announce is fire-and-forget (void); give its POST a beat to land.
    await Bun.sleep(50)
  } finally {
    s.stop()
    if (prevPort === undefined) delete process.env.AGENT_PORT
    else process.env.AGENT_PORT = prevPort
    if (prevState === undefined) delete process.env.CYC_STATE_DIR
    else process.env.CYC_STATE_DIR = prevState
  }
  expect(s.captured.length).toBe(1)
  expect(s.captured[0].body).toMatchObject({ sessionId: "ses_top", harness: "opencode" })
})

// A fresh run's FIRST identity-bearing event, verified against opencode
// 1.18.19: session.created carries the whole Session in properties.info.
test("session.created announces from properties.info (earliest event)", async () => {
  const s = serveCapture()
  const prevPort = process.env.AGENT_PORT
  const prevState = process.env.CYC_STATE_DIR
  process.env.AGENT_PORT = String(s.port)
  process.env.CYC_STATE_DIR = "/nonexistent-cyc-state-dir-for-test"
  // No client call is needed on this lane; a throwing client must not matter.
  const client = { session: { get: async () => { throw new Error("unused") } } }
  try {
    const plugin: any = await CallYourCode({ client, directory: "/home/me/proj" })
    await plugin.event({
      event: {
        type: "session.created",
        properties: { info: { id: "ses_created", directory: "/home/me/proj" } },
      },
    })
    await Bun.sleep(50)
  } finally {
    s.stop()
    if (prevPort === undefined) delete process.env.AGENT_PORT
    else process.env.AGENT_PORT = prevPort
    if (prevState === undefined) delete process.env.CYC_STATE_DIR
    else process.env.CYC_STATE_DIR = prevState
  }
  expect(s.captured.length).toBe(1)
  expect(s.captured[0].body).toMatchObject({
    sessionId: "ses_created",
    harness: "opencode",
    event: "session.created",
  })
})

// The resume path: session.created does not fire, session.updated is first.
test("session.updated announces (the resume path)", async () => {
  const s = serveCapture()
  const prevPort = process.env.AGENT_PORT
  const prevState = process.env.CYC_STATE_DIR
  process.env.AGENT_PORT = String(s.port)
  process.env.CYC_STATE_DIR = "/nonexistent-cyc-state-dir-for-test"
  const client = { session: { get: async () => ({ data: { id: "ses_resumed" } }) } }
  try {
    const plugin: any = await CallYourCode({ client, directory: "/home/me/proj" })
    await plugin.event({
      event: { type: "session.updated", properties: { info: { id: "ses_resumed" } } },
    })
    await Bun.sleep(50)
  } finally {
    s.stop()
    if (prevPort === undefined) delete process.env.AGENT_PORT
    else process.env.AGENT_PORT = prevPort
    if (prevState === undefined) delete process.env.CYC_STATE_DIR
    else process.env.CYC_STATE_DIR = prevState
  }
  expect(s.captured.length).toBe(1)
  expect(s.captured[0].body).toMatchObject({ sessionId: "ses_resumed", event: "session.updated" })
})

// A subagent session's Session.info carries a parentID; it must never announce
// (binding it would put a child's id on the parent's pane). Read inline, no
// client call.
test("session.created with a parentID never announces", async () => {
  const s = serveCapture()
  const prevPort = process.env.AGENT_PORT
  process.env.AGENT_PORT = String(s.port)
  const client = { session: { get: async () => ({ data: {} }) } }
  try {
    const plugin: any = await CallYourCode({ client, directory: "/home/me/proj" })
    await plugin.event({
      event: {
        type: "session.created",
        properties: { info: { id: "ses_child", parentID: "ses_parent" } },
      },
    })
    await Bun.sleep(50)
  } finally {
    s.stop()
    if (prevPort === undefined) delete process.env.AGENT_PORT
    else process.env.AGENT_PORT = prevPort
  }
  expect(s.captured.length).toBe(0)
})

// Across the real event flood (created -> updated... -> idle) exactly one POST.
test("one announce across the whole created/updated/idle flow", async () => {
  const s = serveCapture()
  const prevPort = process.env.AGENT_PORT
  const prevState = process.env.CYC_STATE_DIR
  process.env.AGENT_PORT = String(s.port)
  process.env.CYC_STATE_DIR = "/nonexistent-cyc-state-dir-for-test"
  const client = { session: { get: async () => ({ data: { id: "ses_flow" } }) } }
  try {
    const plugin: any = await CallYourCode({ client, directory: "/home/me/proj" })
    await plugin.event({
      event: { type: "session.created", properties: { info: { id: "ses_flow" } } },
    })
    await plugin.event({
      event: { type: "session.updated", properties: { info: { id: "ses_flow" } } },
    })
    await plugin.event({
      event: { type: "session.idle", properties: { sessionID: "ses_flow" } },
    })
    await Bun.sleep(50)
  } finally {
    s.stop()
    if (prevPort === undefined) delete process.env.AGENT_PORT
    else process.env.AGENT_PORT = prevPort
    if (prevState === undefined) delete process.env.CYC_STATE_DIR
    else process.env.CYC_STATE_DIR = prevState
  }
  expect(s.captured.length).toBe(1)
  expect(s.captured[0].body).toMatchObject({ sessionId: "ses_flow", event: "session.created" })
})

test("a dead port swallows silently (no throw)", async () => {
  // Grab a port, then close it so the connection is refused.
  const s = serveCapture()
  const deadPort = s.port
  s.stop()
  const env = { AGENT_PORT: String(deadPort) }
  // Must resolve without throwing.
  await expect(
    t.announceSession("ses_dead", "/x", "session.created", env),
  ).resolves.toBeUndefined()
})
