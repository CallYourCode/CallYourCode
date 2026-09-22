/* THE USAGE CARD, AS A PLUGIN (#479).
 *
 * The first migrated built-in, and the proof of engine-level cards. What moves
 * here is the RENDERING: the bars, the labels, the reset countdown, and the
 * stale/throttled/logged-out wording that used to be composed in the app's
 * (since removed) usage card now compose engine-side, as one
 * self-contained HTML+CSS fragment the app drops into a no-token iframe.
 *
 * WHAT STAYS CORE, drawn once so the line is not blurred: limits.ts keeps the
 * polling, the machine-wide lease and the threshold alerts. This plugin only
 * READS the last good answer (limitsNow(false), the same cached number the poll
 * serves) and paints it. It never fetches, never alerts, never writes.
 *
 * NO SCRIPT RUNS IN THE CARD, by construction: the app frames it with
 * sandbox="" and a CSP of `default-src 'none'; style-src 'unsafe-inline';
 * img-src data:`, so the fragment below is HTML and inline CSS and nothing
 * else. Every interactive part (the refresh button, the host chips) is app
 * chrome around the frame; there is nothing clickable inside it.
 *
 * The wording is PORTED, not redesigned: untilText, the severity thresholds
 * (>=80 hot, >=50 warm), and the freshness sentences are the app's own strings
 * (usageCard.ts:70-95, limitsAge.ts) moved verbatim so the card reads the same.
 *
 *   bun test agent-engine/src/plugins/usage-card/usage-card.test.ts
 */

import { createHash } from "node:crypto";
import { pluginDataDir } from "../../storage/datadir.ts";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { dirname } from "node:path";
import { mkdirPrivateSync, writeAtomicPrivateSync } from "../../../../shared/runfiles.ts";
import type { PluginSpec } from "../platform/spec.ts";
import type { PluginCore } from "../platform/core.ts";
import { realClock, type Clock } from "../../runtime/clock.ts";

/* THE CLAUDE USAGE SHAPE the card renders. It IS limits.ts's LimitsReport
 * (section 5.3: usage is an adapter fact in the harness's OWN shape, forwarded
 * through core.usage as `unknown`), mirrored here so this plugin imports NOTHING
 * from limits.ts -- the report arrives as unknown and is narrowed by
 * isLimitsReport. The alert shape rides the same way. */
export type UsageWindow = { label: string; pct: number; resetsAt: string | null; severity?: "normal" | "warning" | "critical" };
export type UsageReport = {
  ok: boolean; email?: string; plan?: string; windows?: UsageWindow[]; fetchedAt: number;
  error?: string; reason?: "signed-out" | "throttled" | "network" | "unknown"; stale?: boolean;
};
type UsageAlert = { label: string; pct: number; threshold: number; resetsAt: string | null };
/* limitsNow is loaded lazily inside render() (below), NOT imported at the top,
 * so this module's only runtime imports are node:crypto and nothing engine-heavy.
 * That lets the app's offline parity spec import renderUsageCard() to drive the
 * REAL card render against a fixture -- the same trick the crons panel spec uses
 * to import its real page (all-type-only runtime imports). */

/* HTML-escape anything that came from outside this file (the account email, an
 * error string). The card is HTML, so a stray `<` in an email would otherwise
 * be markup. */
function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    c === "&" ? "&amp;" : c === "<" ? "&lt;" : c === ">" ? "&gt;" : c === '"' ? "&quot;" : "&#39;");
}

/* "resets in 2h 10m" beats a timestamp: the question is how long you have.
 * Ported byte-for-byte from usageCard.ts:70-81. `now` is passed so the render
 * is a pure function of its inputs and testable without a clock. */
function untilText(iso: string | null, now: number): string {
  if (!iso) return "";
  const ms = Date.parse(iso) - now;
  if (!Number.isFinite(ms)) return "";
  if (ms <= 0) return "resetting";
  const mins = Math.round(ms / 60000);
  if (mins < 60) return `resets in ${mins}m`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `resets in ${hrs}h${mins % 60 ? ` ${mins % 60}m` : ""}`;
  const days = Math.round(hrs / 24);
  return `resets in ${days}d`;
}

/* The 429 is OURS, not his: `rate limited` is the usage endpoint refusing our
 * poll, and says nothing about the account. Same predicate as usageCard.ts:93. */
function throttled(l: UsageReport): boolean {
  return l.error === "rate limited";
}

/* THE AGE LINE MOVED OUT OF THE FRAME (#577 section 2). It used to be baked into
 * the srcdoc here ("3m ago"), but a no-JS frame cannot tick, so it read stale
 * for up to the poll interval and nothing ever distinguished "old but fine" from
 * "the engine is gone". The app now owns the clock: it composes the age from
 * `ageMs` with `freshnessLabel()` (limitsAge.ts) and paints it as chrome at the
 * plate's edge, re-labelling on a 60 s tick with no frame reload. The engine
 * still dates the numbers (`ageMs`) and now names WHY they are old with the two
 * booleans returned from render, so the app's wording has the same facts this
 * frame used to compose. */

/* The card is a glance: "5 hr", "week", "fable". Ported from usageCard.ts:184. */
function shortLabel(label: string): string {
  return label.replace(/^5 hours$/, "5 hr").replace(/^week \((.+)\)$/, (_m, model: string) => model.toLowerCase());
}

function barHtml(w: UsageWindow, now: number): string {
  const pct = Math.min(100, Math.max(0, w.pct));
  // the server's own severity where it has one, the percentage otherwise
  const hot = w.severity === "critical" || (!w.severity && w.pct >= 80);
  const warm = w.severity === "warning" || (!w.severity && w.pct >= 50);
  const cls = hot ? "uc-fill uc-hot" : warm ? "uc-fill uc-warm" : "uc-fill";
  const reset = untilText(w.resetsAt, now);
  return (
    `<div class="uc-row">` +
    `<span class="uc-name">${esc(shortLabel(w.label))}</span>` +
    `<span class="uc-track"><span class="${cls}" style="width:${pct}%"></span></span>` +
    `<span class="uc-pct">${w.pct}%</span>` +
    `<span class="uc-reset">${esc(reset)}</span>` +
    `</div>`
  );
}

/* THE INLINE STYLESHEET, A PORT OF THE NATIVE CARD (#479 parity).
 *
 * This is the face of the card the app used to draw in the DOM (the .cyc-usage*
 * rules in cyc.scss + the reskin overrides), reproduced here so the plugin card
 * is INDISTINGUISHABLE from it, pixel for pixel, in day and night.
 *
 * It uses the app's own tokens, which the app injects into the frame as CSS
 * variables (lib/pageSandbox.ts cardDocument): --cyc-text, --cyc-muted,
 * --cyc-border, --cyc-bar (the muted-grey normal bar the reskin paints:
 * #a3a3a8 day / #66666c night) and the app font. The frame has an opaque origin
 * and cannot read the app's tokens itself, so the earlier version guessed with
 * hardcoded iOS colours and prefers-color-scheme -- which followed the DEVICE
 * theme, not the app's, so a day app over a dark OS drew near-white text on the
 * white card (his rollback: "washed-out grey", "white box that ignores the
 * theme"). Reading the app's real tokens is the fix; the alert colours (warm,
 *
 * The refresh button and the host chips are NOT here: they are app chrome around
 * the frame (components/pluginCard.ts). Everything else the native card showed --
 * the account line, the age beside it, the bars -- is here. */
const STYLE =
  `<style>` +
  `*,*::before,*::after{box-sizing:border-box}` +
  `html,body{margin:0}` +
  `.uc{font-size:12px;line-height:1.35;color:var(--cyc-text)}` +
  // the account line: bold name + the age beside it, on the row the refresh
  // button (app chrome) floats into. That chrome is a 22px refresh button and a
  // 22px age line box, both anchored at the card's content top (top-1.5), so
  // their optical centre is at top+11px. The frame's face starts at the SAME
  // content top (border-0 iframe, no top margin), so centre the account line in
  // a matching 22px box and it lands on the chrome centre. The old 23px box with
  // flex-end bottom-aligned the account ~3.9px LOWER than the age/refresh, which
  // read as the email dropped off the row (measured 2026-09-07).
  // RESERVE THE APP OVERLAY'S RIGHT ZONE, SHORT-STATUS SIZED (#usagehead). The
  // freshness status is app chrome floated OVER this frame (pluginCard.ts whenEl:
  // absolute right:2rem [end-8]) next to the refresh button (right:0.5rem
  // [end-2]). A no-JS frame cannot see that overlay's width, so it reserves a
  // FIXED right zone the email (uc-who) ellipsizes into. We size that zone to the
  // COMMON, SHORT status only -- "Nm ago" / "Nh ago", widest "59m ago" ~3.06rem
  // at 12px Inter -- so the fresh state (the normal case) shows nearly the whole
  // email and only ellipsizes a hair. The RARE long status ("59m ago (check
  // throttled)", ~9.1rem) is NOT reserved here; instead pluginCard.ts gives whenEl
  // an OPAQUE plate-coloured chip so the long form cleanly COVERS the email tail
  // (no transparent overprint) rather than the email pre-truncating for a status
  // it rarely shows. Reservation = 3.06rem (widest short status) + 0.5rem (chip
  // px-1 padding) + 2rem (whenEl end-8 offset) - 0.5rem (the card's px-2 right
  // padding, which insets this frame) + ~0.44rem clearance = 5.5rem. Cross-ref:
  // app/src/components/pluginCard.ts (whenEl end-8, chip bg + px-1, max-w-[12rem]).
  // Padding, not height, so the row's vertical alignment (email/age/refresh as
  // one 22px row) is unchanged.
  `.uc-head{display:flex;align-items:center;gap:6px;height:22px;padding-right:5.5rem}` +
  `.uc-who{font-weight:500;color:var(--cyc-text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}` +
  `.uc-who.uc-err{font-weight:500}` +
  // one grid so every bar is the same length (the native rule): name, track, pct, reset
  `.uc-rows{display:grid;grid-template-columns:auto minmax(2.5rem,1fr) auto auto;column-gap:6px;row-gap:2px;align-items:center}` +
  `.uc-row{display:contents}` +
  `.uc-name{color:var(--cyc-muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}` +
  // THE TRACK CLEARS THE PLATE (#582 addendum 2). It was var(--cyc-border)
  // (#dfe1e5 day), which the pre-#570 near-white plate showed distinctly; the
  // #570 plate (16% muted mix) lands within a few RGB points of it and the
  // unused track vanished. Derive the track from the SAME mix family as the
  // plate, 16 points heavier, so the relationship survives any future plate
  // tune and holds in both themes by construction. Native twin: .cyc-usage-track.
  `.uc-track{height:6px;border-radius:3px;background:color-mix(in srgb,var(--cyc-muted) 32%,var(--cyc-surface));overflow:hidden}` +
  `.uc-fill{display:block;height:100%;border-radius:inherit;background:var(--cyc-bar)}` +
  `.uc-fill.uc-warm{background:#e0a03c}` +
  `.uc-fill.uc-hot{background:#cf3c3c}` +
  `.uc-pct{text-align:end;font-variant-numeric:tabular-nums;color:var(--cyc-text)}` +
  `.uc-reset{color:var(--cyc-muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;justify-self:end}` +
  `.uc-err-line{grid-column:1 / -1;color:var(--cyc-muted);font-style:italic}` +
  // phones: cap the reset text so it cannot squeeze the bar to nothing, the same
  // rule the native card carries (.cyc-usage-reset max-width:7rem under 600px).
  // The frame's own width is the card's, so its media query fires with the card's.
  // 7rem, not 6rem: a normal 5-hour reset ("resets in 2h 20m") is ~101px, which
  // the old 6rem (96px) cap clipped to "resets in 2h 2..." on a narrow card -- the
  // cap meant to protect the bar was truncating an ordinary reset (#570). 7rem
  // (112px) clears every "resets in Xh Ym" a 5-hour window produces, and the
  // track keeps well over its 2.5rem minimum at these widths.
  `@media(max-width:600px){.uc-reset{max-width:7rem}}` +
  `</style>`;

/* The face is content-sized, but a no-JS frame cannot tell the app how tall it
 * is, so the render that knows what it drew reports the exact px. Measured
 * against the native card (day, 900px wide): the head is 22px (the account line
 * centred on the refresh button's row), each bar row is a 12px/1.35 line
 * (16.2px) with a 2px row-gap between, and there is no gap between the head and
 * the first row. */
const HEAD_H = 22;
const ROW_H = 16.2;
const ROW_GAP = 2;
function faceHeight(rows: number): number {
  if (rows <= 0) return Math.ceil(HEAD_H + ROW_H); // head + one message/error line
  return Math.ceil(HEAD_H + rows * ROW_H + (rows - 1) * ROW_GAP);
}

/* Render the whole card face from one limits reading. Pure in (report, now),
 * so it is asserted against fixtures with no engine and no clock. Returns the
 * html, the AGE AS A DURATION (never a timestamp: the :5353 rule, so a phone and
 * a laptop do not subtract each other's wall clocks) and the exact face height. */
export function renderUsageCard(report: UsageReport, now: number): { html: string; ageMs: number | null; height: number; stale: boolean; throttled: boolean } {
  /* NULL WHERE THE AGE IS NEGATIVE (ported from the deleted /limits route): a
   * reading stamped in the future -- a clock that stepped back, a laptop
   * waking, an NTP correction -- must not be drawn as brand new. A clamp is a
   * claim; we do not know how old that reading is, and saying nothing is the
   * only honest answer. */
  const rawAge = Number.isFinite(report.fetchedAt) ? now - report.fetchedAt : null;
  const ageMs = rawAge !== null && rawAge >= 0 ? rawAge : null;

  let inner: string;
  let height: number;
  if (report.ok) {
    // the head is the account alone; the age line is app chrome now (#577), so
    // the right of this row is deliberately empty for the app to sit it there
    const who = report.email ? `<span class="uc-who">${esc(report.email)}</span>` : "";
    const windows = report.windows ?? [];
    const bars = windows.map((w) => barHtml(w, now)).join("");
    inner = `<div class="uc"><div class="uc-head">${who}</div>` +
      `<div class="uc-hosts" data-cyc-hosts></div>` +
      `<div class="uc-rows">${bars}</div></div>`;
    height = faceHeight(windows.length);
  } else {
    /* THE HEADLINE KEYS ON THE TYPED REASON (#602), never on the error STRING.
     *
     * renderUsageCard runs ENGINE-side, where limits.ts mints the error
     * sentences ("The operation timed out", "usage http 503", "fetch failed",
     * "not signed in on this machine"). The old code matched app-side strings
     * ("timed out"/"engine unreachable") that never appear here, so EVERY
     * network failure fell through to the "not signed in" headline -- the card
     * telling him he was logged out because a request to Anthropic timed out.
     * The reason is the fact we branch on: only `signed-out` claims the account
     * is logged out; `throttled` is our own 429; everything else (network, or a
     * failure we could not classify) says "can't check right now" and asserts
     * nothing about the account. A legacy reading with no reason but the 429
     * string still reads as throttled, so a mixed-version tailnet stays honest. */
    const reason = report.reason;
    const isThrottled = reason === "throttled" || (reason === undefined && throttled(report));
    const signedOut = reason === "signed-out";
    const whoText = signedOut ? "not signed in" : isThrottled ? "could not check" : "can't check right now";
    const msg = signedOut ? (report.error ?? "no limits available")
      : isThrottled ? "our check for these numbers was throttled"
      : "could not reach the usage service, showing nothing new";
    inner = `<div class="uc"><div class="uc-head"><span class="uc-who uc-err">${esc(whoText)}</span></div>` +
      `<div class="uc-hosts" data-cyc-hosts></div>` +
      `<div class="uc-rows"><span class="uc-err-line">${esc(msg)}</span></div></div>`;
    height = faceHeight(0);
  }
  // WHY the numbers are old, for the app's age line: `stale` is the last-good
  // reading held through a refusal, `throttled` narrows that to a 429 on OUR
  // lookup. The app turns these into "(retrying)" / "(check throttled)".
  return { html: `${STYLE}${inner}`, ageMs, height, stale: report.stale === true, throttled: throttled(report) };
}

/* The dedupe key: one card per account across hosts. A lowercased hash of the
 * account email, so a card signed into the same account on his phone-facing
 * laptop and his desk both fold to one, and the app draws host chips from
 * "which engines sent this key" without ever learning what an account is. Null
 * when the engine has no email to key on (logged out): nothing to fold. */
export function usageDedupe(report: UsageReport | null): string | null {
  const email = report?.email;
  if (!email) return null;
  return createHash("sha256").update(email.toLowerCase()).digest("hex").slice(0, 16);
}

/* SERVING THE CARD IS DECOUPLED FROM RECOMPUTING THE USAGE (#602).
 *
 * The card used to `await limitsNow(force)` INSIDE render(), so an app fetch
 * drove the actual upstream read: a slow or refusing endpoint made the card
 * slow, and a forced refresh blocked on two 10 s requests. Each of 570/577/582/
 * 600 patched a symptom of that one coupling. The fix removes it: render()
 * NEVER touches the upstream. It returns the last COMPUTED report from a cache,
 * instantly, and only SCHEDULES a background recompute -- floored, fire and
 * forget -- that writes the cache on its own cadence. So an app fetch can never
 * be slow, empty or errored because of the endpoint; it always gets the last
 * good render at once, and N fetches never cause N recomputes.
 *
 * `usageSource` is the injection seam for the tests (never the real `claude`
 * usage): the engine leaves it null and render folds over the ACTIVE harnesses'
 * usage through the typed core (below). */
type UsageSource = (force: boolean) => Promise<UsageReport>;
let usageSource: UsageSource | null = null;

/* THE CORE, handed in by the factory below (the composition root
 * builds one instance in prod; tests reset it). Usage is a HARNESS-ACCOUNT FACT
 * now, not a per-agent one: this plugin no longer imports limits.ts and no longer
 * loops agentIds(). It enumerates the ACTIVE harness kinds (core.harnesses()) and
 * asks each ONE ONCE for its usage in its OWN shape (core.usage(kind, force)); a
 * claude harness answers a LimitsReport, others answer nothing, so the fold takes
 * the first LimitsReport (they all describe the one host account). A harness with
 * no live agent is not asked, so the card shows usage exactly when a harness of
 * that kind is in use; with no active harness at all loadUsage throws and the
 * caller keeps the last-good cache. `force` threads through so the refresh button
 * re-reads upstream (core.usage("claude", true) -> limitsNow(true)). */
let usageCore: ((id: string) => PluginCore) | null = null;

/* The refusal a harnessless engine answers. The app knows this exact sentence:
 * it hides the card when the fetch fails with it (a fresh install with no
 * coding harness has no usage to show, and a permanent error card is noise). */
export const NO_ACTIVE_HARNESS = "no active harness on this engine answers plan usage";

async function foldUsageOverHarnesses(core: (id: string) => PluginCore, force: boolean): Promise<UsageReport> {
  const c = core("usage-card");
  for (const h of await c.harnesses()) {
    if (!h.active) continue; // usage is shown only for a harness with a live agent
    const u = await c.usage(h.kind, force);
    if (isUsageReport(u)) return u;
  }
  throw new Error(NO_ACTIVE_HARNESS);
}

async function loadUsage(force: boolean): Promise<UsageReport> {
  if (usageSource) return usageSource(force);
  if (!usageCore) throw new Error("usage core not wired on this engine");
  return foldUsageOverHarnesses(usageCore, force);
}

/* THE DURABLE CACHE: this lives with the engine's other restart-safe state.
 * It contains only a successful report, so a failed check cannot overwrite the
 * last-good card that a new engine must serve before its first refresh lands.
 * Reads are synchronous because render() must return immediately; writes happen
 * in the already-background refresher and use rename so a torn write is ignored. */
/* RESOLVED PER CALL, NOT AT IMPORT. It used to be a `let` initialised at module
 * load, which reads CYC_DATA_DIR the instant anything imports this plugin. ESM
 * imports hoist, so no test could ever point it somewhere else: a test process
 * resolved a path inside his REAL ~/.callyourcode and the override arrived too
 * late to matter. Production is unchanged; the value is the same string, asked
 * for when it is needed. */
let cacheFileOverride: string | null = null;
const cacheFile = (): string =>
  cacheFileOverride ?? join(pluginDataDir("usage-card"), "usage-card.json");

function isUsageReport(value: unknown): value is UsageReport {
  return !!value && typeof value === "object" && typeof (value as UsageReport).ok === "boolean" &&
    typeof (value as UsageReport).fetchedAt === "number";
}

function loadPersistedUsageCache(): UsageReport | null {
  try {
    const report: unknown = JSON.parse(readFileSync(cacheFile(), "utf8"));
    return isUsageReport(report) && report.ok ? report : null;
  } catch {
    return null;
  }
}

function persistUsageCache(report: UsageReport): void {
  if (!report.ok) return;
  try {
    mkdirPrivateSync(dirname(cacheFile()));
    writeAtomicPrivateSync(cacheFile(), JSON.stringify(report));
  } catch {
    /* A read-only or full state directory must not make serving the card fail. */
  }
}

/* THE MEMORY CACHE: the last computed report, and when the last recompute
 * finished. render() reads `cachedReport`; the background refresher writes it.
 * `lastReport` is the same reading, kept for the synchronous dedupe() the route
 * calls right after render. The initial disk load makes a new engine warm at boot. */
let cachedReport: UsageReport | null = loadPersistedUsageCache();
let lastReport: UsageReport | null = cachedReport;
let lastRefreshAt = 0;      // when the last recompute COMPLETED (the floor's anchor)
/* ONE recompute at a time, held as a PROMISE (not a bare boolean) so a caller
 * that arrives mid-flight can AWAIT the running read instead of returning empty
 * handed. A poll burst still shares it (one upstream read), and the refresh
 * button, landing while a recompute runs, waits on THAT read rather than opening
 * a second one. null when nothing is in flight. */
let inflightRefresh: Promise<void> | null = null;
/* Why the last recompute failed (its error message), null after a success.
 * Render reads it to tell "no cache yet" from "no cache and there never will
 * be one": with no cache and the NO_ACTIVE_HARNESS refusal recorded, render
 * refuses too instead of drawing "can't check right now" forever. */
let lastRefreshError: string | null = null;

/* The neutral face shown ONLY before the first recompute has landed (a cold
 * engine, first ever card). It renders as "can't check right now" for the split
 * second until the background refresh -- reading limitsNow(false), which is the
 * persisted last-good from disk -- fills the cache. It never blanks and never
 * claims logged-out. */
const COLD: UsageReport = { ok: false, error: "checking usage", reason: "unknown", fetchedAt: Number.NaN };

/* Recompute the usage and write the cache. Swallows a throwing/rejecting source:
 * a failed recompute keeps the LAST cache rather than replacing it with nothing,
 * which is the whole point (an errored upstream must not empty the card). */
export function refreshUsageCache(force = false): Promise<void> {
  if (inflightRefresh) return inflightRefresh; // share the read already running
  inflightRefresh = (async () => {
    try {
      const report = await loadUsage(force);
      cachedReport = report;
      lastReport = report;
      persistUsageCache(report);
      lastRefreshAt = Date.now();
      lastRefreshError = null;
    } catch (e) {
      /* keep cachedReport as it was: a broken recompute is not a reason to blank */
      lastRefreshError = e instanceof Error ? e.message : String(e);
    } finally {
      inflightRefresh = null;
    }
  })();
  return inflightRefresh;
}

/* Kick a background recompute if one is due: never while another is running, and
 * never inside the floor once a cache exists. This is what keeps N fetches from
 * becoming N recomputes and honors refreshFloorS regardless of how hard the app
 * (or the refresh button) polls. Fire and forget: the caller does not await it. */
function scheduleRefresh(force: boolean, floorMs: number): void {
  if (!cachedReport) {
    cachedReport = loadPersistedUsageCache();
    lastReport = cachedReport;
  }
  if (inflightRefresh) return;
  if (cachedReport && Date.now() - lastRefreshAt < floorMs) return;
  void refreshUsageCache(force);
}

const REFRESH_FLOOR_S = 5;

/* THE FORCE BOUND: the refresh button goes upstream, but a hung endpoint must
 * not hang (or blank) the card. A forced render awaits the recompute for at most
 * this long and then draws whatever the cache holds (the last-good), so the
 * button never empties the face. Kept UNDER the route's refresh budget
 * (CARD_RENDER_TIMEOUT_MS.refresh, 12s) so THIS bound returns the last-good
 * rather than the route's withTimeout rejecting into a 500. Test-overridable so
 * the hung-source case is proven in tens of milliseconds, not eleven seconds. */
const FORCE_TIMEOUT_MS = 11_000;
let forceTimeoutMs = FORCE_TIMEOUT_MS;

/* The plain-poll twin of the force bound, used ONLY when there is no cache at
 * all (a cold engine): render waits this long for the first recompute before
 * falling back to the COLD face. Well under the route's poll budget (8s), and
 * a harnessless fold refuses in milliseconds, so the refusal lands on the
 * FIRST poll and the card never flashes. */
const COLD_WAIT_MS = 3_000;
let coldWaitMs = COLD_WAIT_MS;

/* Await a recompute, never longer than the bound. refreshUsageCache never
 * rejects (it swallows the source), so this only races the clock: on the bound
 * it resolves and the caller renders the last-good cache. Sharing is automatic
 * -- refreshUsageCache returns the in-flight read when one is already running. */
async function refreshBounded(force: boolean, boundMs: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const cap = new Promise<void>((resolve) => { timer = setTimeout(resolve, boundMs); });
  try {
    await Promise.race([refreshUsageCache(force), cap]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/* ===================== THE LIMITS POLL, PLUGIN-OWNED =========================
 *
 * Watch our own plan limits and say something before you hit the wall. The
 * ENGINE polls rather than the page, because the page is often closed and that
 * is exactly when you would want to be told. This loop lived in server.ts; the
 * usage vertical owns it now (blueprint section 3, second extraction). The
 * crossing itself is decided in limits.ts against a persisted last-seen
 * percentage, so nothing here depends on a poll landing on 90 exactly, and a
 * longer gap costs lateness rather than a missed alert.
 *
 * THE PLUGIN OWNS ITS OWN TICKER (like crons owns its clock): the factory below
 * runs this loop through an injected `clock`, and its `dispose` stops it. A limit
 * crossing is not one of the host's three verbs and a pane delivery would not
 * reach a closed page, so it goes out as an ENGINE-LEVEL, session-less sealed
 * push via `core.notifyEngine` -- about the account, not any chat. */
export type UsagePollDeps = {
  /* THE PLUGIN'S OWN CLOCK, defaulting to realClock so the engine behaves exactly
   * as it did; a test hands it a manualClock and the whole grid costs one
   * advance() with no wall sleeps (the crons pattern). */
  clock?: Clock;
  /* WHICH FIFTEEN MINUTES is this engine's own, derived from its NAME (host,
   * user, port) rather than redrawn on every gap: two engines started by one
   * launchd would otherwise ask within a second of each other for ever. */
  phaseKey: string;
  /* The honest fallback account label when the profile call is throttled: the
   * engine host is the only thing this engine can then name. */
  host: string;
  /* THE LIMITS SIDE, injected so this plugin imports NOTHING from limits.ts
   * (usage is an adapter fact). `takeAlerts` drains the threshold crossings the
   * last reading newly crossed; the three scheduling values are the poll grid,
   * this engine's stable phase, and the interval. All from limits.ts, wired by
   * the composition root. */
  takeAlerts: () => UsageAlert[];
  nextPollAt: (now: number, phaseMs: number) => number;
  pollPhaseMs: (engineKey: string) => number;
  pollIntervalMs: number;
};

function limitPhrase(label: string): string {
  if (label === "5 hours") return "5-hour limit";
  if (label.startsWith("week (")) return `weekly ${label.slice(6, -1)} limit`;
  return "weekly limit";
}

/** One poll pass: read the (cached, unforced) usage through the harness fold --
 *  which triggers the same limitsNow(false) fetch behind the claude adapter, so
 *  the crossings are computed -- and push any the reading newly crossed. A limit
 *  crossing is an ENGINE-LEVEL, session-less sealed push (about the account, not
 *  a chat), so it goes out through `core.notifyEngine`. With no active harness
 *  answering usage the fold throws and the pass is a no-op. Takes `core`
 *  explicitly (the factory closes over it) and is exported for the tests. */
export async function pollLimitsOnce(core: (id: string) => PluginCore, deps: UsagePollDeps): Promise<void> {
  let report: UsageReport;
  try {
    report = await loadUsage(false);
  } catch (e) {
    console.warn("[limits] poll failed:", (e as Error)?.message);
    return;
  }
  /* WHO this is about: a plan limit belongs to the account, and the account
   * rides ONLY inside the sealed enc (never a cleartext field). The app server
   * no longer merges same-account crossings (it forwards engine-level pushes
   * as-is), so several machines on one account each buzz once per threshold;
   * the plugin-id tag (+ window subTag) keeps one BANNER per window on a device. */
  const account = report.email ?? deps.host;
  const c = core("usage-card");
  for (const a of deps.takeAlerts()) {
    console.log(`[limits] ${deps.host}: ${a.label} crossed ${a.threshold}% (now ${a.pct}%)`);
    await c.notifyEngine({
      // THIS PLUGIN owns the alert: the plugin id is the notification's
      // identifier (what sessionId is to a session push), and notify.ts builds
      // the device tag from it. The account rides ONLY inside the sealed enc.
      plugin: "usage-card",
      title: `${a.pct}% of the ${limitPhrase(a.label)}`,
      body: a.resetsAt
        ? `${account} · resets ${new Date(a.resetsAt).toLocaleString()}`
        : `${account} · usage is running out`,
      // One banner per WINDOW on a device, so a later threshold replaces the
      // earlier notice rather than stacking three. The label carries no account.
      subTag: a.label,
      // the tap target, sealed inside enc: opens this host's list, card highlighted.
      open: `usage:${deps.host}`,
    });
  }
}

/* NO CARD ON A HARNESSLESS ENGINE. With no report ever computed AND the last
 * recompute refusing because no active harness answers usage, render refuses
 * with the same sentence instead of drawing the COLD face forever; the app
 * hides the card on exactly this refusal. A cache from a past harness keeps
 * rendering as before, and a cold engine whose first recompute has not
 * finished still gets the COLD face (lastRefreshError is null then). */
function refuseWhenNoUsageEver(): void {
  if (!cachedReport && lastRefreshError === NO_ACTIVE_HARNESS) throw new Error(NO_ACTIVE_HARNESS);
}

/* The card surface (render/dedupe) reads the module cache; identical whether or
 * not this engine runs the poll loop, so it is one object both factory paths use. */
const usageCard: PluginSpec["card"] = {
  title: "Plan usage",
  refreshFloorS: REFRESH_FLOOR_S,
  render: async (opts) => {
    if (opts?.force) {
      // THE REFRESH BUTTON: go upstream and let the RESPONSE carry the new
      // numbers. It bypasses the poll floor (the floor throttles poll bursts,
      // not a person's explicit press), shares an in-flight recompute instead of
      // stacking a second read, and is time-bounded so a hung endpoint returns
      // the last-good cache rather than blanking the card.
      await refreshBounded(true, forceTimeoutMs);
      refuseWhenNoUsageEver();
      return renderUsageCard(cachedReport ?? COLD, Date.now());
    }
    // a plain poll: return the cached render at once and schedule a floored,
    // fire-and-forget background recompute. The RESPONSE is always the current
    // cache, so N polls never become N (or N slow) recomputes. The ONE cold
    // exception: with no cache at all, briefly await that first recompute, so
    // a harnessless engine refuses on the first poll instead of drawing
    // "can't check right now" until the app's next cycle.
    scheduleRefresh(false, REFRESH_FLOOR_S * 1000);
    if (!cachedReport) {
      await refreshBounded(false, coldWaitMs);
      refuseWhenNoUsageEver();
    }
    return renderUsageCard(cachedReport ?? COLD, Date.now());
  },
  dedupe: () => usageDedupe(lastReport),
};

/* THE PLUGIN, AS A FACTORY (crons-shaped). `core` is the typed PluginCore the
 * render's harness fold and the poll's notifyEngine both program against; `poll`
 * is the poll seam. When both are present the plugin OWNS ITS TICKER: it runs the
 * grid loop through the injected clock and returns a spec whose `dispose` stops
 * it (no schedule injected from the root). A bare usageCardPlugin() (tests, or an
 * engine with the loop off) gets the card renderer with no loop.
 *
 * ON A GRID, not setInterval from boot: an interval measured from startup
 * restarts with the process, so a KeepAlive plist and an engine that crashes on
 * boot is a request every few seconds. On a grid a restart lands back inside the
 * cycle it was already in (nextPollAt; limits.ts's persisted last reading makes
 * the first poll after a restart free). The first poll is immediate, and being
 * unforced it usually costs nothing at all. */
export function usageCardPlugin(core?: (id: string) => PluginCore, poll?: UsagePollDeps): PluginSpec {
  if (core) usageCore = core;
  const spec: PluginSpec = { id: "usage-card", name: "Plan usage", version: 1, card: usageCard };
  if (!poll || !core) return spec;

  const clock = poll.clock ?? realClock;
  let timer: unknown = null;
  let stopped = false;
  const phase = poll.pollPhaseMs(poll.phaseKey);
  console.log(`[limits] asking every ${poll.pollIntervalMs / 60_000}m at +` +
    `${Math.round(phase / 1000)}s of the cycle`);
  const schedule = () => {
    if (stopped) return;
    const at = poll.nextPollAt(clock.now(), phase);
    timer = clock.setTimeout(
      () => void pollLimitsOnce(core, poll).finally(schedule),
      Math.max(0, at - clock.now()));
  };
  void pollLimitsOnce(core, poll);
  schedule();
  return {
    ...spec,
    dispose: () => {
      stopped = true;
      if (timer) clock.clearTimeout(timer);
      timer = null;
    },
  };
}

/* TEST SEAM (#602). The gate injects a slow/failing/counting usage source and
 * drives the cache directly, so it proves the decouple without ever reaching
 * the real `claude` usage. Not used by the engine. */
export const __usageCardTest = {
  setSource(fn: UsageSource | null): void { usageSource = fn; },
  reset(): void { usageSource = null; usageCore = null; cachedReport = null; lastReport = null; lastRefreshAt = 0; inflightRefresh = null; lastRefreshError = null; forceTimeoutMs = FORCE_TIMEOUT_MS; coldWaitMs = COLD_WAIT_MS; },
  setCacheFile(path: string): void { cacheFileOverride = path; },
  setForceTimeout(ms: number): void { forceTimeoutMs = ms; },
  setColdWait(ms: number): void { coldWaitMs = ms; },
  seed(report: UsageReport): void { cachedReport = report; lastReport = report; lastRefreshAt = Date.now(); },
  /* pretend the floor has elapsed, so the next render's recompute is due */
  expireFloor(): void { lastRefreshAt = 0; },
  cache(): UsageReport | null { return cachedReport; },
  refresh: refreshUsageCache,
};
