/* Does a FROZEN page still look like a watching user?
 *
 * This is the measurement behind notifyUnlessWatched in server.ts. The bug it
 * exists to settle: a reply arrived seconds after the app was minimised on the
 * Android tablet and no notification came, because the engine had been told
 * "visible" moments earlier and believed it for 25 seconds. Diagnosing that by
 * buzzing a real phone is not a debugging strategy, so the questions are asked
 * of a real browser here instead:
 *
 *   1. does a frozen page's websocket CLOSE, and how fast? (if it closed
 *      promptly, socket liveness alone would be the whole fix)
 *   2. does a frozen page still answer a PROTOCOL ping with a pong? (if the
 *      browser's network stack answers, a pong is a lie and cannot be proof;
 *      if the page answers, pong is free proof and needs no app change)
 *   3. does the engine notify anyway, and how late?
 *
 * Chromium's Page.setWebLifecycleState("frozen") is the same freeze Android
 * Chrome applies when you leave the app, which is the platform the bug was
 * reported on. iOS cannot be driven from here; the design deliberately does not
 * depend on anything iOS-specific.
 *
 * Nothing real is touched: a throwaway copy of the engine runs on its own port
 * with its own .run directory, its own fake herdr socket, and a local sink
 * standing in for the app server, so no device is ever pushed to.
 *
 *   bun run agent-engine/src/freeze-probe.ts            # 10s beat, like the app
 *   BEAT_MS=3000 bun run agent-engine/src/freeze-probe.ts
 */

import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PANE, startEngine } from "./harness.ts";

const BEAT_MS = Number(process.env.BEAT_MS ?? 10_000);

const PLAYWRIGHT_CANDIDATES = [
  "/opt/homebrew/lib/node_modules/playwright/index.mjs",
  "/Users/example/projects/personal/callyourcode-app/node_modules/.pnpm/playwright@1.61.0/node_modules/playwright/index.mjs",
];

const log = (...a: unknown[]) => console.log(...a);

async function loadChromium() {
  for (const p of PLAYWRIGHT_CANDIDATES) {
    try {
      const mod = await import(p);
      return mod.chromium;
    } catch { /* try the next one */ }
  }
  throw new Error("playwright not found; tried:\n  " + PLAYWRIGHT_CANDIDATES.join("\n  "));
}

// The page: the app's client protocol, reduced to what the notify decision
// looks at. Its own beat cadence, so the engine's measured-beat logic is
// exercised rather than assumed.
const CLIENT_HTML = (beatMs: number) => `<!doctype html><title>probe</title>
<body>frozen-probe</body>
<script>
window.__ev = [];
const ws = window.ws = new WebSocket('ws://' + location.host + '/ws');
ws.onopen = () => {
  ws.send(JSON.stringify({t: 'hello'}));
  ws.send(JSON.stringify({t: 'attach', id: '${PANE}', since: 0}));
  ws.send(JSON.stringify({t: 'visible', on: true}));
  window.__ev.push(['open', Date.now()]);
};
ws.onmessage = (e) => {
  let m; try { m = JSON.parse(e.data); } catch { return; }
  window.__ev.push([m.t, Date.now()]);
  // NOT implemented on purpose in the released app: this is the one-line
  // change that turns a 12s worst case into 200ms, and the probe reports the
  // difference by running with and without it.
  if(m.t === 'ping' && window.__answerPing) ws.send(JSON.stringify({t: 'pong', n: m.n}));
};
setInterval(() => { if(!document.hidden) ws.send(JSON.stringify({t: 'visible', on: true})); }, ${beatMs});
</script>`;

async function main() {
  const chromium = await loadChromium();
  let engine: Awaited<ReturnType<typeof startEngine>> | null = null;
  let browser: any = null;
  const logFile = join(tmpdir(), "cyc-freeze-probe.log");

  try {
    // a throwaway engine: own port, own .run, own herdr, own "app server", and
    // the probe page served from the engine's own origin
    engine = await startEngine({ page: CLIENT_HTML(BEAT_MS) });
    const { lines, sink, since } = engine;
    log(`engine up on :${engine.port}`);

    const sess = await engine.session(); // the session whose replies we test

    browser = await chromium.launch();
    const context = await browser.newContext();
    const page = await context.newPage();
    page.on("console", (m: any) => log(`  [page] ${m.type()}: ${m.text()}`));
    page.on("pageerror", (e: any) => log(`  [page] error: ${e.message}`));
    const res = await page.goto(`${engine.http}/probe.html`);
    log(`page loaded: http ${res?.status()}`);
    const cdp = await context.newCDPSession(page);

    // two beats, so the engine has MEASURED this page's cadence rather than
    // assuming it
    log(`waiting ${(BEAT_MS * 2) / 1000}s for two heartbeats (beat=${BEAT_MS}ms)`);
    await Bun.sleep(BEAT_MS * 2 + 500);
    log(`client events: ${JSON.stringify(await page.evaluate("window.__ev"))}`);
    if (!lines.some((l) => l.includes("[client] +"))) {
      throw new Error("the probe page never connected as a client:\n" + lines.join("\n"));
    }

    const reply = async (text: string) => {
      const at = Date.now();
      sess.send(JSON.stringify({ t: "chat", text, msgId: crypto.randomUUID() }));
      return at;
    };
    const pushedSince = (at: number) => sink.hits.filter((h) => h.at >= at);

    const results: string[] = [];

    // ---- 1. a page that really is watching
    log("\n=== case 1: page live and watching the chat");
    let at = await reply("case 1 live");
    await Bun.sleep(3000);
    const live = since(at).filter((l) => l.includes("[notify]"));
    log(live.join("\n"));
    results.push(`live watcher: ${pushedSince(at).length === 0 ? "SUPPRESSED (correct)" : "notified (wrong)"} ` +
      `after ${live.find((l) => l.includes("suppress")) ? "proof" : "no proof"}`);

    /* ---- 2. the reported bug, under two different meanings of "frozen"
     *
     * "frozen" is not one thing, so both are tried and reported separately:
     *
     *   lifecycle    Page.setWebLifecycleState("frozen"), what Android Chrome
     *                does to a page when you leave the app.
     *   no script    Emulation.setScriptExecutionDisabled, a harder stop: the
     *                page's javascript cannot run at all, which is the worst
     *                case the engine has to survive.
     *
     * Each is tested TIGHT (the reply lands within a beat of the freeze, which
     * is the case that used to go silent for 25 seconds) and STALE (the reply
     * lands several beats later, which the old rule eventually got right). */
    const freezeCase = async (
      name: string,
      freeze: () => Promise<unknown>,
      thaw: () => Promise<unknown>,
    ) => {
      log(`\n=== ${name}`);
      const frozenAt = Date.now();
      await freeze();

      // TIGHT: the claim is still young, so the engine must wait for a beat
      // that never comes and notify anyway.
      let a = await reply(`${name} tight`);
      await Bun.sleep(BEAT_MS + 6500);
      const tight = since(a);
      log(tight.filter((l) => l.includes("[notify]") || l.includes("[client]")).join("\n"));
      const hit = pushedSince(a)[0];
      results.push(`${name}, reply within a beat: ${hit ? `NOTIFIED after ${hit.at - a}ms` : "NOT NOTIFIED (this is the bug)"}`);

      const beats = since(frozenAt).filter((l) => l.includes("[notify] beat")).length;
      results.push(`  ...and the freeze really stopped the page: ${beats === 0 ? "yes" : `NO, ${beats} beat(s) got through, so this case proves nothing`}`);
      const decision = tight.find((l) => l.includes("[notify] send") || l.includes("[notify] suppress")) ?? "";
      const pong = /pong=([^\s)]+)/.exec(decision)?.[1] ?? "?";
      results.push(`  ...protocol pong while frozen: ${pong === "none"
        ? "NONE (a pong would be real proof of a live page)"
        : `${pong} (the network stack answers, so a pong proves nothing)`}`);
      const closed = since(frozenAt).find((l) => l.includes("[client] -"));
      results.push(`  ...socket: ${closed
        ? `CLOSED ${Number(closed.split(" ")[0]) - frozenAt}ms after the freeze`
        : `still open ${Date.now() - frozenAt}ms later, so a closed socket cannot be the signal`}`);

      // STALE: several beats missed before the reply even happens
      await Bun.sleep(BEAT_MS * 2);
      a = await reply(`${name} stale`);
      await Bun.sleep(2500);
      log(since(a).filter((l) => l.includes("[notify]")).join("\n"));
      const late = pushedSince(a)[0];
      results.push(`${name}, reply several beats later: ${late ? `NOTIFIED after ${late.at - a}ms` : "NOT NOTIFIED (wrong)"}`);

      await thaw();
      await Bun.sleep(1000);
      a = await reply(`${name} thawed`);
      await Bun.sleep(BEAT_MS + 4000);
      log(since(a).filter((l) => l.includes("[notify]")).join("\n"));
      results.push(`${name}, after resuming: ${pushedSince(a).length === 0 ? "SUPPRESSED (correct)" : "notified (a redundant banner)"}`);
    };

    await freezeCase(
      "lifecycle freeze",
      () => cdp.send("Page.setWebLifecycleState", { state: "frozen" }),
      () => cdp.send("Page.setWebLifecycleState", { state: "active" }),
    );
    await freezeCase(
      "no script at all",
      () => cdp.send("Emulation.setScriptExecutionDisabled", { value: true }),
      () => cdp.send("Emulation.setScriptExecutionDisabled", { value: false }),
    );

    // ---- 3. the ordinary case: the page DID get its "I am going away" out
    log("\n=== case 3: page said it was backgrounded (the frame got through)");
    await page.evaluate("ws.send(JSON.stringify({t:'visible', on:false}))");
    await Bun.sleep(200);
    at = await reply("case 3 backgrounded");
    await Bun.sleep(1500);
    log(since(at).filter((l) => l.includes("[notify]")).join("\n"));
    const bg = pushedSince(at)[0];
    results.push(`said backgrounded: ${bg ? `NOTIFIED after ${bg.at - at}ms` : "NOT NOTIFIED (wrong)"}`);
    await page.evaluate("ws.send(JSON.stringify({t:'visible', on:true}))");
    await Bun.sleep(200);

    // ---- 4. the page answers the ping: how fast can this be?
    log("\n=== case 4: same, with the app answering the ping (the app-repo ask)");
    await page.evaluate("window.__answerPing = true");
    at = await reply("case 4 with pong");
    await Bun.sleep(2500);
    const fast = since(at).find((l) => l.includes("[notify] suppress"));
    log(fast ?? since(at).filter((l) => l.includes("[notify]")).join("\n"));
    results.push(`with an app-level pong: ${/after ([\d.]+s)/.exec(fast ?? "")?.[1] ?? "no suppression"} to decide`);

    // ---- 5. the page is gone entirely
    log("\n=== case 5: page closed (socket closes)");
    await page.close();
    await Bun.sleep(500);
    at = await reply("case 5 closed");
    await Bun.sleep(2000);
    log(since(at).filter((l) => l.includes("[notify]")).join("\n"));
    const gone = pushedSince(at)[0];
    results.push(`closed page: ${gone ? `NOTIFIED after ${gone.at - at}ms` : "NOT NOTIFIED (wrong)"}`);

    log("\n===== summary =====");
    for (const r of results) log("  " + r);
    log(`\nfull engine log: ${logFile}`);
  } finally {
    await browser?.close().catch(() => {});
    // the log is the point of the run, so it is written out before the engine's
    // scratch directory goes
    await writeFile(logFile, (engine?.lines ?? []).join("\n")).catch(() => {});
    await engine?.stop();
  }
}

await main();
