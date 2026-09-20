/* THE GUARDRAILS: what a test engine is FORBIDDEN to touch, as functions.
 *
 * Moved out of notify-harness.ts verbatim so they are three things at once: the
 * boot harness's own refusal (e2e/harness.ts imports them and refuses to spawn
 * an engine when any of them speaks), a unit-testable subject in their own
 * right (guardrails.test.ts), and one written-down place to read what a test
 * run may never reach: his Anthropic token, his real upstream, his real
 * services, the supervision lease his real engines argue over.
 */

/* NO TEST ENGINE ASKS ANTHROPIC ANYTHING, AND THIS IS THE PART THAT ENFORCES IT.
 *
 * Every engine started here is a real one, and a real one polls its plan limits
 * on the way up with whatever token the machine is signed in with. That means
 * every spec in this repo that boots a harness was sending requests to the live
 * usage endpoint, against an account our own polling was already rate limiting
 * (task 155). Found by looking rather than by reasoning: a run of the related
 * specs wrote his real usage numbers into /Users/Shared.
 *
 * Setting CYC_LIMITS_API to a dead port fixes that, and a line that fixes
 * something is a line somebody deletes. So it is not only set below, it is
 * CHECKED, and the check is what a spec runs into rather than a convention it
 * can drift away from: delete the default and every harness spec in the repo
 * fails at spawn with this sentence, instead of quietly going back to the real
 * endpoint with his credentials.
 *
 * `...env` still wins, because a spec testing the limits path needs its own
 * upstream. It has to be a LOCAL one. There is no legitimate reason for a test
 * to reach a host on the internet, and this is the only thing standing between
 * a careless override and his token.
 *
 * A separate function so it can be tested for what it accepts and what it
 * refuses without booting anything (limits.test.ts). */
export function whyNotLocalUpstream(url: string | undefined): string | null {
  if (!url) return "there is no CYC_LIMITS_API, so the engine would use the real one";
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    return `CYC_LIMITS_API is not a URL: ${url}`;
  }
  // the bracketed form is what new URL() gives back for ipv6
  if (host === "127.0.0.1" || host === "localhost" || host === "::1" || host === "[::1]") return null;
  return `CYC_LIMITS_API points at ${host}, which is not this machine. A test engine ` +
    "may only ever talk to an upstream you started yourself.";
}

/* AND NO TEST ENGINE HOLDS HIS TOKEN EITHER, which is a different sentence from
 * the one above and was not true when only that one was enforced.
 *
 * A dead upstream stops anything reaching the wire. It does not stop the engine
 * reading his OAuth token out of the login keychain and building an
 * Authorization header round it, which every harness engine was doing. Nothing
 * leaked, and "nothing leaked" is a fact about where the requests went rather
 * than about what the process was holding. The token should never be in it.
 *
 * CYC_LIMITS_CREDENTIALS names the file limits.ts reads INSTEAD of the keychain,
 * and when it is set the keychain is never consulted at all -- so this is not a
 * preference the engine can fall back from. Checked, not merely set, for the
 * same reason as the upstream: a default that is only a default is a default
 * somebody deletes. */
export function whyNotFakeCredentials(path: string | undefined, dir: string): string | null {
  if (!path) {
    return "there is no CYC_LIMITS_CREDENTIALS, so the engine would read his real " +
      "OAuth token out of the login keychain";
  }
  if (!path.startsWith(dir)) {
    return `CYC_LIMITS_CREDENTIALS is ${path}, which is not inside this engine's own ` +
      "throwaway directory. A test engine gets a made-up token or none.";
  }
  return null;
}

/* AND NO TEST ENGINE SUPERVISES HIS REAL SERVICES.
 *
 * A real engine starts, watches and memory-caps this host's services
 * (services.ts). Left alone, every harness engine in this repo would adopt the
 * kokoro that is actually speaking to him on :10104, measure it, and be one
 * ceiling reading away from restarting it -- and a test run has no business
 * taking his speech away, exactly as a test run had no business being his mute
 * button for an afternoon.
 *
 * CYC_SERVICES_FILE names the table the engine uses INSTEAD of the real one,
 * and the harness writes an empty one. A spec that wants services writes its
 * own into the same path, on ports it started itself. The reserved list is the
 * whole of this fleet's real port map, so a spec cannot reach any of them by
 * accident or by copy-paste. */
const HIS_PORTS = new Map<number, string>([
  [10103, "his batch stt (whisper.cpp)"], [10101, "his agent engine"], [10102, "his voice engine"],
  [7790, "the work agent engine"], [10100, "the app server"], [10104, "his kokoro"],
  [10105, "his streaming stt"],
]);

export function whyNotFakeServices(path: string | undefined, dir: string, table: string,
  leaseDir?: string): string | null {
  /* The lease that decides which engine on the host supervises it
   * (services-lease.ts) lives in /Users/Shared, where BOTH his real engines
   * look. A test engine taking it would make his own engine stand down and stop
   * watching kokoro for as long as the spec ran. A spec that wants two engines
   * to share one gives them a directory it made itself. */
  if (!leaseDir) return "there is no CYC_SERVICES_LEASE_DIR, so a test engine could take " +
    "the supervision lease his real engines use";
  if (leaseDir.startsWith("/Users/Shared")) {
    return `CYC_SERVICES_LEASE_DIR is ${leaseDir}, which is where his real engines decide ` +
      "which of them supervises this Mac. A test engine gets a directory of its own.";
  }
  if (!path) {
    return "there is no CYC_SERVICES_FILE, so the engine would supervise the machine's " +
      "real services";
  }
  if (!path.startsWith(dir)) {
    return `CYC_SERVICES_FILE is ${path}, which is not inside this engine's own throwaway ` +
      "directory. A test engine supervises services it started itself, or none.";
  }
  let specs: { port?: number; name?: string }[];
  try {
    const parsed = JSON.parse(table);
    if (!Array.isArray(parsed)) return `CYC_SERVICES_FILE (${path}) is not a list of services`;
    specs = parsed;
  } catch (e) {
    return `CYC_SERVICES_FILE (${path}) is not JSON: ${String(e)}`;
  }
  for (const s of specs) {
    const his = HIS_PORTS.get(Number(s?.port));
    if (his) {
      return `CYC_SERVICES_FILE has a service on :${s.port}, which is ${his}. A test engine ` +
        "may only ever supervise a process you started yourself, on a port nobody uses.";
    }
  }
  return null;
}
