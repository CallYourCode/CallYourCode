/* A RESTART MAY ONLY CLAIM WHAT THE PANE SHOWED.
 *
 * THE DEFECT THESE WERE WRITTEN FOR, in one sentence: `claude --resume <id>` for
 * a conversation this machine has never held runs for about a second and then
 * prints "No conversation found with session ID" onto the shell. The old watch
 * loop returned the instant herdr listed a process, so it answered "(Restarted,
 * resuming the previous conversation.)" -- into the app, and into his chat log as
 * a claude message -- over a pane sitting at a shell prompt.
 *
 * So there are three things to hold down and they are separate:
 *
 *   1. WHAT COUNTS AS COMING BACK. Only claude drawn on the screen: its input
 *      box, or a dialog it is asking. A process is not a session.
 *   2. WHEN THE WATCH IS ALLOWED TO STOP. On a sighting, or on the window
 *      running out. Never on the first read, never on a timer expiring early.
 *   3. WHAT THE APP ACTUALLY RECEIVES. `verdict` is the app's SOLE source of
 *      truth (restartClaim confirms on it and on nothing else), and it, and
 *      `tell`, are assembled in the ROUTE. Every assertion about the decision
 *      passed while `verdict: sighting.seen` was mutated to a constant.
 *
 * (1) and (2) need only the loop, which takes its reads and its clock as
 * arguments. (3) needs the route over a real pane, and gets one from wireCore: a
 * FakeHerdr on a unix socket, a real MuxAdapter, and the real route table on a
 * port-0 Bun.serve. No engine process anywhere.
 *
 *   bun test agent-engine/src/terminal/restart.test.ts
 */

import { test, expect, beforeAll, afterAll, afterEach } from "bun:test";
import { join } from "node:path";

import { classifyPaneBox } from "./herdr.ts";
import { restartConfirmed, restartLogsToChat, restartTell, sightRestart, watchRestart,
  type RestartRead, type RestartSighting } from "./restart.ts";
import { sessionOpsRoutes } from "../routes/session-ops.ts";
import { wireCore, type WireCore, wireId } from "../test-utils/wire-core.ts";
import { serveRoutes, type ServedRoutes } from "../test-utils/serve-routes.ts";
import { PANE } from "../test-utils/fake-herdr.ts";
import { until } from "../test-utils/wait.ts";

/** A pane read. `kind` is what classifyPaneBox made of it. */
const read = (kind: RestartRead["kind"], screen = "", question: string | null = null):
  RestartRead => ({ kind, question, screen });

/* The real thing, trimmed. claude has exited and the shell has the pane back. */
const NO_CONVERSATION =
  "$ claude --dangerously-skip-permissions --resume 9f2c1a44-0b7e-4e11-9a11-6d2f0c9b7e31\n" +
  "No conversation found with session ID: 9f2c1a44-0b7e-4e11-9a11-6d2f0c9b7e31\n" +
  "$ ";

/* A pane a beat after the command: the shell has echoed it and nothing has drawn
 * yet. classifyPaneBox finds no box on this. */
const STILL_BLANK = "$ claude --dangerously-skip-permissions\n";

/* And the pane the whole window later, still a shell. */
const SHELL = "$ claude --dangerously-skip-permissions\n$ ";

/** A real freshly started Claude Code 2.1.222, captured at three widths. */
const freshClaude = (cols: 60 | 100 | 200) =>
  Bun.file(join(import.meta.dir, "..", "fixtures", `pane-fresh-claude-${cols}col.txt`)).text();

// ------------------------------------------------- 1. what counts as coming back

test("a shell saying there is no such conversation is not a restart", () => {
  const s = sightRestart(read("unknown", NO_CONVERSATION));
  expect(s).toEqual({ seen: "no-session" });
  expect(restartConfirmed(s!)).toBe(false);
  expect(restartTell(s!, "resume")).not.toMatch(/^\(Restarted/);
  expect(restartTell(s!, "resume")).toMatch(/no such conversation/i);
});

test("claude's own input box is what confirms it", () => {
  const s = sightRestart(read("input", "❯ \n"));
  expect(s).toEqual({ seen: "ready" });
  expect(restartConfirmed(s!)).toBe(true);
});

test("a dialog it is asking confirms it too, and the question is carried", () => {
  const s = sightRestart(read("chooser", "", "Do you trust the files in this folder?"));
  expect(s).toEqual({ seen: "waiting", question: "Do you trust the files in this folder?" });
  expect(restartConfirmed(s!)).toBe(true);
  expect(restartTell(s!, "fresh")).toContain("Do you trust the files in this folder?");
});

test("watching the whole window and seeing nothing is not a failure and not a success", () => {
  const s: RestartSighting = { seen: "nothing" };
  expect(restartConfirmed(s)).toBe(false);
  expect(restartTell(s, "resume")).not.toMatch(/^\(Restarted/);
  expect(restartTell(s, "resume")).toMatch(/cannot say/i);
});

/* THE INVARIANT, said over every value the type has: the word only appears where
 * the predicate is true. This is what stops a fifth outcome being added later
 * with a cheerful sentence on it. */
test("nothing says 'Restarted' unless it was seen", () => {
  const all: RestartSighting[] = [
    { seen: "waiting", question: "q" }, { seen: "ready" },
    { seen: "no-session" }, { seen: "nothing" },
  ];
  for (const s of all) {
    for (const mode of ["fresh", "resume"] as const) {
      const tell = restartTell(s, mode);
      expect([s.seen, /^\(Restarted/.test(tell)]).toEqual([s.seen, restartConfirmed(s)]);
    }
  }
});

// ------------------------------------------------- 2. when the watch may stop

/** Drives watchRestart over a scripted list of reads, with no real clock. */
async function watch(script: RestartRead[], windowMs = 15_000, stepMs = 1_000) {
  let t = 0;
  let i = 0;
  const sighting = await watchRestart(
    async () => script[Math.min(i++, script.length - 1)],
    { windowMs, stepMs, now: () => t, sleep: async (ms) => { t += ms; } },
  );
  return { sighting, reads: i, elapsed: t };
}

test("a pane that has not drawn anything does not end the watch", async () => {
  /* The old loop stopped here, because a process existed. There is nothing on
   * this screen: it must keep looking, and it must use the whole window. */
  const { sighting, reads } = await watch([read("unknown", STILL_BLANK)]);
  expect(sighting).toEqual({ seen: "nothing" });
  expect(reads).toBe(15);
});

test("it waits for the box to be drawn and then stops", async () => {
  const { sighting, reads, elapsed } = await watch([
    read("unknown", STILL_BLANK),
    read("unknown", STILL_BLANK),
    read("unreadable"),
    read("input", "❯ \n"),
    read("input", "❯ \n"),
  ]);
  expect(sighting).toEqual({ seen: "ready" });
  expect(reads).toBe(4);          // it did not settle for any of the first three
  expect(elapsed).toBe(4_000);
});

test("a screen we could not read is not a restart either", async () => {
  const { sighting } = await watch([read("unreadable")]);
  expect(sighting).toEqual({ seen: "nothing" });
  expect(restartConfirmed(sighting)).toBe(false);
});

test("the resume that has nothing to resume is caught, not waited out", async () => {
  const { sighting, reads } = await watch([
    read("unknown", STILL_BLANK),
    read("unknown", NO_CONVERSATION),
  ]);
  expect(sighting).toEqual({ seen: "no-session" });
  expect(reads).toBe(2);
});

/* Claude resuming a conversation that discussed this failure must not be read as
 * the failure. The box wins, and it is looked at first. */
test("the phrase inside a live session is not the shell saying it", async () => {
  const { sighting } = await watch([
    read("input", "❯ we hit 'No conversation found' yesterday\n"),
  ]);
  expect(sighting).toEqual({ seen: "ready" });
});

// --------------------------------- 3. against what a real claude actually draws

/* THE ONE THIS ROUND EXISTS FOR, and it is not a shape argument: every verdict
 * above is decided from `classifyPaneBox`, so a screen that classifier cannot
 * read is a restart that can never be confirmed. Claude Code 2.1.222 prints a tip
 * INSIDE the top edge of its input box and the classifier was pairing two plain
 * rules, so a freshly started claude was invisible: measured `unknown` at 60, 100
 * and 200 columns at ten moments from 3s to 90s, thirty for thirty.
 * RESTART_WATCH_MS is 15s, so every real restart would have run the window out
 * and reported that it could not tell -- and written that sentence into his chat.
 * These drive the real captures through the real classifier. */
for (const cols of [60, 100, 200] as const) {
  test(`a real freshly started claude at ${cols} columns confirms the restart`, async () => {
    const screen = await freshClaude(cols);
    const box = classifyPaneBox(screen);
    // the classifier first, so a failure here names the classifier and not this
    expect([cols, box.kind]).toEqual([cols, "input"]);
    const sighting = sightRestart({ kind: box.kind, question: null, screen });
    expect(sighting).toEqual({ seen: "ready" });
    expect(restartConfirmed(sighting!)).toBe(true);
  });
}

test("a real fresh claude is seen on the first look, not waited out", async () => {
  const screen = await freshClaude(100);
  const { sighting, elapsed } = await watch([
    { kind: classifyPaneBox(screen).kind, question: null, screen },
  ]);
  expect(sighting).toEqual({ seen: "ready" });
  expect(elapsed).toBe(1_000);
});

// ------------------------------- 4. what may become a message in his chat log

/* A TOAST IS GONE IN EIGHT SECONDS; A CHAT MESSAGE IS THERE FOR EVER.
 *
 * The first version logged every outcome, including "this cannot say whether it
 * restarted" -- so a restart that worked fine left a permanent claude message in
 * his history saying it might not have. Only a sighting earns a line in the log.
 * `nothing` still reaches the app, where it is a sentence he can dismiss. */
test("only what was actually seen is written into the chat", () => {
  expect(restartLogsToChat({ seen: "ready" })).toBe(true);
  expect(restartLogsToChat({ seen: "waiting", question: "q" })).toBe(true);
  expect(restartLogsToChat({ seen: "no-session" })).toBe(true);
  expect(restartLogsToChat({ seen: "nothing" })).toBe(false);
});

// ------------------------------------------- 5. the route, over a real pane

/* THE RESTART LADDER, SHORTENED AT FILE SCOPE.
 *
 * Three ctrl+c presses half a second apart, up to twenty seconds waiting for
 * herdr to stop listing an agent, six hundred milliseconds for the shell to be a
 * shell again, and a fifteen-second watch: about thirty-five seconds of real
 * waiting for the two tests below. All of it is wall-clock by nature (another
 * process quitting, a shell coming back, a TUI drawing itself), so there is no
 * logical clock to advance -- only a real one to make small. pane-deliver.ts
 * reads every one of them on each use for exactly this reason.
 *
 * The SHAPE is unchanged and is what the tests are about: three presses, then
 * wait for the agent to go, then the command, then watch the screen. */
const LADDER: Record<string, string> = {
  CYC_RESTART_PRESS_MS: "5",
  CYC_RESTART_GONE_MS: "3000",
  CYC_RESTART_GONE_POLL_MS: "5",
  CYC_RESTART_SHELL_MS: "5",
  CYC_RESTART_WATCH_MS: "200",
  CYC_RESTART_WATCH_STEP_MS: "10",
  DELIVER_SETTLE_MS: "5",
};
const priorEnv: Record<string, string | undefined> = {};
beforeAll(() => {
  for (const [k, v] of Object.entries(LADDER)) { priorEnv[k] = process.env[k]; process.env[k] = v; }
});
afterAll(() => {
  for (const [k, v] of Object.entries(priorEnv)) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
});

let core: WireCore | null = null;
let http: ServedRoutes | null = null;
afterEach(async () => {
  http?.stop();
  http = null;
  await core?.stop();
  core = null;
});

/* Drive the real POST /session/<id>/restart against a real pane.
 *
 * THE AGENT IS NEVER BROUGHT BACK, on purpose. The watcher is supposed to read
 * the SCREEN and not the process list, so a pane showing claude's box while herdr
 * still lists no agent must confirm. If aliveness ever creeps back into the loop,
 * these go red. */
async function restartThrough(screenAfterCommand: string): Promise<{
  body: any; chat: string[]; c: WireCore;
}> {
  const c = await wireCore({ with: ["delivery"] });
  core = c;
  await until(() => c.sessions.size === 1, { what: "the pane to reconcile" });
  http = serveRoutes({ groups: [sessionOpsRoutes], ctx: { adapter: c.adapter } });
  const cl = c.client();

  const post = http.post(`/session/${encodeURIComponent(wireId(PANE))}/restart`, { mode: "fresh" });
  // the quit: three ctrl+c presses, and then herdr stops listing the agent
  await until(() => c.herdr.keys.filter((k) => k.keys.includes("ctrl+c")).length >= 3,
    { what: "the three ctrl+c presses that quit the agent" });
  await c.herdr.setAgentGone(PANE, true);
  c.hooks.setScreen!(PANE, screenAfterCommand);

  const body = await (await post).json();
  const chat = cl.of("chat").filter((f) => f.role === "claude").map((f) => String(f.text));
  return { body, chat, c };
}

test("a real fresh claude on the pane comes back as a confirmed restart", async () => {
  const { body, chat, c } = await restartThrough(await freshClaude(100));
  expect(body.ok).toBe(true);
  expect(body.verdict).toBe("ready");
  expect(body.tell).toContain("Restarted fresh");
  // and it IS worth a line in his history: we watched it happen
  expect(chat).toEqual([body.tell]);
  /* The command really was typed, at the shell, after the quit -- the one launch
   * command /new-session types too (newsession.test.ts asserts the same suffix),
   * behind this session's own stable id as a portable env prefix (cyc-cli plan
   * section 3): a restart re-injects the id the pane already answered to. */
  const EXPECT = /^env CYC_AGENT_ID=ag-[A-Za-z0-9_-]{16} claude --dangerously-skip-permissions$/;
  expect(c.herdr.texts).toHaveLength(1);
  expect(c.herdr.texts[0].text).toMatch(EXPECT);
  // and submitted, or it is a command sitting in a shell prompt
  expect(c.submitted.map((s) => s.text)).toEqual([c.herdr.texts[0].text]);
});

test("a pane that never draws claude says so, and writes nothing into his chat", async () => {
  const { body, chat } = await restartThrough(SHELL);
  expect(body.ok).toBe(false);
  expect(body.verdict).toBe("nothing");
  expect(body.tell).toMatch(/cannot say/i);
  /* THE POINT OF THIS ONE. A toast is gone in eight seconds; this sentence would
   * have been in the transcript for good, on a session that may well have
   * restarted perfectly. */
  expect(chat).toEqual([]);
});

test("a shell that says there is no such conversation reaches the app as that verdict", async () => {
  /* The reported symptom, end to end: the pane said there was no such
   * conversation while the app said it had restarted. It is the one restart
   * failure that names itself, so it is READ rather than waited out -- and it
   * does earn a line in his history, because we watched it happen. */
  const { body, chat } = await restartThrough(NO_CONVERSATION);
  expect(body.ok).toBe(false);
  expect(body.verdict).toBe("no-session");
  expect(body.tell).toMatch(/no such conversation/i);
  expect(chat).toEqual([body.tell]);
});

test("a restart for a session this engine does not have is a 404, and types nothing", async () => {
  const c = await wireCore({ with: ["delivery"] });
  core = c;
  await until(() => c.sessions.size === 1, { what: "the pane to reconcile" });
  http = serveRoutes({ groups: [sessionOpsRoutes], ctx: { adapter: c.adapter } });

  const res = await http.post("/session/w9:p99/restart", { mode: "fresh" });
  expect(res.status).toBe(404);
  expect((await res.json()).error).toBe("no such session");
  expect(c.herdr.keys, "keys were pressed at a pane on behalf of a session that does not exist")
    .toEqual([]);
});

test("resume is refused by name when this engine has never seen a session id", async () => {
  /* Without one, `--resume` opens claude's own picker in the terminal: a chooser
   * nobody in the app can answer, in a pane that had a working agent a moment
   * ago. Refused by name instead, and nothing is typed. */
  const c = await wireCore({ with: ["delivery"], noSession: [PANE] });
  core = c;
  await until(() => c.sessions.size === 1, { what: "the pane to reconcile" });
  http = serveRoutes({ groups: [sessionOpsRoutes], ctx: { adapter: c.adapter } });

  const res = await http.post(`/session/${encodeURIComponent(wireId(PANE))}/restart`, { mode: "resume" });
  expect(res.status).toBe(400);
  expect(String((await res.json()).error)).toMatch(/nothing to resume/i);
  expect(c.herdr.keys).toEqual([]);
  expect(c.herdr.texts).toEqual([]);
});

// ------------------------------- 6. a slow-quitting harness gets its own window

/* THE DEFECT THIS SECTION EXISTS FOR (one host, w1:p4).
 *
 * A resume-mode restart of a pi session refused at the QUIT step -- `{"ok":false,
 * "verdict":"refused","error":"...it is still running in the terminal and did not
 * take ctrl+c..."}` -- and the journal showed `quitting (resume)` with no
 * relaunch. Shortly AFTER the refusal the pi pane was gone: pi took the ctrl+c
 * presses and DID quit, just slower than the ladder's gone-wait, because it
 * flushes and cleans up on SIGINT. claude/codex/opencode quit inside the window
 * and restart fine.
 *
 * The fix gives each harness its OWN gone-wait ceiling (readers/pi.ts quit.waitMs,
 * resolved in pane-deliver.ts). It is only a ceiling -- waitForAgentGone returns
 * the instant the agent leaves -- so a prompt quit is never slowed; a slow one is
 * simply allowed a wider window before the honest refusal, which still fires for
 * a harness that genuinely will not quit.
 *
 * These drive the real route over a real pane, with the agent made to leave the
 * mux listing at a controlled real moment: past the default window, and either
 * inside or outside the harness's own window.
 */

/* Windows small enough to be a fast test but ordered the way production's are:
 * the default (claude/codex/opencode) window is short, pi's is several times it,
 * and the agent leaves the listing in the gap between them.
 *
 * GONE_AFTER_MS is the ONE real sleep in this file, and deliberately under the
 * gates.test.ts real-sleep ceiling (250ms): the gone-wait is wall-clock -- there
 * is no logical clock inside waitForAgentGone to advance -- so the agent leaving
 * "late" can only be a short true wait, kept a comfortable margin past the 50ms
 * default window and well under pi's 800ms one. */
const GONE_DEFAULT_MS = "50";
const GONE_PI_MS = "800";
const GONE_AFTER_MS = 150;

/** Restart one harness's pane fresh. When `goesAway`, its agent leaves the
 *  listing GONE_AFTER_MS after the three ctrl+c presses (late, but real);
 *  otherwise it never leaves. Returns the route's own JSON. */
async function restartWhenGone(agent: string, goesAway: boolean): Promise<any> {
  const c = await wireCore({ with: ["delivery"], agents: { [PANE]: agent } });
  core = c;
  await until(() => c.sessions.size === 1, { what: "the pane to reconcile" });
  http = serveRoutes({ groups: [sessionOpsRoutes], ctx: { adapter: c.adapter } });

  const post = http.post(`/session/${encodeURIComponent(wireId(PANE))}/restart`, { mode: "fresh" });
  /* The quit is per harness now: claude presses ctrl+c three times, pi presses
   * ctrl+c then a single ctrl+d (readers/pi.ts quit.keys). Wait for the LAST key
   * of this harness's sequence before making the agent leave, so the timing is
   * the same shape for both -- the agent goes only after the quit is pressed. */
  const lastQuitKey = agent === "pi" ? "ctrl+d" : "ctrl+c";
  const wantCount = agent === "pi" ? 1 : 3;
  await until(() => c.herdr.keys.filter((k) => k.keys.includes(lastQuitKey)).length >= wantCount,
    { what: `the quit keystrokes for ${agent}` });
  if (goesAway) {
    await new Promise<void>((r) => setTimeout(r, GONE_AFTER_MS));
    await c.herdr.setAgentGone(PANE, true);
    c.hooks.setScreen!(PANE, await freshClaude(100));
  }
  return (await post).json();
}

/** Set the two gone-wait knobs for the duration of one test, then put them back
 *  (the file-wide LADDER's CYC_RESTART_GONE_MS included). */
async function withGoneWindows<T>(def: string, pi: string, body: () => Promise<T>): Promise<T> {
  const prior = { def: process.env.CYC_RESTART_GONE_MS, pi: process.env.CYC_RESTART_GONE_MS_PI };
  process.env.CYC_RESTART_GONE_MS = def;
  process.env.CYC_RESTART_GONE_MS_PI = pi;
  try { return await body(); }
  finally {
    if (prior.def === undefined) delete process.env.CYC_RESTART_GONE_MS;
    else process.env.CYC_RESTART_GONE_MS = prior.def;
    if (prior.pi === undefined) delete process.env.CYC_RESTART_GONE_MS_PI;
    else process.env.CYC_RESTART_GONE_MS_PI = prior.pi;
  }
}

test("pi leaving the listing after the default window but within its own is relaunched", async () => {
  const body = await withGoneWindows(GONE_DEFAULT_MS, GONE_PI_MS,
    () => restartWhenGone("pi", true));
  /* It quit late -- past the window claude gets -- and still came back: the
   * command was typed and the pane drew its box, so the refusal never fired. */
  expect(body.verdict).toBe("ready");
  expect(body.ok).toBe(true);
});

test("the same slow quit on claude still refuses: the default window is unchanged", async () => {
  /* THE CONTRAST. Identical real timing, a claude pane: claude declares no
   * override, so it keeps the short default window and the refusal fires -- the
   * one honest answer for a harness that has not left the listing yet. pi's
   * wider window is the only reason its restart above survived the same quit. */
  const body = await withGoneWindows(GONE_DEFAULT_MS, GONE_PI_MS,
    () => restartWhenGone("claude", true));
  expect(body.verdict).toBe("refused");
  expect(body.ok).toBe(false);
  expect(String(body.error)).toMatch(/did not take ctrl\+c/i);
});

test("pi that never leaves the listing still gets the honest refusal", async () => {
  /* The window is wider, not infinite. A pi that genuinely will not quit runs
   * its own ceiling out and is refused, the same true answer claude gets -- so
   * the fix never turns a wedged terminal into a claimed restart. */
  const body = await withGoneWindows(GONE_DEFAULT_MS, "120",
    () => restartWhenGone("pi", false));
  expect(body.verdict).toBe("refused");
  expect(body.ok).toBe(false);
  expect(String(body.error)).toMatch(/did not take ctrl\+c/i);
});

// ------------------------------- 7. the quit KEYS are per harness

/* THE DEFECT THIS SECTION EXISTS FOR (measured on one host).
 *
 * pi does NOT quit on ctrl+c at all: three ctrl+c presses 500ms apart into a
 * live idle pi pane leave it alive 60s later, still listed. pi's quit is EOF --
 * ONE ctrl+d at an empty input exits it -- so the default ladder's ctrl+c-only
 * quit can never take pi down, and Fix 1's wider gone-wait cannot help a quit
 * that never begins. Fix 2 gives each harness its own quit KEY sequence
 * (readers/pi.ts quit.keys), pressed once through by pane-deliver.ts.
 *
 * These read the keystrokes the restart actually pressed at the pane. The
 * trailing `enter` is the command submit, not part of the quit, so it is
 * dropped; what remains is the quit sequence exactly as it went to the mux. */
const quitKeysPressed = (): string[][] =>
  core!.herdr.keys.filter((k) => !k.keys.includes("enter")).map((k) => k.keys);

test("the default harness quit is byte-identical: exactly three ctrl+c, no ctrl+d", async () => {
  /* THE REGRESSION PIN. claude declares no quit keys, so the seam must resolve
   * to the SHIPPED behavior unchanged: RESTART_QUIT_PRESSES (3) presses of the
   * interrupt verb, ctrl+c, and nothing else. If this ever records anything but
   * three ctrl+c the default path drifted. A window wide enough for the late
   * (but real) quit so it confirms and relaunches, the same as a prompt quit
   * would; the quit KEYS are what this pins, not the timing. */
  const body = await withGoneWindows(GONE_PI_MS, GONE_PI_MS,
    () => restartWhenGone("claude", true));
  expect(body.verdict).toBe("ready");
  expect(quitKeysPressed()).toEqual([["ctrl+c"], ["ctrl+c"], ["ctrl+c"]]);
});

test("pi's quit is ctrl+c then a single ctrl+d, once each, and then it relaunches", async () => {
  /* pi's declared sequence, pressed ONCE through: ctrl+c clears any pending
   * input, the single ctrl+d at the then-empty box is the quit. Never a second
   * ctrl+d -- after pi exits the pane holds a shell and another ctrl+d would
   * close the pane itself. Once pi leaves the listing the command is typed and
   * the box drawn, so the restart is confirmed. */
  const body = await withGoneWindows(GONE_DEFAULT_MS, GONE_PI_MS,
    () => restartWhenGone("pi", true));
  expect(quitKeysPressed()).toEqual([["ctrl+c"], ["ctrl+d"]]);
  expect(quitKeysPressed().filter((k) => k.includes("ctrl+d"))).toHaveLength(1);
  expect(body.verdict).toBe("ready");
  expect(body.ok).toBe(true);
});
