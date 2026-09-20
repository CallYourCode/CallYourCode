/* LANE A, CONTRACT 6: input reaches the agent.
 *
 * The keystroke path -- sendText (types, no submit) then sendKeys("enter")
 * (submits) -- delivers his message to the pane, and interrupt is ctrl+c. This
 * asserts the FRAMES the adapter emits, on both mux seams:
 *
 *   herdr: the REAL MuxAdapter over the REAL herdr JSON-RPC framing (fake-herdr,
 *          no engine). The fake types-appends and submits-on-enter exactly as a
 *          measured claude pane does, so `submitted` proves the body actually
 *          reached the agent, not merely that a frame was written. Run for every
 *          harness -- the keystroke path is agent-agnostic, which is the point.
 *   tmux:  the MuxAdapter seam over a recording Multiplexer (the send verbs a
 *          TmuxMuxAdapter forwards to TmuxMux). The tmux BYTE mapping -- send-keys
 *          -l types literally, Enter submits -- is proven against real tmux in
 *          terminal/tmux.test.ts; here we pin the adapter emits text-then-enter.
 *
 * pi's FIRST-CLASS direct-input path (not mux keystrokes) is LANE B, now landed:
 * the pi row below proves it against a fake pi RPC endpoint. pi's KEYSTROKE
 * delivery through a mux still works and is covered by the herdr cases.
 *
 *   bun test agent-engine/src/adapters/suite-input.test.ts
 */

import { test, expect } from "bun:test";
import { HARNESSES, HARNESS_CAPS, SKIP, type Harness } from "../test-utils/suite-matrix.ts";
import { fakeHerdr } from "../test-utils/fake-herdr.ts";
import { tmpDir, sockPath } from "../test-utils/tmp.ts";
import { until } from "../test-utils/wait.ts";
import { HerdrClient } from "../terminal/herdr.ts";
import { piRpcEndpoint, type DirectInputSink } from "./pi-direct.ts";
import type { Multiplexer } from "../terminal/mux.ts";

const { MuxAdapter } = await import("./mux-adapter.ts");

const PANE = "w1:p1";

/* ------------------------------------------ herdr: real JSON-RPC framing */

for (const harness of HARNESSES) {
  test(`[herdr x ${harness}] CONTRACT 6: the keystroke path delivers and Enter submits`, async () => {
    const dir = await tmpDir(`cyc-suite-input-${harness}-`);
    const sock = sockPath(dir);
    const rpcs: Array<{ method: string; pane: string; text?: string; keys?: string[] }> = [];
    const submitted: Array<{ pane: string; text: string }> = [];
    const fake = fakeHerdr(sock, "idle", [PANE], rpcs, undefined, submitted, undefined,
      new Map(), new Set(), new Map([[PANE, harness]]));
    const client = new HerdrClient(sock);
    const adapter = new MuxAdapter(client);
    adapter.start();
    adapter.onAgents(() => {});
    try {
      await until(() => adapter.listAgents().length === 1, { what: "the pane to enumerate" });
      // the pane is stamped as this harness (herdr's agent_session carries every
      // agent's kind); the keystroke path is the same whichever it is
      expect(adapter.listAgents()[0].kind).toBe(HARNESS_CAPS[harness].kind);

      // TYPE, then SUBMIT: two frames, and the body reaches the agent only on
      // the enter (a sendText that submitted would fire every draft)
      await adapter.sendText(PANE, "run the tests please");
      expect(fake.texts).toEqual([{ paneId: PANE, text: "run the tests please" }]);
      expect(submitted, "typed is not sent until Enter").toEqual([]);

      await adapter.sendKeys(PANE, "enter");
      expect(fake.keys.map((k) => k.keys)).toEqual([["enter"]]);
      expect(submitted, "Enter submitted the typed body: it reached the agent")
        .toEqual([{ pane: PANE, text: "run the tests please" }]);

      // interrupt is ctrl+c
      await adapter.interrupt(PANE);
      expect(fake.keys.map((k) => k.keys)).toEqual([["enter"], ["ctrl+c"]]);
    } finally {
      client.stop();
      fake.stop(true);
    }
  });
}

/* --------------------------------------- tmux: the adapter seam frames */

/** A Multiplexer that records every send verb, standing in for the tmux send
 *  verbs a TmuxMuxAdapter forwards to. */
function recordingMux() {
  const calls: Array<{ method: string; pane: string; text?: string; keys?: string[] }> = [];
  const mux: Multiplexer = {
    onAgents() {},
    start() {},
    async readPane() { return { text: "", truncated: false }; },
    async sendText(pane: string, text: string) { calls.push({ method: "sendText", pane, text }); },
    async sendKeys(pane: string, ...keys: string[]) { calls.push({ method: "sendKeys", pane, keys }); },
    async renamePane() {},
    async closePane() {},
    workspaceOf() { return null; },
    knownCwds() { return []; },
    async newTab() { return "%9~1~1"; },
  } as unknown as Multiplexer;
  return { mux, calls };
}

test("[tmux] CONTRACT 6: the adapter emits sendText then sendKeys(enter), interrupt is ctrl+c", async () => {
  const { mux, calls } = recordingMux();
  const adapter = new MuxAdapter(mux);
  const handle = "%3~4242~7"; // a reuse-proof tmux handle; the adapter never parses it
  await adapter.sendText(handle, "the message");
  await adapter.sendKeys(handle, "enter");
  await adapter.interrupt(handle);
  expect(calls).toEqual([
    { method: "sendText", pane: handle, text: "the message" },
    { method: "sendKeys", pane: handle, keys: ["enter"] },
    { method: "sendKeys", pane: handle, keys: ["ctrl+c"] },
  ]);
  // the tmux BYTE mapping (send-keys -l literal, Enter submits, ctrl+c
  // interrupts) is proven against real tmux; named, not silently skipped
  expect(SKIP.muxLevelInTmuxTest).toContain("tmux.test.ts");
});

/* ------------------------------------ pi direct-input: LANE B (landed) */

/** A fake pi RPC endpoint: parses pi's JSON-line control protocol (one command
 *  per line) exactly as pi's runRpcMode does, recording the commands. No real
 *  pi process, no real session. */
function fakePiRpc(): { sink: DirectInputSink; commands: Array<Record<string, unknown>> } {
  const commands: Array<Record<string, unknown>> = [];
  let buf = "";
  const sink: DirectInputSink = {
    write(line) {
      buf += line;
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const raw = buf.slice(0, nl); buf = buf.slice(nl + 1);
        if (raw.trim()) commands.push(JSON.parse(raw));
      }
    },
  };
  return { sink, commands };
}

test(`[pi] CONTRACT 6 direct-input: pi takes his message DIRECTLY, no keystrokes`, async () => {
  // pi declares the first-class direct-input path the suite expects LANE B to fill
  expect(HARNESS_CAPS.pi.directInput).toBe(true);

  const dir = await tmpDir("cyc-suite-input-pi-direct-");
  const sock = sockPath(dir);
  const submitted: Array<{ pane: string; text: string }> = [];
  const fake = fakeHerdr(sock, "idle", [PANE], [], undefined, submitted, undefined,
    new Map(), new Set(), new Map([[PANE, "pi"]]));
  const client = new HerdrClient(sock);
  const adapter = new MuxAdapter(client);
  adapter.start();
  adapter.onAgents(() => {});
  try {
    await until(() => adapter.listAgents().length === 1, { what: "the pi pane to enumerate" });
    expect(adapter.listAgents()[0].kind).toBe("pi");
    // the seam declares pi's method as direct (claude/codex/opencode are keystroke)
    expect(adapter.inputMethod(PANE)).toBe("direct");

    // register a live pi RPC endpoint and deliver: the body reaches pi over the
    // direct channel as a `prompt` command, and NOT a single keystroke is typed
    const pi = fakePiRpc();
    adapter.registerDirectInput(PANE, piRpcEndpoint(pi.sink));
    await adapter.sendInput(PANE, "run the tests please", "d-run");

    expect(pi.commands).toHaveLength(1);
    expect(pi.commands[0].type).toBe("prompt");
    expect(pi.commands[0].message).toBe("run the tests please");
    expect(fake.texts, "direct input types nothing at the pane").toEqual([]);
    expect(fake.keys, "direct input presses no key -- no Enter to submit").toEqual([]);
    expect(submitted, "nothing was submitted through the mux").toEqual([]);
  } finally {
    client.stop();
    fake.stop(true);
  }
});
