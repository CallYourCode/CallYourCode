/* HOOK-ANNOUNCED IDENTITY, the seam (hook-announce.ts + hooks/announce-session.py).
 *
 * Hermetic: no tmux, no herdr, no engine process. The route body handling,
 * the parking, the bind store and its persistence are exercised directly; the
 * python hook is run as a real subprocess against a throwaway HTTP listener
 * (the wire contract) and against a dead port (fail-silent, the property that
 * keeps a dead engine from ever breaking claude).
 *
 *   bun test agent-engine/src/terminal/hook-announce.test.ts
 */

import { test, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { join } from "node:path";
import { mkdirSync } from "node:fs";
import { tmpDir } from "../test-utils/tmp.ts";
import {
  ANNOUNCE_TTL_MS, handleAnnounce, hookBindFor, markParked, onHookAnnounce, parseAnnounceLink,
  pendingAnnounces, pruneHookBinds, recordHookBind, resetHookAnnounce, takePending,
} from "./hook-announce.ts";

const HOOK = join(import.meta.dir, "..", "..", "..", "hooks", "announce-session.py");
const SID = "0a0a0a0a-1111-4222-8333-000000000001";

/* The store persists under CYC_DATA_DIR/state; the whole file runs against a
 * tmp dir so ~/.callyourcode is never touched. */
let SAVED: string | undefined;
beforeAll(async () => {
  SAVED = process.env.CYC_DATA_DIR;
  const root = await tmpDir("cyc-hook-ann-");
  process.env.CYC_DATA_DIR = join(root, "data");
  mkdirSync(process.env.CYC_DATA_DIR, { recursive: true });
});
afterAll(() => {
  if (SAVED === undefined) delete process.env.CYC_DATA_DIR;
  else process.env.CYC_DATA_DIR = SAVED;
  resetHookAnnounce();
});
beforeEach(() => resetHookAnnounce());

/** A deps bag that skips the real `ps` walk. */
const resolved = (agentPid: number | null) => ({ resolveAgentPid: async () => agentPid });

test("the route refuses garbage and never throws", async () => {
  expect((await handleAnnounce(null)).ok).toBe(false);
  expect((await handleAnnounce("x")).ok).toBe(false);
  expect((await handleAnnounce({})).ok).toBe(false);
  expect((await handleAnnounce({ sessionId: "", pid: 42 })).ok).toBe(false);
  expect((await handleAnnounce({ sessionId: "../etc/passwd", pid: 42 })).ok).toBe(false);
  expect((await handleAnnounce({ sessionId: SID, pid: 0 })).ok).toBe(false);
  expect((await handleAnnounce({ sessionId: SID, pid: "no" })).ok).toBe(false);
  expect(pendingAnnounces().length).toBe(0);
});

test("an announce parks keyed by its resolved agent pid, then binds when a mux places it", async () => {
  const pokes: number[] = [];
  const off = onHookAnnounce(() => pokes.push(1));
  const r = await handleAnnounce({ sessionId: SID, pid: 999, cwd: "/tmp/x" }, resolved(4242));
  expect(r).toEqual({ ok: true, parked: true });
  expect(pokes.length).toBe(1); // the muxes were poked for an immediate lap
  const [p] = pendingAnnounces();
  expect(p.agentPid).toBe(4242);
  expect(hookBindFor("%1~4242~7")).toBeNull(); // nothing bound yet

  // the mux found the pane whose detected agent pid matches: bind
  takePending(p, "%1~4242~7");
  expect(hookBindFor("%1~4242~7")).toEqual({ sessionId: SID });
  expect(pendingAnnounces().length).toBe(0); // the parking retired with the bind
  off();
});

test("a re-announce replaces its own parking; a new id on a bound pane rolls the bind", async () => {
  await handleAnnounce({ sessionId: SID, pid: 999 }, resolved(4242));
  await handleAnnounce({ sessionId: SID, pid: 1000 }, resolved(4242)); // next hook, same claude
  expect(pendingAnnounces().length).toBe(1); // one parking slot per announcer

  recordHookBind("h", SID, 4242);
  recordHookBind("h", SID, 4242); // idempotent
  expect(hookBindFor("h")).toEqual({ sessionId: SID });
  const rolled = "0b0b0b0b-1111-4222-8333-000000000002";
  recordHookBind("h", rolled, 4242); // a roll/resume announces its new id: latest wins
  expect(hookBindFor("h")).toEqual({ sessionId: rolled });
});

test("the witnesses arrive SEPARATELY, each lane reading only its own field", async () => {
  /* The shakedown bug: a tmux pane inheriting a stale HERDR_PANE_ID from the
   * herdr session that started the tmux server shadowed the real TMUX_PANE in
   * the old combined field. Both ids now ride as their own fields, so each
   * lane can read only its own witness. */
  await handleAnnounce({ sessionId: SID, pid: 999, herdrPane: "w2:p1", tmuxPane: "%4" }, resolved(4242));
  const [p] = pendingAnnounces();
  expect(p.herdrPane).toBe("w2:p1");
  expect(p.tmuxPane).toBe("%4");
});

test("every announce has ONE logged outcome: bound once, parked reason once, idempotent re-place quiet", async () => {
  const lines: string[] = [];
  const orig = console.log;
  console.log = (...a: unknown[]) => { lines.push(a.map(String).join(" ")); };
  try {
    await handleAnnounce({ sessionId: SID, pid: 999 }, resolved(4242));
    const [p] = pendingAnnounces();
    markParked(p, "no pane for pid");
    markParked(p, "no pane for pid"); // the next poll's lap: no repeat spam
    takePending(p, "%9~4242~7", "pid"); // the pane showed: bound, logged once

    // UserPromptSubmit belt and braces re-announces the same id: the re-place
    // lands on the existing bind and stays quiet
    await handleAnnounce({ sessionId: SID, pid: 1000 }, resolved(4242));
    const [again] = pendingAnnounces();
    takePending(again, "%9~4242~7", "pid");
  } finally {
    console.log = orig;
  }
  expect(lines.filter((l) => l.includes("] parked")))
    .toEqual([`[announce] parked ${SID}: no pane for pid`]);
  expect(lines.filter((l) => l.includes("] bound")))
    .toEqual([`[announce] bound ${SID} -> %9~4242~7 (pid)`]);
});

test("an unplaced announce expires after the TTL instead of parking forever", async () => {
  await handleAnnounce({ sessionId: SID, pid: 999 }, resolved(4242));
  expect(pendingAnnounces().length).toBe(1);
  expect(pendingAnnounces(Date.now() + ANNOUNCE_TTL_MS + 1).length).toBe(0);
});

test("TTL expiry logs ONCE, carrying the last parked reason", async () => {
  /* Retries are idempotent-quiet, so the expiry line is the only trace of a
   * parked announce that never bound; it must say why it kept parking. */
  const lines: string[] = [];
  const orig = console.log;
  console.log = (...a: unknown[]) => { lines.push(a.map(String).join(" ")); };
  try {
    await handleAnnounce({ sessionId: SID, pid: 999 }, resolved(4242));
    const [p] = pendingAnnounces();
    markParked(p, "no pane for pid");
    markParked(p, "no pane for pid"); // later laps: quiet, but the reason is kept
    expect(pendingAnnounces(Date.now() + ANNOUNCE_TTL_MS + 1).length).toBe(0);
    expect(pendingAnnounces(Date.now() + ANNOUNCE_TTL_MS + 2).length).toBe(0); // swept: no second log
  } finally {
    console.log = orig;
  }
  expect(lines.filter((l) => l.includes("] expired")))
    .toEqual([`[announce] expired ${SID}: no pane for pid`]);
});

test("binds persist across an engine restart and prunes are scoped to the caller's handles", async () => {
  recordHookBind("%1~10~7", SID, 10);
  recordHookBind("w9:p3", "0c0c0c0c-1111-4222-8333-000000000003", 0);
  resetHookAnnounce(); // the restart: in-memory store forgotten, file remains
  expect(hookBindFor("%1~10~7")).toEqual({ sessionId: SID }); // reloaded from state/
  expect(hookBindFor("w9:p3")).not.toBeNull();

  // the tmux poll prunes only tmux-shaped handles; herdr's bind survives it
  pruneHookBinds(new Set<string>(), (h) => /~\d+~\d+$/.test(h));
  expect(hookBindFor("%1~10~7")).toBeNull();
  expect(hookBindFor("w9:p3")).not.toBeNull();
});

/* ------------------------------------------- the v2 link, per harness shape
 *
 * The announce v2 body carries an optional `link: {kind, from?}` naming where
 * a session came from, so the reconcile can join the agent it belongs to by
 * a direct index lookup before any pane matching. One fixture per harness,
 * in the shape its adapter (or today's hook) sends. */

const PRIOR = "0d0d0d0d-1111-4222-8333-000000000009";
/* The bind store is file-backed and survives resetHookAnnounce (that is the
 * restart test above), so every fixture binds on a pane of its own. */
let paneNo = 100;
const bind = async (body: Record<string, unknown>) => {
  const handle = `w1:p${++paneNo}`;
  const r = await handleAnnounce({ pid: 999, cwd: "/tmp/x", ...body }, resolved(4242));
  const [p] = pendingAnnounces();
  if (p) takePending(p, handle);
  return { r, bound: hookBindFor(handle) };
};

test("claude: the hook's raw SessionStart `source` is the link, with the prior id when known", async () => {
  /* Today's announce-session.py forwards `source` verbatim (startup, resume,
   * clear, compact, fork) and no prior id: claude's SessionStart payload has
   * none. `previousSessionId` is the adapter lane's addition. */
  const startup = parseAnnounceLink({ sessionId: SID, source: "startup", event: "SessionStart" });
  expect(startup).toEqual({ kind: "startup" });
  expect(parseAnnounceLink({ sessionId: SID, source: "resume" })).toEqual({ kind: "resume" });
  expect(parseAnnounceLink({ sessionId: SID, source: "clear", previousSessionId: PRIOR }))
    .toEqual({ kind: "clear", from: PRIOR });
  expect(parseAnnounceLink({ sessionId: SID, source: "compact", previousSessionId: PRIOR }))
    .toEqual({ kind: "compact", from: PRIOR });
  expect(parseAnnounceLink({ sessionId: SID, source: "fork", previousSessionId: PRIOR }))
    .toEqual({ kind: "fork", from: PRIOR });
  // a prior id that is not a session id is dropped, the kind survives
  expect(parseAnnounceLink({ sessionId: SID, source: "fork", previousSessionId: "../x" })).toEqual({ kind: "fork" });
  // the link rides on the bind the mux consumes
  const { r, bound } = await bind({ sessionId: SID, harness: "claude", source: "fork", previousSessionId: PRIOR });
  expect(r).toEqual({ ok: true, parked: true });
  expect(bound).toEqual({ sessionId: SID, link: { kind: "fork", from: PRIOR } });
});

test("codex: `forked_from_id` on the rollout becomes a fork link; the notify's own `source` is no link", async () => {
  /* The codex notify hook sends source "codex-notify", which names no link
   * kind: an announce from it binds with no link (today's behaviour). The
   * adapter lane turns the rollout's `forked_from_id` into the explicit v2
   * link, which is the only spelling the route needs to understand. */
  expect(parseAnnounceLink({ sessionId: SID, source: "codex-notify", event: "agent-turn-complete" })).toBeNull();
  const forked = { sessionId: SID, harness: "codex", link: { kind: "fork", from: PRIOR } };
  expect(parseAnnounceLink(forked)).toEqual({ kind: "fork", from: PRIOR });
  const { r, bound } = await bind(forked);
  expect(r).toEqual({ ok: true, parked: true });
  expect(bound).toEqual({ sessionId: SID, link: { kind: "fork", from: PRIOR } });
});

test("opencode: a session with a `parentID` is a subagent: acknowledged, never parked, never bound", async () => {
  const child = { sessionId: SID, harness: "opencode", link: { kind: "parent", from: PRIOR } };
  expect(parseAnnounceLink(child)).toEqual({ kind: "parent", from: PRIOR });
  const pokes: number[] = [];
  const off = onHookAnnounce(() => pokes.push(1));
  const { r, bound } = await bind(child);
  off();
  expect(r).toEqual({ ok: true, parked: false });
  expect(pendingAnnounces().length).toBe(0);
  expect(bound).toBeNull();
  expect(pokes.length, "a child session must not even wake the muxes").toBe(0);
  // a top-level opencode session (no parent) binds like any other
  const top = await bind({ sessionId: SID, harness: "opencode" });
  expect(top.r).toEqual({ ok: true, parked: true });
  expect(top.bound).toEqual({ sessionId: SID });
});

test("pi: `previousSessionFile` after /new or /fork is spelled as a link by the adapter", async () => {
  /* pi's session_start event names the file the new session was cut from;
   * the adapter maps /new to `clear` and /fork to `fork`, with the prior
   * session's id as `from`. The route sees only the v2 spelling. */
  const cleared = { sessionId: SID, harness: "pi", link: { kind: "clear", from: PRIOR } };
  expect(parseAnnounceLink(cleared)).toEqual({ kind: "clear", from: PRIOR });
  const { r, bound } = await bind(cleared);
  expect(r).toEqual({ ok: true, parked: true });
  expect(bound).toEqual({ sessionId: SID, link: { kind: "clear", from: PRIOR } });
  const forked = await bind({ sessionId: SID, harness: "pi", link: { kind: "fork", from: PRIOR } });
  expect(forked.bound).toEqual({ sessionId: SID, link: { kind: "fork", from: PRIOR } });
});

test("a malformed link never blocks the bind: unknown kinds and non-objects are no link", async () => {
  expect(parseAnnounceLink({ sessionId: SID, link: { kind: "teleport", from: PRIOR } })).toBeNull();
  expect(parseAnnounceLink({ sessionId: SID, link: "fork" })).toBeNull();
  expect(parseAnnounceLink({ sessionId: SID, link: { from: PRIOR } })).toBeNull();
  expect(parseAnnounceLink({ sessionId: SID })).toBeNull();
  const { r, bound } = await bind({ sessionId: SID, link: { kind: "teleport", from: PRIOR } });
  expect(r).toEqual({ ok: true, parked: true });
  expect(bound).toEqual({ sessionId: SID });
});

/* ------------------------------------------------------ the python hook */

const PY = Bun.which("python3");
const pt = test.skipIf(!PY);

/* async spawn, never spawnSync: the wire-contract test serves the announce
 * from THIS process, and spawnSync would block the event loop the server
 * answers on -- the hook would then time out against a healthy server. */
async function runHook(
  port: number, payload: unknown, env: Record<string, string> = {},
): Promise<{ exitCode: number; ms: number }> {
  const t0 = Date.now();
  const proc = Bun.spawn([PY!, HOOK], {
    stdin: Buffer.from(JSON.stringify(payload)),
    env: { ...process.env, AGENT_PORT: String(port), ...env },
    stdout: "pipe", stderr: "pipe",
  });
  const exitCode = await proc.exited;
  return { exitCode, ms: Date.now() - t0 };
}

pt("the hook POSTs the announce the route understands", async () => {
  const got: unknown[] = [];
  const srv = Bun.serve({
    port: 0,
    fetch: async (req) => {
      if (new URL(req.url).pathname === "/harness/announce") got.push(await req.json());
      return new Response(JSON.stringify({ ok: true }), { headers: { "content-type": "application/json" } });
    },
  });
  try {
    const { exitCode } = await runHook(srv.port, {
      session_id: SID, cwd: "/tmp/somewhere", transcript_path: "/tmp/t.jsonl",
      hook_event_name: "SessionStart", source: "resume",
    }, { HERDR_PANE_ID: "w2:p1", TMUX_PANE: "%7" });
    expect(exitCode).toBe(0);
    expect(got.length).toBe(1);
    const b = got[0] as Record<string, unknown>;
    expect(b.sessionId).toBe(SID);
    expect(typeof b.pid).toBe("number");
    expect(b.cwd).toBe("/tmp/somewhere");
    expect(b.event).toBe("SessionStart");
    expect(b.source).toBe("resume");
    // both witnesses, SEPARATE, never merged; the combined field is retired
    expect(b.herdrPane).toBe("w2:p1");
    expect(b.tmuxPane).toBe("%7");
    expect("paneEnv" in b).toBe(false);
    // and the body validates against the real route handler
    expect((await handleAnnounce(b, resolved(null))).ok).toBe(true);
  } finally {
    srv.stop(true);
  }
});

pt("a dead engine is harmless: the hook exits 0, fast, with no engine listening", async () => {
  // a port nothing listens on: connection refused, immediately
  const { exitCode, ms } = await runHook(1, { session_id: SID });
  expect(exitCode).toBe(0);
  expect(ms).toBeLessThan(5_000);
});

pt("an empty or malformed payload is also a silent 0", async () => {
  const proc = Bun.spawn([PY!, HOOK], {
    stdin: Buffer.from("this is not json"),
    env: { ...process.env, AGENT_PORT: "1" },
  });
  expect(await proc.exited).toBe(0);
});
