/* THE ACCOUNT'S NUMBERS, ASKED FOR ONCE PER MACHINE INSTEAD OF ONCE PER ENGINE.
 *
 * How much of the five-hour window is gone is a fact about the ACCOUNT. Every
 * engine signed into it gets the same answer to the same question at the same
 * moment, so asking once per engine is not caution, it is the same request
 * sent twice. Measured 2026-08-01 it was worse than that: two engines at one
 * request pair every two minutes took 120 requests an hour off one account, the
 * endpoint started answering 429, and the card reported that refusal as a fact
 * about his plan.
 *
 * WHY A FILE AND NOT SOMETHING CLEVERER. Three options were on the table and
 * only this one needs nothing new to exist:
 *
 *   - ONE ENGINE DESIGNATED TO FETCH needs either configuration (a flag in two
 *     plists, wrong the first time somebody adds a third engine) or an
 *     election, which is this file plus a term. And when the designated engine
 *     is down, nobody asks and every card on the machine goes stale with no
 *     sign of why.
 *   - THE APP SERVER HOLDING IT cannot work. The token is per unix user, in
 *     that user's login keychain (limits.ts readToken), and the app server runs
 *     as one user on one host: it cannot read `work`'s keychain and it cannot
 *     read either Mac's from linux. It would be holding a number it has no way
 *     to obtain.
 *   - A SHARED FILE WITH A LEASE is what is written here. No new process, no
 *     configuration, and it works with the engines exactly as they are already
 *     deployed.
 *
 * WHAT IT CANNOT DO, said here rather than discovered later: THIS DEDUPES ONE
 * MACHINE. macbook-air, the other Mac and linux do not share a filesystem, so
 * each host still asks for itself. There is deliberately no cross-host
 * coordination: the only thing that could carry it is the app server, which is
 * on one host and cannot reach the others' tokens, and inventing a protocol for
 * three requests an hour would cost more than it saves.
 *
 * WHERE, and why it is not in either engine's checkout. The two engines on this
 * Mac are two UNIX USERS -- `example` on 10101 and `work` on 7790, see
 * deploy/macos/*.plist -- with their own home directories, their own checkouts
 * and their own `.run/`. Neither can write under the other's home, so a file
 * both can replace has to sit outside both. /Users/Shared is the macOS place
 * for that.
 *
 * THE LEAF DIRECTORY MUST NOT BE STICKY, which is the reason we make our own
 * inside it rather than using it directly: /Users/Shared is drwxrwxrwt, and in
 * a sticky directory you may not rename over, or unlink, a file belonging to
 * another user. `limits/` is 0777 and not sticky, so either user can replace
 * the other's entry and reclaim the other's abandoned lease. Its parent is left
 * at whatever the umask gives (0755 here) and belongs to whichever engine
 * started first; the other user only ever has to TRAVERSE it, which 0755
 * allows, and a world-writable directory bought nothing.
 *
 * AND IF ANY OF THAT FAILS, NOTHING BREAKS. A directory that already exists
 * with the wrong mode, a read-only filesystem, an OS that is not this one:
 * every function here answers "no" and each engine asks for itself, which is
 * what it did before this file existed. Sharing is an optimisation and is never
 * allowed to become a dependency -- the card telling the truth does not get to
 * depend on two unix accounts agreeing about a directory.
 */

import { chmod, link, mkdir, readdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import type { LimitsReport } from "./limits.ts";

/* WHERE THE SHARED DIRECTORY IS, AND WHY IT IS A FUNCTION.
 *
 * Overridable ONLY so a test can point at a directory it made and delete
 * afterwards. Nothing in the engine sets it.
 *
 * It is read at CALL time rather than at import for the same reason limits.ts
 * reads its own settings that way: this file's whole subject is what happens
 * when TWO engines share one machine, and a value fixed during import can only
 * be varied by spawning a process. Read per call, one test process can be both
 * engines in turn -- `resetForTest` between them is exactly the restart -- and
 * the directory they argue over is a real one that really goes away afterwards.
 * With no override the answer is byte-identical to what it always was. */
type ShareOverrides = {
  dir?: string;
  /** how long a lease may go untouched before the next engine takes it */
  leaseStaleMs?: number;
};
let over: ShareOverrides = {};

const shareDir = () => over.dir ?? process.env.CYC_LIMITS_SHARE_DIR ??
  (process.platform === "darwin"
    ? "/Users/Shared/callyourcode/limits"
    : "/tmp/callyourcode-limits");

/** Forget the once-per-process directory probe and (optionally) point this
 *  somewhere else. A no-op for production: nothing in the engine calls it. */
export function resetForTest(o: ShareOverrides = {}): void {
  over = o;
  dirReady = null;
  saidNoDir = false;
}

/* HOW LONG A LEASE MAY GO UNTOUCHED BEFORE THE NEXT ENGINE TAKES IT.
 *
 * There is no heartbeat here, and there does not need to be one: unlike the
 * schedule lock (schedules.ts) this is held across ONE pair of HTTP calls, each
 * with a ten second timeout, and then released in a `finally`. Anything still
 * holding it after thirty seconds is a process that died mid-ask, and the cost
 * of being wrong is one duplicate request rather than a duplicate message. A
 * heartbeat would be machinery bought for a case that lasts ten seconds.
 *
 * Overridable so a test can watch a lease go stale in milliseconds. Read per
 * call, for the reason given on shareDir() above. */
const leaseStaleMs = () =>
  over.leaseStaleMs ?? (Number(process.env.CYC_LIMITS_LEASE_STALE_MS) || 30_000);

/** A reading, and the instant the engine that took it ASKED. */
export type SharedEntry = { at: number; report: LimitsReport };

/** The right to ask upstream. `ino` is what makes releasing it safe. */
export type Lease = { path: string; ino: number };

export type LeaseResult =
  | { kind: "taken"; lease: Lease }
  /* Another engine on this machine is asking right now, and `since` is WHEN IT
   * STARTED, which the waiter needs and cannot guess. The obvious thing to wait
   * for is an entry stamped after the instant you started waiting, and it never
   * arrives: the engine you are waiting for began its request BEFORE that, so
   * it stamps its answer earlier and you sit out the whole window and then show
   * stale numbers about a reading that is in the file beside you. Measured on
   * the first version of this. */
  | { kind: "busy"; since: number }
  /** there is no shared directory here; the caller is on its own */
  | { kind: "unavailable" };

let dirReady: Promise<boolean> | null = null;
let saidNoDir = false;

/* Asked once per process, and the answer is a PROBE rather than a mkdir that
 * returned. mkdir succeeds when the directory is already there in a mode we
 * cannot write, which is exactly the case this has to catch: the other unix
 * user got here first under an older build with a 0755 default. */
async function ensureDir(): Promise<boolean> {
  return (dirReady ??= (async () => {
    const dir = shareDir();
    try {
      await mkdir(dir, { recursive: true, mode: 0o777 });
      // mkdir's mode is masked by the umask (022 on his Macs), so say it again.
      // Fails when the directory belongs to the other user, which is fine: the
      // probe below is what actually decides.
      await chmod(dir, 0o777).catch(() => {});
      const probe = `${dir}/.probe.${process.pid}`;
      await writeFile(probe, "");
      await unlink(probe);
      await sweep();
      return true;
    } catch (e) {
      if (!saidNoDir) {
        saidNoDir = true;
        console.warn(`[limits] no shared cache at ${dir} (${(e as Error)?.message}): ` +
          "every engine on this machine will ask upstream for itself");
      }
      return false;
    }
  })());
}

/* HOW LONG A HALF-FINISHED FILE MAY LIE AROUND BEFORE IT IS SWEPT.
 *
 * Every write here is to a temp name and then renamed, and every lease claim is
 * to a temp name and then linked, and both are removed on the way out. A
 * process killed between the two steps leaves its temp file behind for ever --
 * one more file in a directory two unix accounts share, per crash, with no
 * upper bound, in /Users/Shared where nothing else will ever tidy it.
 *
 * Generously past any real write, because the only cost of being wrong is
 * deleting a file somebody is in the middle of making, and they would then
 * simply make it again. */
const SCRAP_MS = 5 * 60_000;

/* Remove what earlier processes died holding. Once per process, on the way in:
 * it is a directory read, and doing it on every write would be a directory read
 * per poll for a case that happens when something crashes. */
async function sweep(): Promise<void> {
  const dir = shareDir();
  try {
    const now = Date.now();
    for (const name of await readdir(dir)) {
      if (!name.endsWith(".tmp") && !name.endsWith(".claim") && !name.startsWith(".probe.")) continue;
      const p = `${dir}/${name}`;
      const st = await stat(p).catch(() => null);
      if (st && now - st.mtimeMs > SCRAP_MS) await unlink(p).catch(() => {});
    }
  } catch {
    // a directory we cannot list is one we cannot tidy, and that is all
  }
}

/* ONE FILE PER ACCOUNT, named by a hash of the email.
 *
 * Not one file per machine with the account inside it. Two engines signed into
 * DIFFERENT accounts would then take turns overwriting each other's entry,
 * neither ever finding one it was allowed to use, and the lease would serialise
 * two requests that had no reason to wait for each other. Keyed by account they
 * simply never meet.
 *
 * Hashed rather than written out because it is a filename in a directory two
 * unix users share, and an email is not a filename. */
function fileFor(account: string): string {
  const key = createHash("sha256").update(account).digest("hex").slice(0, 16);
  return `${shareDir()}/acct-${key}.json`;
}

/* Is this actually a report, or merely an object?
 *
 * PARSING IS NOT UNDERSTANDING, and the difference reached the card. The check
 * used to be `j.report` truthy, so `{at: 1, report: {}}` -- a future build, a
 * half-understood shape, anything at all -- came back as a legitimate entry
 * whose `ok` was falsy, and the reader turned that into "the machine's attempt
 * failed" and, before that was fixed too, into "rate limited": the engine told
 * him he was being throttled on the strength of a file that said nothing.
 *
 * Two fields decide it, and they are the two the reader actually uses. Anything
 * that does not have them is not an entry, and not an entry means ask. */
function looksLikeReport(r: unknown): r is LimitsReport {
  const x = r as LimitsReport | undefined;
  return !!x && typeof x.ok === "boolean" && typeof x.fetchedAt === "number";
}

/** The newest reading any engine on this machine has for this account. */
export async function readShared(account: string): Promise<SharedEntry | null> {
  if (!(await ensureDir())) return null;
  try {
    const j = JSON.parse(await readFile(fileFor(account), "utf8")) as SharedEntry;
    return typeof j?.at === "number" && looksLikeReport(j?.report) ? j : null;
  } catch {
    // absent, half-written by an older build, or unreadable: all mean "ask"
    return null;
  }
}

/* Publish what we just got, for every other engine on this machine.
 *
 * EVERY COMPLETED ATTEMPT IS PUBLISHED, including one that came back 429 or
 * timed out, and `at` is when we ASKED. A failure that is not published is a
 * failure the next engine repeats a second later, which is two requests into an
 * endpoint that has just refused one. The reader decides what to do with a
 * failed entry; what it must not do is ask again on its own.
 *
 * Written to a temp name and renamed, so a reader never sees half a file. */
export async function writeShared(account: string, report: LimitsReport, at = Date.now()): Promise<void> {
  if (!(await ensureDir())) return;
  const path = fileFor(account);
  const tmp = `${path}.${process.pid}.tmp`;
  try {
    await writeFile(tmp, JSON.stringify({ at, report } satisfies SharedEntry), { mode: 0o666 });
    await chmod(tmp, 0o666).catch(() => {}); // the umask again; the other user has to read it
    await rename(tmp, path);
  } catch (e) {
    await unlink(tmp).catch(() => {});
    console.warn("[limits] could not publish to the shared cache:", (e as Error)?.message);
  }
}

/* WHAT THE LEASE FILE SAYS, and "there is no lease file" is a THIRD answer
 * rather than a flavour of "it says nothing".
 *
 * This returned null for both, and the caller read null as "dead, remove it".
 * Absent is not dead: between finding the name gone and unlinking it, another
 * process links its own claim into place, and we then delete a live one. Two
 * holders, and neither knows. Measured -- twelve processes, thirty rounds each,
 * SIXTY-EIGHT overlapping holds on code that had no `wx` in it anywhere. The
 * race the lease exists to prevent was in the lease.
 *
 * `at` for an unreadable file is its mtime, so a zero-byte leftover from a
 * killed process can still go stale and be cleared rather than blocking the
 * machine for ever. `ino` is what makes removing it safe: it names the file we
 * judged, not whatever the name points at by the time we act. */
type LeaseState =
  | { kind: "held"; pid: number; at: number; ino: number }
  | { kind: "unreadable"; at: number; ino: number };

async function readLease(path: string): Promise<LeaseState | null> {
  let ino: number;
  let mtimeMs: number;
  try {
    const st = await stat(path);
    ino = st.ino;
    mtimeMs = st.mtimeMs;
  } catch {
    return null; // there is no lease here, which is not the same as a dead one
  }
  try {
    const j = JSON.parse(await readFile(path, "utf8"));
    if (typeof j?.at === "number") return { kind: "held", pid: Number(j.pid) || 0, at: j.at, ino };
  } catch { /* there, and saying nothing usable */ }
  return { kind: "unreadable", at: mtimeMs, ino };
}

/** Remove the file we judged, not whatever now answers to that name. */
async function unlinkIfSame(path: string, ino: number): Promise<void> {
  try {
    if ((await stat(path)).ino === ino) await unlink(path);
  } catch { /* already gone */ }
}

/* THE RIGHT TO ASK, TAKEN BY LINKING RATHER THAN BY CREATING.
 *
 * `link()` is atomic and fails if the name is taken, and the file it publishes
 * already has the claim inside it. `open(path, "wx")` followed by a write does
 * not have that property: the name exists and the file is EMPTY for as long as
 * the write takes, and a second process reading in that window sees nothing it
 * can parse. That is not theory -- schedules.ts has the measurement, twenty
 * processes producing ten owners in one round.
 *
 * IT IS DEFENCE IN DEPTH RATHER THAN THE THING THAT SAVES US, and that has been
 * measured too: swapping this for `wx` now kills no test at all, because the
 * damage was never the empty window itself but what the reader DID about it,
 * and `readLease` no longer lets anybody act on a lease they could not read.
 * Kept because it is the same amount of code and the bad state never exists,
 * rather than merely never being acted on. e2e/mutation/limits-run.sh has the
 * numbers and names which mutation is actually holding this up (S).
 *
 * A lease nobody has touched since before any fetch could have finished belongs
 * to a process that died holding it, and is taken. Three attempts: claim, and
 * when that fails and what is there is dead, remove it and claim again. */
export async function takeLease(account: string): Promise<LeaseResult> {
  if (!(await ensureDir())) return { kind: "unavailable" };
  const path = `${fileFor(account)}.lease`;
  for (let attempt = 0; attempt < 3; attempt++) {
    const tmp = `${path}.${process.pid}.claim`;
    try {
      await writeFile(tmp, JSON.stringify({ pid: process.pid, at: Date.now() }), { mode: 0o666 });
      await link(tmp, path);
      /* The INODE behind the name is the claim from here on. Releasing by name
       * would let a process whose lease had gone stale and been taken by
       * somebody else unlink the live holder's. */
      const ino = (await stat(path)).ino;
      return { kind: "taken", lease: { path, ino } };
    } catch {
      // somebody holds it, or we cannot write here after all
    } finally {
      await unlink(tmp).catch(() => {});
    }

    const held = await readLease(path);
    /* IT WENT AWAY BETWEEN OUR CLAIM FAILING AND OUR LOOKING. The holder
     * released it, and the name is free or already somebody else's. Go round
     * and claim it properly. NOT removing anything here is the whole fix: this
     * used to fall through to an unlink, which deleted whichever live claim had
     * landed in the meantime. */
    if (!held) continue;

    /* HELD means a stamp in the past, recent enough to belong to a live fetch.
     *
     * A stamp in the FUTURE is taken, not waited on, and this comment used to
     * say the opposite of what the line under it did -- "a negative age is a
     * holder whose clock stepped back, not a stale lease" -- while the code
     * unlinked it anyway. The code is right and the sentence was wrong: a lease
     * from the future can never age out, so honouring it means every engine on
     * this machine waits for it for ever. Taking it costs one duplicate request
     * in the case where the holder really is alive with a fast clock. */
    const age = Date.now() - held.at;
    if (age >= 0 && age < leaseStaleMs()) {
      // an unreadable file names nobody, so there is no start time to wait from
      return { kind: "busy", since: held.kind === "held" ? held.at : Date.now() };
    }
    // dead, and removed BY INODE so a holder that arrived since is left alone
    await unlinkIfSame(path, held.ino);
  }
  /* Three goes and still nothing: somebody is claiming it as fast as we are.
   * Treated as busy, and `since` is now, because whoever has it started no
   * earlier than the moment we last looked. */
  return { kind: "busy", since: Date.now() };
}

/** Give it back, and only if it is still the one we took. */
export async function releaseLease(lease: Lease): Promise<void> {
  try {
    if ((await stat(lease.path)).ino === lease.ino) await unlink(lease.path);
  } catch {
    // already gone, or no longer ours: either way there is nothing to release
  }
}

/* Wait for whoever holds the lease to publish, instead of asking as well.
 *
 * This is the whole point of the lease. The loser of a race does not get a
 * worse answer by waiting -- it gets the SAME answer, from the same request,
 * about a second later -- whereas the loser asking gets the identical number at
 * the cost of a second request, which is the defect this file exists to fix.
 *
 * Bounded, because a winner can die between taking the lease and publishing.
 * The caller falls back to its own last-seen numbers, which is what it would
 * have shown for a failed request anyway. */
export async function awaitShared(
  account: string, after: number, ms: number, stepMs = 200,
): Promise<SharedEntry | null> {
  const until = Date.now() + ms;
  for (;;) {
    const s = await readShared(account);
    if (s && s.at >= after) return s;
    if (Date.now() >= until) return null;
    await new Promise((r) => setTimeout(r, Math.min(stepMs, Math.max(1, until - Date.now()))));
  }
}
