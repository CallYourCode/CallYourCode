/* THE USAGE-CARD PLUGIN'S RENDER, against every limits shape it will meet.
 *
 * renderUsageCard is pure in (report, now), so this asserts the exact strings
 * and bar widths with no engine and no clock. The report shapes are the ones
 * limits.ts actually produces: a fresh success, a stale-but-retrying reading, a
 * throttled reading that kept its numbers, a throttle with none, a signed-out
 * engine, and a dead network (limits.ts:556-597, staleFrom at :330).
 *
 *   bun test agent-engine/src/plugins/usage-card/usage-card.test.ts
 */

import { afterEach, beforeEach, test, expect } from "bun:test";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { renderUsageCard, usageDedupe, usageCardPlugin, pollLimitsOnce, __usageCardTest, type UsagePollDeps } from "./index.ts";
import { pluginDecl } from "../registry.ts";
import { tmpDir } from "../../test-utils/tmp.ts";
import { until, settle } from "../../test-utils/wait.ts";
import { manualClock } from "../../runtime/clock.ts";
import type { PluginCore } from "../platform/core.ts";
import type { HarnessInfo } from "../../runtime/capabilities.ts";
import type { LimitsReport } from "../../storage/limits";

/* __usageCardTest.reset() IS this module's resetForTest: it drops the injected
 * source, the in-memory cache and the floor anchor. Every test gets a cache file
 * of its own too, so the "a new engine finds the last-good on disk" test cannot
 * be handed another test's file. */
let cacheFile = "";
beforeEach(async () => {
  cacheFile = join(await tmpDir("usage-card-"), "state", "usage-card.json");
  __usageCardTest.setCacheFile(cacheFile);
  __usageCardTest.reset();
});
afterEach(() => {
  __usageCardTest.reset();
});

const NOW = 1_700_000_000_000;
const iso = (msFromNow: number) => new Date(NOW + msFromNow).toISOString();

const FRESH: LimitsReport = {
  ok: true,
  email: "sam@example.com",
  plan: "Max",
  windows: [
    { label: "5 hours", pct: 20, resetsAt: iso(2 * 3600_000) },
    { label: "week", pct: 55, resetsAt: iso(3 * 86_400_000) },
    { label: "week (Fable)", pct: 85, resetsAt: iso(30 * 60_000) },
  ],
  fetchedAt: NOW - 30_000, // 30s: reads as "just now"
};

test("fresh: email, shortened labels, bar widths, severity, resets; not stale", () => {
  const { html, ageMs, stale, throttled } = renderUsageCard(FRESH, NOW);
  expect(ageMs).toBe(30_000);
  expect(html).toContain("sam@example.com");
  // labels shortened the way the app shortened them
  expect(html).toContain(">5 hr<");
  expect(html).toContain(">week<");
  expect(html).toContain(">fable<"); // "week (Fable)" -> lowercased model
  // widths clamped 0..100 and taken from pct
  expect(html).toContain("width:20%");
  expect(html).toContain("width:55%");
  expect(html).toContain("width:85%");
  // percentages
  expect(html).toContain(">20%<");
  expect(html).toContain(">85%<");
  // severity: 55 warm, 85 hot, 20 neither
  expect(html).toContain("uc-fill uc-warm");
  expect(html).toContain("uc-fill uc-hot");
  // resets
  expect(html).toContain("resets in 2h");
  expect(html).toContain("resets in 3d");
  expect(html).toContain("resets in 30m");
  // freshness is app chrome now (#577): a fresh reading is neither stale nor
  // throttled, and the age text is NOT baked into the frame
  expect(stale).toBe(false);
  expect(throttled).toBe(false);
});

test("the face carries no age text: the app owns the age line (#577)", () => {
  // the srcdoc cannot tick, so the age moved out to app chrome. The frame must
  // not bake "just now"/"Xm ago"/"(retrying)"/"(check throttled)" or .uc-when.
  for(const fetchedAt of [NOW - 30_000, NOW - 3 * 60_000, NOW - 10 * 60_000]) {
    const { html } = renderUsageCard({ ...FRESH, fetchedAt }, NOW);
    expect(html).not.toContain("just now");
    expect(html).not.toContain("ago");
    expect(html).not.toContain("retrying");
    expect(html).not.toContain("throttled");
    expect(html).not.toContain("uc-when");
  }
});

test("stale retrying: numbers stay, stale=true and not throttled", () => {
  const s: LimitsReport = { ...FRESH, stale: true, error: "unreachable", fetchedAt: NOW - 10 * 60_000 };
  const { html, stale, throttled } = renderUsageCard(s, NOW);
  expect(html).toContain("sam@example.com"); // bars still drawn
  expect(html).toContain("width:55%");
  expect(stale).toBe(true);
  expect(throttled).toBe(false);
});

test("stale throttled: the throttle is named as ours, numbers stay", () => {
  const t: LimitsReport = { ...FRESH, stale: true, error: "rate limited", fetchedAt: NOW - 8 * 60_000 };
  const { html, stale, throttled } = renderUsageCard(t, NOW);
  expect(html).toContain("width:20%"); // still has its numbers
  expect(stale).toBe(true);
  expect(throttled).toBe(true);
});

test("throttled (reason) with no numbers: 'could not check' and our-throttle wording", () => {
  const r: LimitsReport = { ok: false, error: "rate limited", reason: "throttled", fetchedAt: NOW };
  const { html } = renderUsageCard(r, NOW);
  expect(html).toContain("could not check");
  expect(html).toContain("our check for these numbers was throttled");
  expect(html).not.toContain("not signed in");
});

test("legacy 429 string with NO reason still reads as throttled (mixed-version tailnet)", () => {
  const r: LimitsReport = { ok: false, error: "rate limited", fetchedAt: NOW };
  const { html } = renderUsageCard(r, NOW);
  expect(html).toContain("could not check");
  expect(html).not.toContain("not signed in");
});

test("signed out (reason): 'not signed in' with the engine's own words underneath", () => {
  const r: LimitsReport = { ok: false, error: "token expired, sign in again on this machine",
    reason: "signed-out", fetchedAt: NOW };
  const { html } = renderUsageCard(r, NOW);
  expect(html).toContain("not signed in");
  expect(html).toContain("token expired, sign in again on this machine");
});

/* #602 THE HONESTY BUG. renderUsageCard runs ENGINE-side; limits.ts mints these
 * exact error strings, none of which the old app-side string match caught, so
 * every one fell through to "not signed in". Now they key on reason:"network"
 * and say "can't check right now", asserting nothing about the account. */
for (const error of ["The operation timed out", "usage http 503", "fetch failed", "unreachable"]) {
  test(`network failure (${error}) says "can't check", never "not signed in"`, () => {
    const r: LimitsReport = { ok: false, error, reason: "network", fetchedAt: NOW };
    const { html } = renderUsageCard(r, NOW);
    expect(html).toContain("check right now");
    expect(html).not.toContain("not signed in");
  });
}

test("unknown reason (an un-typed older failure) also says 'can't check', never 'not signed in'", () => {
  const r: LimitsReport = { ok: false, error: "the last attempt on this machine failed",
    reason: "unknown", fetchedAt: NOW };
  const { html } = renderUsageCard(r, NOW);
  expect(html).toContain("check right now");
  expect(html).not.toContain("not signed in");
});

test("no scripts: the card fragment carries no <script>, only inline style", () => {
  const { html } = renderUsageCard(FRESH, NOW);
  expect(html.toLowerCase()).not.toContain("<script");
  expect(html).toContain("<style>");
});

test("html is escaped: an email with markup cannot inject", () => {
  const r: LimitsReport = { ok: true, email: "<img src=x>@e.com", windows: [], fetchedAt: NOW };
  const { html } = renderUsageCard(r, NOW);
  expect(html).not.toContain("<img src=x>");
  expect(html).toContain("&lt;img");
});

test("ageMs is a duration and never negative; null when undated", () => {
  /* A reading stamped in the FUTURE has no knowable age: null, never 0. The
   * clamp-to-0 drew numbers of unknown age as brand new (the /limits route
   * carried this rule; it moved here when that route died). */
  expect(renderUsageCard({ ...FRESH, fetchedAt: NOW + 5000 }, NOW).ageMs).toBeNull();
  expect(renderUsageCard({ ok: true, windows: [], fetchedAt: NaN as unknown as number }, NOW).ageMs).toBeNull();
});

test("dedupe: one card per account, lowercased, null when signed out", () => {
  const a = usageDedupe({ ok: true, email: "Sam@Example.com", fetchedAt: NOW });
  const b = usageDedupe({ ok: true, email: "sam@example.com", fetchedAt: NOW });
  expect(a).toBe(b as string); // case-folded to one key
  expect(a).toMatch(/^[0-9a-f]{16}$/);
  expect(usageDedupe({ ok: false, error: "x", fetchedAt: NOW })).toBeNull();
  expect(usageDedupe(null)).toBeNull();
});

test("the phone reset cap is 7rem, wide enough for a full 5-hour reset (#570)", () => {
  // his laptop showed "resets in 2h 20m" clipped to "2..."; the root cause was a
  // font spread (fixed app-side), but the frame's own 6rem phone cap ALSO clipped
  // that ~101px string to "resets in 2h 2..." on a narrow card. 7rem (112px)
  // clears it. This asserts the cap the frame carries, since a pure render cannot
  // lay out pixels.
  const { html } = renderUsageCard(FRESH, NOW);
  expect(html).toContain("@media(max-width:600px){.uc-reset{max-width:7rem}}");
  expect(html).not.toContain("max-width:6rem");
});

/* #602 THE ENGINE DECOUPLE. Serving the card must not recompute the usage
 * inline: render() returns the cached render at once even when the upstream is
 * slow or failing, and the recompute runs on its own cadence, floored, so N
 * fetches never cause N recomputes. The usage source is INJECTED here; the real
 * `claude` usage is never touched. */

const GOOD: LimitsReport = {
  ok: true, email: "sam@example.com", plan: "Max",
  windows: [{ label: "5 hours", pct: 42, resetsAt: null }], fetchedAt: NOW,
};

test("a NON-FORCED render stays instant even when the upstream is slow (the decouple holds)", async () => {
  __usageCardTest.reset();
  __usageCardTest.seed(GOOD);                 // a good reading is already cached
  __usageCardTest.expireFloor();              // so a background recompute is due this poll
  // a source that never resolves within the test: if a poll awaited it, this hangs
  let released!: () => void;
  __usageCardTest.setSource(() => new Promise<LimitsReport>((r) => { released = () => r(GOOD); }));

  const t0 = Date.now();
  const out = await usageCardPlugin().card!.render(); // a plain poll, not the button
  const dt = Date.now() - t0;

  expect(dt).toBeLessThan(100);               // did not block on the slow background source
  expect(out.html).toContain("sam@example.com"); // served the cache, not the pending source
  released?.();
  __usageCardTest.reset();
});

test("render returns the cached render when the upstream is FAILING (never blanks)", async () => {
  __usageCardTest.reset();
  __usageCardTest.seed(GOOD);
  __usageCardTest.setSource(async () => { throw new Error("upstream on fire"); });

  const out = await usageCardPlugin().card!.render();
  expect(out.html).toContain("sam@example.com"); // the throw did not empty the cache
  // let the scheduled (rejecting) recompute settle; the cache must still hold
  await settle();
  expect(__usageCardTest.cache()).toBe(GOOD);
});

test("N fetches are NOT N recomputes: the floor is honored across a burst", async () => {
  __usageCardTest.reset();
  let calls = 0;
  __usageCardTest.setSource(async () => { calls++; return GOOD; });

  // first render (cold) schedules the one recompute; let it complete
  await usageCardPlugin().card!.render();
  await until(() => calls === 1, { what: "the cold render's one background recompute" });
  expect(__usageCardTest.cache()).toBe(GOOD);

  // a burst of POLLS inside the floor triggers no further recompute (force is a
  // separate path with its own contract, proven below)
  for (let i = 0; i < 8; i++) await usageCardPlugin().card!.render();
  await settle();
  expect(calls).toBe(1);

  // once the floor has elapsed, the next fetch recomputes exactly once more
  __usageCardTest.expireFloor();
  await usageCardPlugin().card!.render();
  await until(() => calls === 2, { what: "one more recompute after the floor elapsed" });
  await settle();
  expect(calls).toBe(2); // and exactly once more, not once per fetch
});

/* #479 THE REFRESH BUTTON'S CONTRACT. The decouple above made a plain poll
 * instant, but it broke the button: a forced fetch got the OLD cache back and
 * the real recompute landed only after the response, so the spinner stopped on
 * stale numbers, and a press inside the floor did nothing at all. A force now
 * AWAITS the recompute (bounded) and the RESPONSE carries the new numbers. */

test("force fetch goes upstream and returns the NEW report, not the stale cache", async () => {
  __usageCardTest.reset();
  __usageCardTest.seed(GOOD);                     // an old reading is already cached
  const NEXT: LimitsReport = { ...GOOD, email: "next@example.com" };
  __usageCardTest.setSource(async () => NEXT);    // upstream now answers with new numbers

  const out = await usageCardPlugin().card!.render({ force: true });
  expect(out.html).toContain("next@example.com"); // the response carried the fresh read
  expect(out.html).not.toContain("sam@example.com"); // not the stale cache the button used to get
});

test("force within the floor of a background refresh still re-reads upstream", async () => {
  __usageCardTest.reset();
  let calls = 0;
  __usageCardTest.setSource(async () => { calls++; return { ...GOOD, email: `r${calls}@e.com` }; });

  // a background (non-forced) recompute lands, setting the floor's anchor to now
  await usageCardPlugin().card!.render();
  await until(() => calls === 1, { what: "the background recompute" });

  // well inside the 5s floor, the user hits refresh: the floor stops poll bursts,
  // not the button, so the force re-reads upstream instead of being swallowed
  const out = await usageCardPlugin().card!.render({ force: true });
  expect(calls).toBe(2);
  expect(out.html).toContain("r2@e.com");
});

test("force while a recompute is in flight shares it: the source is read once", async () => {
  __usageCardTest.reset();
  __usageCardTest.seed(GOOD);
  __usageCardTest.expireFloor();
  let calls = 0;
  let release!: (r: LimitsReport) => void;
  __usageCardTest.setSource(() => { calls++; return new Promise<LimitsReport>((r) => { release = r; }); });

  // a background recompute is now in flight (the source has been read once)
  const bg = __usageCardTest.refresh(false);
  expect(calls).toBe(1);

  // the user presses refresh mid-flight: it must AWAIT the running read, not open
  // a second upstream read
  const forced = usageCardPlugin().card!.render({ force: true });
  await settle();
  expect(calls).toBe(1);

  release({ ...GOOD, email: "shared@e.com" });
  await bg;
  const out = await forced;
  expect(calls).toBe(1);                          // still exactly one read, shared
  expect(out.html).toContain("shared@e.com");     // and the force drew its result
});

test("force with a hung source returns the last-good after the bound, never blank", async () => {
  __usageCardTest.reset();
  __usageCardTest.seed(GOOD);
  __usageCardTest.setForceTimeout(50);            // bound the wait so the test is fast
  __usageCardTest.setSource(() => new Promise<LimitsReport>(() => {})); // never resolves

  const t0 = Date.now();
  const out = await usageCardPlugin().card!.render({ force: true });
  const dt = Date.now() - t0;

  expect(dt).toBeGreaterThanOrEqual(45);          // it waited for the bound, then gave up
  expect(dt).toBeLessThan(2000);                  // and did not hang on the dead source
  expect(out.html).toContain("sam@example.com");  // served the last-good cache, not a blank
  __usageCardTest.reset();
});

test("cold render (no cache yet) never blanks and never claims logged-out", async () => {
  __usageCardTest.reset();
  __usageCardTest.setSource(() => new Promise<LimitsReport>(() => {})); // never resolves
  const out = await usageCardPlugin().card!.render();
  expect(out.html.length).toBeGreaterThan(0);     // a face, not empty
  expect(out.html).toContain("check right now");
  expect(out.html).not.toContain("not signed in");
  __usageCardTest.reset();
});

test("restart with a cold in-memory cache serves the persisted last-good and schedules a refresh", async () => {
  __usageCardTest.setSource(async () => GOOD);
  await __usageCardTest.refresh();                // compute and persist the last-good card

  __usageCardTest.reset();                        // a new engine process, same .run file
  let calls = 0;
  __usageCardTest.setSource(async () => { calls++; return GOOD; });
  const out = await usageCardPlugin().card!.render();

  expect(out.html).toContain("sam@example.com"); // served disk before the refresh lands
  await until(() => calls === 1, { what: "the background recompute after a restart" });
});

/* ---- the render's own arithmetic and escaping, with no cache in sight ---- */

test("the reset countdown reads in the unit that answers 'how long have I got'", () => {
  const at = (msFromNow: number) => ({
    ok: true as const, email: "s@e.com", fetchedAt: NOW,
    windows: [{ label: "5 hours", pct: 10, resetsAt: iso(msFromNow) }],
  });
  const resetOf = (r: LimitsReport) => /class="uc-reset">([^<]*)</.exec(renderUsageCard(r, NOW).html)?.[1] ?? "";
  expect(resetOf(at(45 * 60_000))).toBe("resets in 45m");
  expect(resetOf(at(59 * 60_000 + 20_000))).toBe("resets in 59m"); // rounds to the minute
  expect(resetOf(at(2 * 3600_000))).toBe("resets in 2h");          // no dangling " 0m"
  expect(resetOf(at(2 * 3600_000 + 20 * 60_000))).toBe("resets in 2h 20m");
  expect(resetOf(at(3 * 86_400_000))).toBe("resets in 3d");
  // already past, and a window with no reset at all: never a negative countdown
  expect(resetOf(at(-60_000))).toBe("resetting");
  expect(resetOf({ ok: true, fetchedAt: NOW, windows: [{ label: "week", pct: 1, resetsAt: null }] })).toBe("");
  // garbage from the endpoint is silence, not "resets in NaNm"
  expect(resetOf({ ok: true, fetchedAt: NOW, windows: [{ label: "week", pct: 1, resetsAt: "not a date" }] })).toBe("");
});

test("the bar width clamps to 0..100 while the printed percent stays honest", () => {
  /* The endpoint has answered 103% during a plan change. The BAR cannot draw
   * past its track, but rewriting the number would hide that he is over. */
  const over: LimitsReport = { ok: true, fetchedAt: NOW,
    windows: [{ label: "5 hours", pct: 103, resetsAt: null }, { label: "week", pct: -4, resetsAt: null }] };
  const { html } = renderUsageCard(over, NOW);
  expect(html).toContain("width:100%");
  expect(html).toContain("width:0%");
  expect(html).toContain(">103%<");
  expect(html).toContain(">-4%<");
});

test("the server's own severity wins over the percentage guess", () => {
  /* pct >= 80 is our fallback rule for an endpoint that says nothing. When the
   * endpoint DOES grade the window, its grade is the one the bar wears. */
  const graded: LimitsReport = { ok: true, fetchedAt: NOW, windows: [
    { label: "a", pct: 5, resetsAt: null, severity: "critical" },
    { label: "b", pct: 95, resetsAt: null, severity: "normal" },
    { label: "c", pct: 5, resetsAt: null, severity: "warning" },
  ] };
  const rows = renderUsageCard(graded, NOW).html.split(`<div class="uc-row">`).slice(1);
  expect(rows[0]).toContain("uc-fill uc-hot");   // 5% but graded critical
  expect(rows[1]).toContain(`class="uc-fill"`);  // 95% but graded normal
  expect(rows[1]).not.toContain("uc-hot");
  expect(rows[2]).toContain("uc-fill uc-warm");
});

test("the severity thresholds are inclusive at 50 and 80", () => {
  // the class off the FILL span; the stylesheet names every class, so matching
  // the whole document would pass no matter what the bar wore
  const fillClass = (pct: number) => {
    const html = renderUsageCard({ ok: true, fetchedAt: NOW, windows: [{ label: "w", pct, resetsAt: null }] }, NOW).html;
    return /<span class="(uc-fill[^"]*)"/.exec(html)?.[1] ?? "";
  };
  expect(fillClass(49)).toBe("uc-fill");
  expect(fillClass(50)).toBe("uc-fill uc-warm");
  expect(fillClass(79)).toBe("uc-fill uc-warm");
  expect(fillClass(80)).toBe("uc-fill uc-hot");
  expect(fillClass(100)).toBe("uc-fill uc-hot");
});

test("an ok reading with no email draws no account line rather than an empty one", () => {
  // limits.ts answers ok with no email when the profile call was throttled but
  // the windows came through; an empty bold span would read as a blank name
  const { html } = renderUsageCard({ ok: true, fetchedAt: NOW, windows: [] }, NOW);
  expect(html).toContain(`<div class="uc-head"></div>`);
  expect(html).not.toContain(`<span class="uc-who"`);
});

test("the reported height matches the rows the face actually drew", () => {
  // a no-JS frame cannot measure itself, so the render that knows what it drew
  // reports the px. A wrong number is a card clipped or a card with a gap.
  const rowsOf = (n: number): LimitsReport => ({ ok: true, email: "s@e.com", fetchedAt: NOW,
    windows: Array.from({ length: n }, (_v, i) => ({ label: `w${i}`, pct: i, resetsAt: null })) });
  expect(renderUsageCard(rowsOf(0), NOW).height).toBe(39);  // head (22px) + one message line
  expect(renderUsageCard(rowsOf(1), NOW).height).toBe(39);
  expect(renderUsageCard(rowsOf(2), NOW).height).toBe(57);
  expect(renderUsageCard(rowsOf(3), NOW).height).toBe(75);
  // an error face has no rows, so it is the zero-row height
  expect(renderUsageCard({ ok: false, error: "x", reason: "network", fetchedAt: NOW }, NOW).height).toBe(39);
});

test("the error sentence is escaped too, not just the account", () => {
  // `error` is the signed-out branch's message and it comes from an OAuth
  // library, so it is as untrusted as the email
  const { html } = renderUsageCard(
    { ok: false, reason: "signed-out", error: `<b>expired</b> & "gone"`, fetchedAt: NOW }, NOW);
  expect(html).not.toContain("<b>expired</b>");
  expect(html).toContain("&lt;b&gt;expired&lt;/b&gt; &amp; &quot;gone&quot;");
});

test("a window label is escaped before it becomes markup", () => {
  const { html } = renderUsageCard(
    { ok: true, fetchedAt: NOW, windows: [{ label: `<script>x</script>`, pct: 1, resetsAt: null }] }, NOW);
  expect(html.toLowerCase()).not.toContain("<script");
  expect(html).toContain("&lt;script&gt;");
});

test("signed out with no error string still says something", () => {
  const { html } = renderUsageCard({ ok: false, reason: "signed-out", fetchedAt: NOW }, NOW);
  expect(html).toContain("not signed in");
  expect(html).toContain("no limits available");
});

test("dedupe keys the ACCOUNT, so two accounts never fold into one card", () => {
  const a = usageDedupe({ ok: true, email: "a@e.com", fetchedAt: NOW });
  const b = usageDedupe({ ok: true, email: "b@e.com", fetchedAt: NOW });
  expect(a).not.toBe(b);
  // and it is a hash, not the email: the app learns "same account" without ever
  // learning which account
  expect(a).not.toContain("@");
  expect(usageDedupe({ ok: true, email: "", fetchedAt: NOW })).toBeNull();
});

test("dedupe reads the LAST reading, so a failed refresh does not drop the fold key", async () => {
  __usageCardTest.setSource(async () => GOOD);
  await __usageCardTest.refresh();
  expect(usageCardPlugin().card!.dedupe!()).toBe(usageDedupe(GOOD));
  // a rejecting refresh keeps the last good reading, key included
  __usageCardTest.setSource(async () => { throw new Error("upstream on fire"); });
  __usageCardTest.expireFloor();
  await __usageCardTest.refresh();
  expect(usageCardPlugin().card!.dedupe!()).toBe(usageDedupe(GOOD));
});

/* ---- the durable cache: what is allowed to reach disk, and what is not ---- */

test("a failed reading never overwrites the persisted last-good card", async () => {
  __usageCardTest.setSource(async () => GOOD);
  await __usageCardTest.refresh();
  const persisted = readFileSync(cacheFile, "utf8");

  __usageCardTest.setSource(async () => ({ ok: false, error: "usage http 503", reason: "network", fetchedAt: NOW }));
  __usageCardTest.expireFloor();
  await __usageCardTest.refresh();
  // the in-memory cache follows the new (bad) reading, but the DISK copy is what
  // the next engine boots on, and a blank card at boot is the thing to avoid
  expect(__usageCardTest.cache()!.ok).toBe(false);
  expect(readFileSync(cacheFile, "utf8")).toBe(persisted);
});

test("a torn or non-ok file on disk is ignored, and the cold face is served", async () => {
  const { writeFileSync, mkdirSync } = await import("node:fs");
  const { dirname } = await import("node:path");
  mkdirSync(dirname(cacheFile), { recursive: true });
  for (const junk of ["{not json", "null", "[]", JSON.stringify({ ok: false, fetchedAt: NOW })]) {
    writeFileSync(cacheFile, junk);
    __usageCardTest.reset();
    __usageCardTest.setSource(() => new Promise<LimitsReport>(() => {})); // never lands
    const out = await usageCardPlugin().card!.render();
    expect(out.html).toContain("check right now");
    expect(out.html).not.toContain("not signed in");
  }
});

test("an unwritable cache directory does not make serving the card fail", async () => {
  // a read-only state dir is a real deployment (a container with a ro mount);
  // the card must still render, it just has nothing to leave behind
  __usageCardTest.setCacheFile("/proc/definitely-not-writable/usage-card.json");
  __usageCardTest.setSource(async () => GOOD);
  await __usageCardTest.refresh();
  expect(__usageCardTest.cache()).toBe(GOOD);
  const out = await usageCardPlugin().card!.render();
  expect(out.html).toContain("sam@example.com");
});

test("one recompute at a time: a burst of refreshes shares the in-flight one", async () => {
  let calls = 0;
  let release!: (r: LimitsReport) => void;
  __usageCardTest.setSource(() => { calls++; return new Promise<LimitsReport>((r) => { release = r; }); });
  const all = [__usageCardTest.refresh(), __usageCardTest.refresh(), __usageCardTest.refresh()];
  expect(calls).toBe(1); // the second and third saw `refreshing` and returned
  release(GOOD);
  await Promise.all(all);
  expect(__usageCardTest.cache()).toBe(GOOD);
});

test("the decl carries the card chrome and the floor the plugin asked for", () => {
  const d = pluginDecl(usageCardPlugin())!;
  expect(d.id).toBe("usage-card");
  expect(d.card).toEqual({ title: "Plan usage", refreshFloorS: 5 });
  // render/dedupe stay engine-side: the app asks over HTTP, it does not hold them
  expect(JSON.stringify(d)).not.toContain("function");
  expect((d.card as Record<string, unknown>).render).toBeUndefined();
});

/* ========== USAGE IS A HARNESS-ACCOUNT FACT: the fold over active harnesses ====
 *
 * A fake typed core proves the render's recompute enumerates the ACTIVE harness
 * kinds (never a per-agent loop), asks each ONE ONCE for its usage, takes the
 * first UsageReport, and threads `force`. The real `claude` usage is never
 * touched. */

type UsageCall = { kind: string; force: boolean };
type EngineNotify = Parameters<PluginCore["notifyEngine"]>[0];

/* A fake PluginCore factory: only the members the usage plugin uses are real
 * (harnesses / usage / notifyEngine); the rest are cast away. Returns the shared
 * arrays so a test reads what the fold and the poll actually did. */
function fakeCore(opts: {
  harnesses: HarnessInfo[];
  usage: (kind: string) => unknown;
}): { factory: (id: string) => PluginCore; usageCalls: UsageCall[]; notified: EngineNotify[] } {
  const usageCalls: UsageCall[] = [];
  const notified: EngineNotify[] = [];
  const core = {
    harnesses: () => opts.harnesses,
    usage: async (kind: string, force = false) => { usageCalls.push({ kind, force }); return opts.usage(kind); },
    notifyEngine: async (n: EngineNotify) => { notified.push(n); },
  } as unknown as PluginCore;
  return { factory: () => core, usageCalls, notified };
}

test("the fold asks each ACTIVE harness once, in order, takes the first UsageReport, threads force", async () => {
  __usageCardTest.reset();
  // codex is active but answers no usage; claude is active and answers a report;
  // opencode is INACTIVE and must never be asked (no live agent of that kind).
  const { factory, usageCalls } = fakeCore({
    harnesses: [{ kind: "codex", active: true }, { kind: "claude", active: true }, { kind: "opencode", active: false }],
    usage: (kind) => (kind === "claude" ? GOOD : undefined),
  });
  usageCardPlugin(factory);            // the factory wires the core
  await __usageCardTest.refresh(true); // a FORCED recompute (the refresh button)

  expect(__usageCardTest.cache()).toBe(GOOD);
  // asked codex then claude, both forced; the inactive opencode was skipped
  expect(usageCalls).toEqual([{ kind: "codex", force: true }, { kind: "claude", force: true }]);
});

test("with no active harness answering usage the fold throws and the last-good cache stands", async () => {
  __usageCardTest.reset();
  __usageCardTest.seed(GOOD);
  __usageCardTest.expireFloor();
  const { factory, usageCalls } = fakeCore({
    // claude is signed in but has no LIVE agent, so it is not asked at all
    harnesses: [{ kind: "claude", active: false }],
    usage: () => GOOD,
  });
  usageCardPlugin(factory);
  await __usageCardTest.refresh(false);
  expect(usageCalls).toEqual([]);          // an inactive harness is never asked
  expect(__usageCardTest.cache()).toBe(GOOD); // the throw did not blank the cache
});

/* ========== THE PLUGIN OWNS ITS TICKER (crons-shaped, injectable clock) ======= */

function pollDeps(over: Partial<UsagePollDeps> = {}): UsagePollDeps {
  return {
    clock: manualClock(),
    phaseKey: "host:user:1",
    host: "linux",
    takeAlerts: () => [],
    nextPollAt: (now) => now + 1000, // poll every logical second
    pollPhaseMs: () => 0,
    pollIntervalMs: 60_000,
    ...over,
  };
}

test("the plugin owns its ticker: first poll fires, the grid re-schedules, dispose stops it", async () => {
  __usageCardTest.reset();
  const { factory, usageCalls } = fakeCore({
    harnesses: [{ kind: "claude", active: true }], usage: () => GOOD,
  });
  const clock = manualClock();
  const spec = usageCardPlugin(factory, pollDeps({ clock }));
  await settle();
  expect(usageCalls.length).toBe(1); // the immediate first poll ran

  await clock.advance(1000);          // the grid's next tick
  await settle();
  expect(usageCalls.length).toBe(2);

  spec.dispose!();                    // stop the loop
  await clock.advance(5000);
  await settle();
  expect(usageCalls.length).toBe(2);  // nothing fires after dispose
  expect(clock.pending).toBe(0);      // and no timer is left armed
});

/* ========== THE THRESHOLD ALERT: an engine-level notifyEngine, no sessionId ==== */

test("a crossing goes out through notifyEngine keyed by THIS plugin's id, account only in the sealed content", async () => {
  __usageCardTest.reset();
  const { factory, notified } = fakeCore({
    harnesses: [{ kind: "claude", active: true }],
    usage: () => ({ ...GOOD, email: "sam@example.com" }),
  });
  usageCardPlugin(factory); // wires the module core the fold reads (as the root does)
  const deps = pollDeps({
    host: "linux",
    takeAlerts: () => [{ label: "5 hours", pct: 93, threshold: 90, resetsAt: iso(30 * 60_000) }],
  });
  await pollLimitsOnce(factory, deps);

  expect(notified).toHaveLength(1);
  const n = notified[0];
  // THE identifier: this plugin's registered id, not an account-bearing tag
  expect(n.plugin).toBe("usage-card");
  // per-window dedup sub-key: the window label, which names no account
  expect(n.subTag).toBe("5 hours");
  // the account rides ONLY in title/body, which go into the sealed enc
  expect(n.title).toBe("93% of the 5-hour limit");
  expect(n.body).toContain("sam@example.com");
  expect(n.body).toContain("resets");
  expect(n.open).toBe("usage:linux");                    // the sealed tap target
  // the account-bearing cleartext tag is GONE (it leaked the account upstream)
  expect((n as Record<string, unknown>).tag).toBeUndefined();
  expect(n.plugin).not.toContain("sam@example.com");
  expect(n.subTag).not.toContain("sam@example.com");
  /* the cleartext usage block is GONE from the payload: it fed the app server's
   * account merge, and the merge is gone (the server forwards as-is) */
  expect((n as Record<string, unknown>).usage).toBeUndefined();
  // an engine-level alert is session-LESS: the payload must carry no sessionId
  expect((n as Record<string, unknown>).sessionId).toBeUndefined();
});

test("a poll with no live harness answering usage sends nothing (the pass is a no-op)", async () => {
  __usageCardTest.reset();
  const { factory, notified, usageCalls } = fakeCore({
    harnesses: [{ kind: "claude", active: false }],   // nothing active to read
    usage: () => GOOD,
  });
  usageCardPlugin(factory); // wires the module core the fold reads (as the root does)
  const deps = pollDeps({ takeAlerts: () => [{ label: "5 hours", pct: 93, threshold: 90, resetsAt: null }] });
  await pollLimitsOnce(factory, deps);
  expect(usageCalls).toEqual([]);   // nothing asked
  expect(notified).toEqual([]);     // and nothing pushed
});
