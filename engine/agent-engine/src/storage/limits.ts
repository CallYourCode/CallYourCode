/* The plan limits for the account signed in on THIS machine.
 *
 * Which account is logged in here, how much of the five-hour window is gone,
 * how much of the week, and when they reset. That is what you actually want to
 * know before starting something big, and it is per host: each machine has its
 * own login.
 *
 * Source (documented in the user's own notes,
 * claude-usage-api-notes.md):
 *   GET https://api.anthropic.com/api/oauth/usage    windows + utilisation
 *   GET https://api.anthropic.com/api/oauth/profile  which account this is
 * with the OAuth access token Claude Code already holds: the macOS keychain
 * item "Claude Code-credentials", or ~/.claude/.credentials.json on Linux.
 *
 * THIS CODE NEVER REFRESHES THE TOKEN. Refreshing rotates the refresh token,
 * and two holders of one grant cannot both refresh: the loser is logged out.
 * An expired token is reported as expired, and re-login stays a human action.
 *
 * HOW OFTEN IT IS ASKED, and by whom, is the other half of this file and is
 * shared with limits-share.ts: the answer is a fact about the ACCOUNT, so every
 * engine on one machine takes it from whichever of them asked most recently.
 */

import { createHash } from "node:crypto";
import { awaitShared, readShared, releaseLease, takeLease, writeShared } from "./limits-share.ts";
import { writePrivate } from "../../../shared/runfiles.ts";
import { stateFile } from "./datadir.ts";

/* WHERE THIS ENGINE'S SETTINGS COME FROM, AND WHY THEY ARE READ AT CALL TIME.
 *
 * Every one of these used to be a module-level `const` reading process.env
 * during import. Production behaviour is identical either way -- the same env
 * var, the same default -- but the moment of the read decides what can be
 * tested. A value fixed at import is fixed before the first test runs, so the
 * only way left to point this file at a fake upstream, a fake credentials file
 * and a scratch seen file was to spawn a whole process per reading. Two
 * "engines" sharing one machine then meant two `bun` processes and thirty
 * seconds of timeout budget for what is a hundred lines of arithmetic and one
 * shared file.
 *
 * Read at CALL time instead, and the same suite runs in-process: `resetForTest`
 * gives the module a fresh set of overrides plus an empty cache, which is
 * exactly what a restart is. The overrides win over the env so nothing has to
 * mutate process.env mid-file, and with none set every function here answers
 * precisely what it answered before.
 */
type LimitsOverrides = {
  /** the upstream, ONLY ever a fake one a test counts the requests on */
  apiBase?: string;
  /** the token file. See credentialsFile() below: this must never be his. */
  credentialsFile?: string;
  /** this engine's last-reading file */
  seenFile?: string;
  /** how long the loser of a lease race waits */
  leaseWaitMs?: number;
  /** the clock, so a fifteen minute interval costs a test no seconds at all */
  now?: () => number;
};
let over: LimitsOverrides = {};

/* The host is overridable ONLY so a test can point these at a fake upstream it
 * counts the requests on. Nothing in the engine sets it, and testing against
 * the real endpoint would be committing the very defect this file exists to
 * have fixed. */
const apiBase = () => over.apiBase ?? process.env.CYC_LIMITS_API ?? "https://api.anthropic.com";
const usageUrl = () => `${apiBase()}/api/oauth/usage`;
const profileUrl = () => `${apiBase()}/api/oauth/profile`;
// default clients get bot-blocked; Claude Code identifies itself like this
const HEADERS_UA = "claude-cli/2.0.0 (external, cli)";

/* THE CLOCK. Date.now() unless a test injected one, which is the whole of the
 * difference: the grid, the TTL, the ask stamps and the shared entries' `at`
 * all read this one function, so a test can move an hour without waiting one
 * and every timestamp this module writes stays on the same timeline. */
const now = (): number => (over.now ?? Date.now)();

/** Forget everything this module has learned and (optionally) point it
 *  somewhere else. A no-op for production: nothing in the engine calls it. */
export function resetForTest(o: LimitsOverrides = {}): void {
  over = o;
  cached = null;
  seen = null;
  askedAt = 0;
  lastAlerts = [];
}

export type LimitWindow = {
  label: string;                  // "5 hours", "week", "week (Fable)"
  pct: number;
  resetsAt: string | null;
  severity?: "normal" | "warning" | "critical";
};

/* WHY A READING IS NOT OK, as a TYPED KIND rather than a string the card
 * matches on (#602). `error` is a human sentence that varies by origin ("The
 * operation timed out", "usage http 503", "fetch failed", "not signed in on
 * this machine"); the card cannot honestly branch on those, and used to fall
 * through every network failure to a "not signed in" headline -- asserting a
 * logged-out account from a transient timeout. The reason is the fact the card
 * keys on:
 *   signed-out  the account IS logged out here (no token, or a 401). Say so.
 *   throttled   OUR usage lookup got a 429. Not the account: "could not check".
 *   network     a timeout, a dropped connection, or a 5xx from the endpoint.
 *               We do not know anything about the account: "can't check now".
 *   unknown     a failure we cannot classify (a restored older reading, another
 *               engine's un-typed failure). Treated as network: never "signed
 *               out", because claiming logged-out is the one lie that hurts. */
export type LimitReason = "signed-out" | "throttled" | "network" | "unknown";

export type LimitsReport = {
  ok: boolean;
  email?: string;
  plan?: string;
  windows?: LimitWindow[];
  fetchedAt: number;
  error?: string;
  /* the typed WHY, present on every !ok reading and on a stale one. Absent on a
   * fresh ok reading. The card renders the headline from THIS, not from `error`. */
  reason?: LimitReason;
  /* these numbers are older than this call: the API refused (it rate-limits
   * readily) and we are showing the last good answer rather than a blank card.
   * fetchedAt is when they were TRUE, not when we asked. */
  stale?: boolean;
};

/* A crossing worth telling you about. */
export type LimitAlert = {
  label: string;      // "5 hours", "week", "week (Fable)"
  pct: number;
  threshold: number;
  resetsAt: string | null;
};

/* WHERE HIS OAUTH TOKEN IS, and the override is not a convenience.
 *
 * A test engine has no business holding his credentials. Every harness engine
 * is a real one, so every spec in this repo was pulling the real token out of
 * the login keychain and putting it in an Authorization header -- and while
 * nothing reached the wire once the upstream was a dead port, "no test engine
 * asks Anthropic anything" and "no test engine holds his token" are two
 * different sentences and only the first was true.
 *
 * MOVING `HOME` WOULD HAVE DONE IT AND IS NOT SAFE HERE: homedir() feeds
 * session-events.ts's projects directory and server.ts's ENGINE_HOME, which
 * decides which working directories /new-session will accept. This names the
 * one file it is about. When it is set the keychain is NEVER consulted, which
 * is the property the harness needs: an override that could still fall through
 * would leave the token one failed read away. */
const credentialsFile = () => over.credentialsFile ?? process.env.CYC_LIMITS_CREDENTIALS;

async function readToken(): Promise<string | null> {
  const file = credentialsFile();
  if (file) {
    try {
      const j = (await Bun.file(file).json()) as any;
      const tok = j?.claudeAiOauth?.accessToken;
      return typeof tok === "string" && tok ? tok : null;
    } catch {
      return null; // and NOT the keychain: see above
    }
  }
  // Linux keeps it in a file
  try {
    const f = Bun.file(`${process.env.HOME}/.claude/.credentials.json`);
    if (await f.exists()) {
      const j = (await f.json()) as any;
      const tok = j?.claudeAiOauth?.accessToken;
      if (typeof tok === "string" && tok) return tok;
    }
  } catch {
    /* fall through to the keychain */
  }
  // macOS keeps it in the keychain
  if (process.platform === "darwin") {
    try {
      const out = await Bun.$`security find-generic-password -s ${"Claude Code-credentials"} -w`
        .quiet()
        .text();
      const j = JSON.parse(out.trim());
      const tok = j?.claudeAiOauth?.accessToken;
      if (typeof tok === "string" && tok) return tok;
    } catch {
      /* not logged in on this machine */
    }
  }
  return null;
}

/* The response carries a `limits` array that already names every window the
 * account has, including per-model ones (that is where the Fable cap shows
 * up, as a weekly_scoped entry). Reading the array rather than the handful of
 * top-level keys means a window Anthropic adds tomorrow appears by itself. */
function windowsFrom(u: any): LimitWindow[] {
  const rows: LimitWindow[] = [];
  for (const l of Array.isArray(u?.limits) ? u.limits : []) {
    const pct = Number(l?.percent);
    if (!Number.isFinite(pct)) continue;
    const model = l?.scope?.model?.display_name;
    const label =
      l.kind === "session" ? "5 hours" :
      l.kind === "weekly_all" ? "week" :
      model ? `week (${model})` :
      String(l.kind ?? "limit").replace(/_/g, " ");
    rows.push({
      label,
      pct: Math.round(pct),
      resetsAt: l?.resets_at ?? null,
      severity: l?.severity === "critical" || l?.severity === "warning" ? l.severity : "normal",
    });
  }
  if (rows.length) return rows;
  // older shape, before `limits` existed
  const legacy: [string, any][] = [["5 hours", u?.five_hour], ["week", u?.seven_day]];
  for (const [label, raw] of legacy) {
    if (raw && typeof raw.utilization === "number") {
      rows.push({ label, pct: Math.round(raw.utilization), resetsAt: raw.resets_at ?? null });
    }
  }
  return rows;
}

let cached: LimitsReport | null = null;

/* HOW OFTEN THIS ACCOUNT IS ASKED. One number, exported, because the poll's
 * interval and this file's TTL have to agree or neither of them describes the
 * real rate.
 *
 * WHAT IT WAS, measured 2026-08-01. The poll ran every two minutes and passed
 * force, and force skipped the cache check on the way past, so the automatic
 * poll never consulted this cache at all and the four-minute TTL -- cut to fit
 * inside a five-minute poll that had been deleted -- was longer than the gap it
 * was sitting in. Each poll is two upstream requests, usage and profile, so one
 * engine asked 60 times an hour whether or not anybody was looking at the card,
 * and two engines signed into one account asked 120 for a number that is a fact
 * about the ACCOUNT and identical whoever asks. The endpoint answered 429, the
 * branch below called that routine, and the card told him his account was
 * having trouble. It was our own polling coming back at us.
 *
 * FIFTEEN MINUTES WITH JITTER, which is his call: "just reduce the frequency
 * here to once per 15mins with some jitter". It costs lateness and nothing
 * else: a threshold is a CROSSING against a persisted last-seen percentage
 * (crossings() below), not a level a poll has to land on, so a longer gap can
 * be late with an alert but cannot miss one.
 *
 * The jitter is a PHASE, per engine and stable (pollPhaseMs), not a fresh
 * number on every gap. Both spread two engines that start together, and only
 * one of them survives a restart -- see the note on pollPhaseMs. */
export const LIMITS_POLL_MS = 15 * 60_000;

/* HOW FAR APART two engines' phases may be drawn. Wide enough that a request
 * from one is comfortably finished before the other's turn, narrow enough that
 * "every fifteen minutes" is still a fair description of what the card gets. */
export const LIMITS_POLL_SPREAD_MS = 5 * 60_000;

/* THE TTL IS THE INTERVAL MINUS A MINUTE, and the minute is what makes the
 * poll's own schedule work.
 *
 * A TTL exactly equal to the interval reads well and is wrong. A poll arriving
 * fifteen minutes after its own last reading finds that reading, by a fraction
 * of a second, still fresh: the fetch that produced it took time, and a timer
 * never fires early. It then skips its turn, the next one is thirty minutes
 * later, and the real interval has silently doubled with nothing in the logs to
 * say so. Anything longer than one fetch plus timer drift closes that; a minute
 * is comfortably that, and the card is still served from cache for fourteen of
 * every fifteen minutes.
 *
 * `/limits?refresh=1` ignores this entirely, because a person tapping the arrow
 * is asking for exactly that. See limitsNow's `force`. */
const CACHE_MS = LIMITS_POLL_MS - 60_000;

/* WHERE IN THE QUARTER HOUR THIS ENGINE ASKS, decided by WHICH ENGINE IT IS
 * rather than by a coin.
 *
 * A HASH OF THE ENGINE'S NAME, not Math.random(), for two reasons that a coin
 * cannot give. It is the SAME AFTER A RESTART, so an engine that comes back
 * twenty times an hour still asks four times an hour rather than once per boot
 * -- and a crash loop was the one way left to reproduce the old rate. And it is
 * reproducible, so a test can state this engine's phase and show that two named
 * engines provably differ, instead of asserting that two random numbers usually
 * do. */
export function pollPhaseMs(engineKey: string, spreadMs = LIMITS_POLL_SPREAD_MS): number {
  return createHash("sha256").update(engineKey).digest().readUInt32BE(0) % spreadMs;
}

/* The next instant on THIS engine's grid: k * interval + phase.
 *
 * A GRID, not "interval from now", for the same reason the phase is a hash.
 * "From now" restarts with the process, so an engine that boots, asks, and is
 * restarted three minutes later asks again, and a restart loop is a request
 * every few seconds. On a grid a restart lands back inside the cycle it was
 * already in, and the machine's rate is the same whether the engine has been up
 * for a week or has come back four times this hour. */
export function nextPollAt(now: number, phaseMs: number, intervalMs = LIMITS_POLL_MS): number {
  return (Math.floor((now - phaseMs) / intervalMs) + 1) * intervalMs + phaseMs;
}

/* The last answer the API actually gave us, kept across restarts.
 *
 * Two jobs. It is what the card shows when a request fails, with the age it
 * really has, instead of an error where the numbers were. And it is what a new
 * reading is compared against, which is the only way to notice a threshold
 * crossing: polling every couple of minutes will never land on 90% exactly, so
 * "was below, is now above" is the question, not "is it 90".
 *
 * One file, overwritten. Not a log: nothing here is worth keeping twice.
 *
 * PER ENGINE, and it stays per engine even though the numbers in it are now
 * shared. The marks are this engine's opinion about what it has already told
 * him, and two engines that shared them would have one of them silently stop
 * announcing crossings. Overridable only so a test does not write into a real
 * data dir. */
const seenFile = () => over.seenFile ?? process.env.CYC_LIMITS_SEEN ?? stateFile("limits-seen.json");

type SeenState = {
  report: LimitsReport;
  marks: Record<string, number>;
  /* WHICH ACCOUNT THIS ENGINE IS SIGNED INTO, remembered separately from the
   * report and never cleared once known.
   *
   * It is the key to the machine's shared cache, so getting it wrong means
   * reading another account's numbers, and `report.email` cannot be trusted to
   * hold it: the profile call is throttled out of the same bucket as the usage
   * call and fails on its own, and a reading with no email would then erase the
   * key. An engine that has never once learned its account simply does not
   * share -- see limitsNow. */
  account?: string;
  /* A FINGERPRINT OF THE OAUTH TOKEN THIS READING WAS TAKEN WITH, so a re-login
   * on this machine is noticed the moment we next ask.
   *
   * `state.account` is never cleared (see above), which is right for a throttle
   * that leaves the same person signed in but wrong across a re-login: after a
   * new sign-in the first ask that fails would serve the OLD account's numbers
   * and email out of `staleFrom`, and `readShared(oldAccount)` would re-adopt
   * the old entry. The token is the identity signal that arrives BEFORE the
   * answer: a different access token is a different sign-in, so we discard the
   * previous reading and ask fresh rather than assert an account we no longer
   * hold. A routine OAuth refresh (new token, same account) also trips this and
   * costs one discarded-but-still-valid reading; that is the honest price of not
   * trusting an identity we cannot yet confirm. First 16 hex of sha256(token). */
  tokenHash?: string;
  /* WHEN THIS ENGINE LAST COMPLETED AN UPSTREAM ATTEMPT, and what it got if the
   * attempt did not work.
   *
   * THIS IS THE RATE LIMITER, and it is written down rather than derived
   * because the thing being limited is HOW OFTEN WE ASK, which is not the same
   * question as how old the numbers are. Keying the interval off
   * `report.fetchedAt` looked like the same question and is not: an attempt
   * that comes back 429 leaves the last good reading's timestamp exactly where
   * it was, so the check never bit again and every later read went upstream.
   *
   * Measured on the branch that introduced it: five card reads with the account
   * not yet known, five asks, ten requests -- into an endpoint that had just
   * refused one. Being rate limited made the engine ask HARDER, which is the
   * loop this whole file exists to remove, reached by a road nobody had walked.
   *
   * Persisted so a restart does not reset it. */
  askedAt?: number;
  askError?: string;
  /* the TYPED reason the last attempt failed (#602), persisted beside askError
   * so a restart rebuilds the card's headline with the same fact, not a string
   * the card re-guesses. Absent means "unknown" -> the card says "can't check",
   * never "signed out". */
  askReason?: LimitReason;
};
let seen: SeenState | null = null;

async function loadSeen(): Promise<SeenState> {
  if (seen) return seen;
  try {
    const f = Bun.file(seenFile());
    if (await f.exists()) {
      const j = (await f.json()) as SeenState;
      if (j?.report) {
        seen = { report: j.report, marks: j.marks ?? {}, account: j.account ?? j.report.email,
          tokenHash: j.tokenHash, askedAt: j.askedAt, askError: j.askError, askReason: j.askReason };
      }
    }
  } catch { /* unreadable is the same as absent */ }
  return (seen ??= { report: { ok: false, fetchedAt: 0 }, marks: {} });
}

function saveSeen() {
  if (!seen) return;
  writePrivate(seenFile(), JSON.stringify(seen)).catch((e: unknown) =>
    console.error("[limits] could not persist the last reading:", e));
}

/* Where we speak up. The five-hour window moves fast and you can only react
 * to it late, so it stays quiet until 90; the weekly ones are worth knowing
 * about earlier, when there is still a week to spend differently. */
const THRESHOLDS: Record<string, number[]> = {
  session: [90, 95],
  weekly: [80, 90, 95],
};

function thresholdsFor(label: string): number[] {
  return label === "5 hours" ? THRESHOLDS.session : THRESHOLDS.weekly;
}

/* Which thresholds this reading has newly crossed. A window that resets (its
 * percentage drops) clears its marks, so the next climb reports again. */
function crossings(windows: LimitWindow[], marks: Record<string, number>): LimitAlert[] {
  const out: LimitAlert[] = [];
  for (const w of windows) {
    const prev = marks[w.label];
    marks[w.label] = w.pct;
    if (prev === undefined || w.pct < prev) continue; // first sight, or a reset
    for (const t of thresholdsFor(w.label)) {
      if (prev < t && w.pct >= t) {
        out.push({ label: w.label, pct: w.pct, threshold: t, resetsAt: w.resetsAt });
      }
    }
  }
  return out;
}

/* The last good numbers, aged honestly, with the reason they are old. `reason`
 * is the TYPED why (#602) the card branches on; `error` stays the human
 * sentence shown underneath. */
function staleFrom(state: SeenState, error: string, reason: LimitReason): LimitsReport {
  const r = state.report;
  if (!r.ok || !r.windows) return { ok: false, error, reason, fetchedAt: now() };
  return { ...r, stale: true, error, reason };
}

/* How long the loser of a lease race waits for the winner's answer before
 * giving up and showing its own last-seen numbers. One fetch is two requests
 * with a ten second timeout each, run together, so eleven seconds covers a
 * winner that is merely slow and stops short of the twelve the card allows. */
const leaseWaitMs = () =>
  over.leaseWaitMs ?? (Number(process.env.CYC_LIMITS_LEASE_WAIT_MS) || 11_000);

/* Take a reading -- ours or another engine's -- as this engine's current
 * answer. Everything a fresh fetch does except the fetch: the crossings are
 * computed against THIS engine's marks, so an engine serving somebody else's
 * numbers still announces a threshold it has not announced yet. */
function adopt(report: LimitsReport, state: SeenState, at: number): LimitsReport {
  cached = report;
  /* WHEN THE MACHINE ASKED, taken on as our own, and that is not bookkeeping.
   *
   * Without it the engine that did not ask has an ask time from an interval
   * ago, so its gate never closes: every card read walks past it, takes the
   * lease, reads the file and adopts the same numbers again. No request leaves
   * the machine, so nothing measures it -- it is a link, an unlink and a read
   * per card read, for an answer already in memory. Holding somebody else's
   * reading is knowing when it was taken. */
  askedAt = at;
  state.askedAt = at;
  if (report.ok && report.windows) {
    lastAlerts = crossings(report.windows, state.marks);
    if (report.email) state.account = report.email;
    state.report = report;
  }
  saveSeen();
  return report;
}

/* Is a timestamp recent enough to reuse -- AND IS IT EVEN IN THE PAST?
 *
 * The lower bound is not pedantry, it is the difference between a TTL and a
 * latch. `now - at < ttl` is satisfied for ever by anything stamped in the
 * future, so one timestamp ahead of this machine's clock stops the poll
 * permanently: measured with a seen file six hours ahead, zero requests, the
 * card serving 99% out of that file with nothing to say it was old. A clock
 * that steps backwards puts every timestamp this engine wrote into the future
 * at once, which a laptop waking up or an NTP correction can do -- and the
 * FORCED poll used to paper over it, so this became reachable on the same
 * branch that unforced it.
 *
 * Out of bounds means "not usable", never "fresh": ask again, and let the
 * answer restamp it. */
function usable(at: number | undefined, ttlMs = CACHE_MS): boolean {
  if (!at) return false;
  const age = now() - at;
  return age >= 0 && age < ttlMs;
}

/* The answer this engine's last completed attempt produced, rebuilt after a
 * restart. A failed attempt is an answer too -- the last good numbers, flagged
 * and with the reason -- and rebuilding it is what lets `askedAt` gate the next
 * one without the engine forgetting that the last one did not work. */
function answerAfterLastAsk(state: SeenState): LimitsReport | null {
  if (state.askError) return staleFrom(state, state.askError, state.askReason ?? "unknown");
  return state.report.ok ? state.report : null;
}

/** When this engine last completed an upstream attempt. See SeenState.askedAt. */
let askedAt = 0;

export async function limitsNow(force = false): Promise<LimitsReport> {
  const state = await loadSeen();
  /* THE LAST ATTEMPT SURVIVES A RESTART, both what it got and when it happened.
   * Without this a restarting engine has an empty cache, so it asks upstream on
   * the way up, and a KeepAlive plist plus a crash loop is a request every few
   * seconds -- the old rate, reached by a different road. */
  if (!askedAt) askedAt = state.askedAt ?? 0;
  cached ??= answerAfterLastAsk(state);
  /* ONE GATE, AND IT IS ON WHEN WE ASKED. Not on how old the numbers are: an
   * attempt that failed leaves the numbers as old as they were, so gating on
   * them meant a rate-limited engine asked on every single card read. */
  if (!force && cached && usable(askedAt)) return cached;

  /* SOMEBODY ELSE ON THIS MACHINE MAY ALREADY HAVE ASKED, and everything below
   * needs to know WHICH ACCOUNT to ask that about.
   *
   * Only an engine that has learned its own account can join in. The shared
   * entry is keyed by account, and an engine that has never had a successful
   * profile call cannot tell whether an entry it finds is even about the same
   * plan. It asks for itself, learns, and joins from then on -- one request per
   * engine, once, ever.
   *
   * ONE ENGINE PER MACHINE MAY ASK AT A TIME, and the shared file is read UNDER
   * THE LEASE rather than before it. Reading first and then taking the lease is
   * one line shorter and leaves a hole: another engine finishing between the
   * read and the claim publishes an answer we have already decided to
   * duplicate. Patching that needs a second read whose branch nothing can reach
   * on purpose. Taking the lease first has no hole to patch -- while we hold it
   * nobody else can publish -- and it costs one link and one unlink on a read
   * the in-process cache missed.
   *
   * `unavailable` is no shared directory at all (see limits-share.ts), and then
   * this is an engine on its own, exactly as it was before that file existed. */
  const account = state.account;
  let lease: import("./limits-share.ts").Lease | null = null;
  if (account) {
    const res = await takeLease(account);
    if (res.kind === "busy") {
      /* NOBODY WAITS FOR A LEASE WITH A PERSON IN FRONT OF THE SCREEN.
       *
       * The loser of a race normally waits for the winner's answer rather than
       * asking as well: it gets the same numbers, from the same request, about
       * a second later, and that is a good trade for a background poll.
       *
       * It is a bad trade for the arrow on the card. A lease left behind by a
       * process that died mid-fetch is held until it goes stale, and a refresh
       * landing in that window used to sit for the whole eleven seconds and
       * then paint OLD NUMBERS saying "another engine on this machine is
       * fetching" -- an eleven second spinner against the card's twelve second
       * allowance, on the exact button he complained about. A forced read
       * therefore does not wait and does not take the lease: it asks. One extra
       * request when a human presses a button, at most, and only when another
       * engine is asking at that instant. */
      if (!force) {
        const s = await awaitShared(account, res.since, leaseWaitMs());
        if (s) return fromShared(s, state);
        /* The winner died holding it, or is slower than the card can wait. Say
         * what we have rather than send a second request into whatever is going
         * wrong upstream. */
        return (cached = staleFrom(state, "another engine on this machine is fetching", "network"));
      }
    }
    if (res.kind === "taken") lease = res.lease;
  }
  try {
    /* WHAT THE MACHINE ALREADY HAS. Nobody can be writing this while we hold
     * the lease, so a fresh entry here is the whole answer and no request goes
     * out. `force` skips it, because a person tapping the arrow on the card is
     * asking for a number taken now, and the other engine's from fourteen
     * minutes ago is not that. */
    if (!force && lease) {
      const s = await readShared(account!);
      if (s && usable(s.at)) return fromShared(s, state);
    }
    return await fetchLimits(state, account, now());
  } finally {
    if (lease) await releaseLease(lease);
  }
}

/* What another engine on this machine got, turned into this engine's answer.
 *
 * A FAILED ATTEMPT IS STILL AN ANSWER. Every completed attempt is published,
 * including a 429, and that is deliberate: an unpublished failure is one the
 * next engine repeats a second later, which is two requests into an endpoint
 * that has just refused one. What we cannot do is show ITS stale numbers as
 * ours -- its last-good reading is from its own history -- so a failed entry
 * becomes this engine's own last-good numbers with the reason the machine's
 * attempt failed.
 *
 * AND WHEN THE ENTRY DOES NOT SAY WHY, WE DO NOT INVENT A REASON. This used to
 * fall back to "rate limited", which is a specific and checkable claim about
 * the endpoint, so an entry written by a future build, or half-understood, made
 * the card tell him he was being throttled when nothing had said so. The card
 * keys on that string. What we actually know is that the machine's last attempt
 * did not work, and that is what it says. */
function fromShared(entry: { at: number; report: LimitsReport }, state: SeenState): LimitsReport {
  const { at, report } = entry;
  if (report.ok && !report.stale) return adopt(report, state, at);
  /* A FAILED ATTEMPT IS ALSO AN ANSWER TO HOLD, and it is recorded with the
   * instant the machine made it, so this engine does not go and repeat a
   * failure somebody else has just had. */
  askedAt = at;
  state.askedAt = at;
  state.askError = report.error ?? "the last attempt on this machine failed";
  /* Carry the entry's TYPED reason if it has one; an entry written by an older
   * engine (no reason) is "unknown", which the card renders as "can't check" --
   * never as "signed out", because we cannot claim that about the account from
   * a failure we did not classify. */
  state.askReason = report.reason ?? "unknown";
  saveSeen();
  return (cached = staleFrom(state, state.askError, state.askReason));
}

async function fetchLimits(
  state: SeenState, account: string | undefined, asked: number,
): Promise<LimitsReport> {
  const token = await readToken();
  if (!token) {
    /* NOT RECORDED AS AN ATTEMPT, because nothing was attempted: no request
     * went anywhere and there is no rate here to limit. */
    return (cached = { ok: false, error: "not signed in on this machine", reason: "signed-out", fetchedAt: now() });
  }

  /* A DIFFERENT TOKEN IS A DIFFERENT SIGN-IN. `state.account` is never cleared,
   * so without this a re-login on this machine keeps serving the previous
   * account's numbers and email whenever the first ask after the login fails
   * (429, timeout). The token arrives before the answer does, so compare it now
   * and, when it has changed, throw away everything this engine thinks it knows
   * about the old account before asking. `account` is nulled locally too, so a
   * failed ask does not writeShared under the old account's key and
   * readShared/awaitShared (below, keyed on state.account) never re-adopt it. */
  const hash = createHash("sha256").update(token).digest("hex").slice(0, 16);
  if (state.tokenHash && state.tokenHash !== hash) {
    state.report = { ok: false, fetchedAt: 0 };
    state.account = undefined;
    state.marks = {};
    state.askError = undefined;
    state.askReason = undefined;
    cached = null;
    account = undefined;
  }
  state.tokenHash = hash;

  /* THE ONE WAY OUT OF THIS FUNCTION, and it does two things that must happen
   * together for every completed attempt.
   *
   * It records THAT WE ASKED, which is what the interval is measured against
   * (SeenState.askedAt). Every path through here has sent a request, so every
   * path through here restarts the clock -- including the ones that failed,
   * which is the whole point: an engine that is being refused must not ask more
   * often than one that is being answered.
   *
   * And it tells the rest of the machine what came back. WHICH ANSWERS ARE
   * SHARED IS ABOUT WHO THEY ARE TRUE FOR. A 429 and a timeout are facts about
   * the account and about this machine's network, so the other engine repeating
   * them would be two requests into something that has just refused one. An
   * expired TOKEN is not: each unix user has its own login, and one of them
   * being signed out says nothing about the other. */
  const settle = async (report: LimitsReport, share: boolean) => {
    askedAt = asked;
    state.askedAt = asked;
    state.askError = report.ok && !report.stale ? undefined : report.error ?? "the attempt failed";
    state.askReason = report.ok && !report.stale ? undefined : report.reason ?? "unknown";
    saveSeen();
    if (share) {
      const who = report.email ?? account;
      if (who) await writeShared(who, report, asked);
    }
    return (cached = report);
  };

  const headers = {
    authorization: `Bearer ${token}`,
    "anthropic-beta": "oauth-2025-04-20",
    "user-agent": HEADERS_UA,
  };

  try {
    const [usageRes, profileRes] = await Promise.all([
      fetch(usageUrl(), { headers, signal: AbortSignal.timeout(10_000) }),
      fetch(profileUrl(), { headers, signal: AbortSignal.timeout(10_000) }),
    ]);
    if (usageRes.status === 401) {
      // deliberately NOT refreshed: see the note at the top. Recorded as an
      // attempt though -- a request went out and came back -- so a signed-out
      // engine asks four times an hour rather than once per card read.
      return settle({ ok: false, error: "token expired, sign in again on this machine",
        reason: "signed-out", fetchedAt: now() }, false);
    }
    /* 429 IS OUR OWN LOOKUP BEING THROTTLED, not the account running out.
     *
     * This branch used to say the response was "routine on this endpoint",
     * which read as a property of the API and was a property of our polling: at
     * two minutes forced, one account was taking 120 requests an hour and the
     * endpoint said no. At fifteen minutes with the machine sharing one answer
     * it is 8 an hour per host, and a 429 here means something else again --
     * worth looking at rather than shrugging past.
     *
     * The STRING stays as it is. It is what the card keys on, it is true about
     * the request, and every engine on the tailnet would have to be redeployed
     * before a new one meant anything. Which of the two facts the WORDS on
     * screen name is the card's job.
     *
     * A blank card is still worse than an old one, so the last real numbers
     * stay up with the age they really have (server.ts sends that age). */
    if (usageRes.status === 429) return settle(staleFrom(state, "rate limited", "throttled"), true);
    if (!usageRes.ok) throw new Error(`usage http ${usageRes.status}`);
    const u = (await usageRes.json()) as any;
    const p = profileRes.ok ? ((await profileRes.json()) as any) : null;

    const report: LimitsReport = {
      ok: true,
      email: p?.account?.email ?? undefined,
      plan: p?.account?.has_claude_max ? "Max" : p?.account?.has_claude_pro ? "Pro" : undefined,
      windows: windowsFrom(u),
      fetchedAt: now(),
    };
    lastAlerts = crossings(report.windows ?? [], state.marks);
    if (report.email) state.account = report.email;
    state.report = report;
    return settle(report, true);
  } catch (e) {
    /* A timeout (AbortSignal), a dropped connection ("fetch failed"), or the
     * 5xx thrown just above ("usage http 5NN"): all network, none an account
     * fact. reason "network" so the card says "can't check right now", never
     * "not signed in". */
    return settle(staleFrom(state, (e as Error)?.message ?? "unreachable", "network"), true);
  }
}

/* Crossings found by the most recent successful read, for the caller that
 * wants to announce them. Read once: taking them clears them, so two callers
 * cannot both send the same push. */
let lastAlerts: LimitAlert[] = [];

export function takeAlerts(): LimitAlert[] {
  const a = lastAlerts;
  lastAlerts = [];
  return a;
}
