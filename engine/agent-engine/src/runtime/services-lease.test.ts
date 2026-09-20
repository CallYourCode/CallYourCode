/* ONE SUPERVISOR PER HOST, taken apart.
 *
 * services.test.ts proves the OUTCOME -- two engines, one start, one restart,
 * and a takeover when the holder is gone -- by driving real Services over real
 * child processes, which is the right shape for an outcome and the wrong one
 * for a mechanism: most of the ways this lease can be wrong are invisible from
 * outside because they need a rival that is dead, or unreadable, or owned by
 * another unix user. Those are the cases the lease exists for.
 *
 * So these are in-process, and they are all about the four questions the lease
 * has to answer without ever guessing:
 *
 *   - is anyone holding it? (and "the file is not there" is not "it says nothing")
 *   - is that holder alive? (and another user's live engine is ALIVE, not absent)
 *   - has it gone quiet? (and a stamp from the future is not fresh)
 *   - is the one I am removing still the one I looked at? (by inode, always)
 *
 * NOTHING HERE TOUCHES /Users/Shared. Every lease is in a per-file tmp
 * directory (test-utils/tmp.ts), so no run of these specs can make his own
 * engine stand down.
 *
 * AND NOTHING HERE SLEEPS. It used to wait out three real stale windows, which
 * is why those windows had been squeezed down to twenty milliseconds -- small
 * enough that a loaded box could make a spec flap for reasons that have nothing
 * to do with the lease. What makes a lease stale is the stamp inside it (or the
 * mtime, for one nobody can parse), so the stamp is backdated and the windows
 * are realistic again: see backdateStamp/backdateMtime.
 *
 *   bun test agent-engine/src/runtime/services-lease.test.ts
 */

import { test, expect } from "bun:test";
import { dirname } from "node:path";
import { readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { statSync } from "node:fs";
import { DEFAULT_DIR, HostLease } from "./services-lease.ts";
import { tmpDir } from "../test-utils/tmp.ts";
import { until } from "../test-utils/wait.ts";

/** A lease directory of this spec's own, removed when the file finishes. Never
 *  the default one: a run of these specs must not be able to make his own
 *  engine stand down. */
const leaseDir = () => tmpDir("cyc-leasespec-");

const leaseFile = (dir: string) => `${dir}/supervisor.toy.lease`;

/** Somebody else's claim, written by hand, because the interesting rivals are
 *  ones this process cannot be: dead, unreadable, or root's. */
async function plant(dir: string, body: unknown): Promise<void> {
  await writeFile(leaseFile(dir), typeof body === "string" ? body : JSON.stringify(body));
}

/** A pid that is certainly gone: spawned, waited for, and then not reused in the
 *  millisecond it takes to ask about it. This is what an engine that crashed
 *  leaves behind, and it is the common case -- he restarts engines constantly. */
async function deadPid(): Promise<number> {
  const p = Bun.spawn(["true"]);
  const pid = p.pid;
  await p.exited;
  return pid;
}

/* AGEING A LEASE INSTEAD OF WAITING FOR ONE TO AGE.
 *
 * These specs used to wait out their own stale windows with real sleeps, which
 * costs the whole suite time and buys nothing: what makes a lease stale is the
 * NUMBER in it (or the file's mtime, for one nobody can parse), not the wall
 * clock passing. Backdating says the same thing exactly and says it at once,
 * and it lets the stale window stay a realistic size instead of being squeezed
 * down to twenty milliseconds so a test could outlast it.
 *
 * Both shapes, because the lease has two ways of being old:
 *   - a READABLE one is judged by the `at` stamp inside it. Rewritten in place,
 *     so the inode -- which IS the claim -- does not move, and the claim id is
 *     preserved: a holder that lost its lease has to still look like the same
 *     holder, or the release-by-identity spec would be proving nothing.
 *   - an UNREADABLE one names nobody and has no stamp to read, so it is aged by
 *     its own mtime. utimes is the only way to say that.
 */
async function backdateStamp(dir: string, ms: number): Promise<void> {
  const body = JSON.parse(await readFile(leaseFile(dir), "utf8")) as { at: number };
  await writeFile(leaseFile(dir), JSON.stringify({ ...body, at: body.at - ms }));
}

async function backdateMtime(dir: string, ms: number): Promise<void> {
  const when = new Date(Date.now() - ms);
  await utimes(leaseFile(dir), when, when);
}

/* AN ENGINE THAT HAS NOT LOOKED SAYS SO. /health reads `view()` on every row,
 * including the first tick of a fresh engine, and a default that read as
 * "holder: false, another engine has it" would be this engine inventing a rival
 * it has never seen. Absent has to look absent. */
test("a lease that has not been asked about yet says exactly that", () => {
  const v = new HostLease({ name: "toy", dir: "/nowhere" }).view();
  expect(v.holder).toBe(false);
  expect(v.pid, "a lease nobody has looked at named a holder").toBeNull();
  expect(v.since).toBeNull();
  expect(v.note).toContain("not looked at yet");
});

/* THE WHOLE POINT, in one spec. Both engines ask at once; one acts. */
test("two engines on a host, and only one of them holds the lease", async () => {
  const dir = await leaseDir();
  const a = new HostLease({ name: "toy", dir });
  const b = new HostLease({ name: "toy", dir });

  const held = await Promise.all([a.acquireOrRenew(), b.acquireOrRenew()]);
  expect(held.filter(Boolean).length,
    "both engines supervised the host, or neither did").toBe(1);

  const [winner, loser] = held[0] ? [a, b] : [b, a];
  expect(winner.view().holder).toBe(true);
  expect(winner.view().pid, "the holder does not name itself").toBe(process.pid);
  expect(loser.view().holder).toBe(false);
  expect(loser.view().pid,
    "the watcher cannot say who holds it, so /health leaves the reader guessing")
    .toBe(process.pid);
  expect(loser.view().note).toContain("only watches");
});

/* TWO SERVICES ARE TWO CONTESTS. This is the whole reason the lease is named
 * after the service and not the host.
 *
 * kokoro lives in `~/.voicemode` and the transcriber in the checkout's own
 * `stt/.venv`, so which engine can start which is a fact about the unix
 * account, not about the host. One lease for the machine means the engine that
 * wins it supervises services it may not be able to start -- and on his Mac
 * that is exactly what would have happened, because `/Users/work/.voicemode`
 * does not exist and deploy-engines.sh restarts work FIRST. Named per service,
 * the two contests are settled separately and each can be won by whoever is
 * actually able to act. */
test("two services on one host are two separate contests", async () => {
  const dir = await leaseDir();
  const kokoro = new HostLease({ name: "kokoro", dir });
  const stt = new HostLease({ name: "stt", dir });

  expect(await kokoro.acquireOrRenew()).toBe(true);
  expect(await stt.acquireOrRenew(),
    "holding one service's lease took the other's, so one engine owns the whole host")
    .toBe(true);
  expect((await stat(`${dir}/supervisor.kokoro.lease`)).ino)
    .not.toBe((await stat(`${dir}/supervisor.stt.lease`)).ino);
});

/* THE OTHER UNIX USER HAS TO BE ABLE TO READ IT, and that is a mode on the
 * FILE, not only on the directory. `work`'s engine decides whether to stand
 * down by reading whose pid is in his engine's lease; a lease written 0600
 * (which is what an ordinary writeFile under umask 022 gives, and what
 * `writePrivate` would give deliberately) reads as unparsable to the other
 * account, so it would honour it for one stale window and then take it -- both
 * engines supervising in turn, for ever, with nothing saying why. The claim is
 * written 0666 and `link` carries the mode across, so what lands under the real
 * name is the readable one. */
test("the lease file is readable by the other unix account", async () => {
  const dir = await leaseDir();
  expect(await new HostLease({ name: "toy", dir }).acquireOrRenew()).toBe(true);
  expect((await stat(leaseFile(dir))).mode & 0o444,
    "the other account cannot read who is supervising this host").toBe(0o444);
});

/* RENEWAL IS WHAT KEEPS IT, which the specs above cannot separate from "it was
 * taken recently". Here the holder's lease is aged past the window, a rival is
 * refused only because the holder renewed in between, and the rival's own stale
 * window is short enough that nothing else could explain it. Without the
 * renewal branch the holder would be robbed on the next rival tick. */
test("a holder that keeps checking keeps the lease past the stale window", async () => {
  const dir = await leaseDir();
  const holder = new HostLease({ name: "toy", dir });
  const rival = new HostLease({ name: "toy", dir, staleMs: 1_000 });
  expect(await holder.acquireOrRenew()).toBe(true);

  await backdateStamp(dir, 60_000);          // the holder went quiet for a minute
  expect(await holder.acquireOrRenew(), "the holder lost its own lease").toBe(true);
  expect(await rival.acquireOrRenew(),
    "the holder renewed and was robbed anyway, so nothing can hold a lease for long")
    .toBe(false);
  expect(rival.view().pid).toBe(process.pid);
});

/* A key reaches the filesystem, so it is not allowed to choose the path. */
test("a service key cannot escape the lease directory", async () => {
  const dir = await leaseDir();
  const sneaky = new HostLease({ name: "../../etc/passwd", dir });
  expect(await sneaky.acquireOrRenew()).toBe(true);
  expect((await stat(`${dir}/supervisor..._.._etc_passwd.lease`)).ino,
    "the lease was written outside the directory it was given").toBeGreaterThan(0);
});

/* RENEWED IN PLACE. The inode is the claim: if a renewal replaced the file,
 * every other engine's "is this still the one I looked at" check would be
 * answered no, and the holder would be robbed of its own lease on the next
 * tick. `since` is the first claim, not the last renewal, because /health says
 * how long this engine has been the supervisor. */
test("renewing keeps the same lease rather than replacing it", async () => {
  const dir = await leaseDir();
  const a = new HostLease({ name: "toy", dir });
  await a.acquireOrRenew();
  const first = (await stat(leaseFile(dir))).ino;
  const since = a.view().since;

  /* The renewal has to land on a LATER millisecond than the claim, or the
   * "was the stamp refreshed" assertion below cannot tell a refreshed stamp
   * from the original one. Polled rather than slept: the wait is for the
   * system clock to tick over, which is under a millisecond, not for a lease
   * to do anything. */
  await until(() => Date.now() > since!, { what: "the clock to move past the first claim" });
  expect(await a.acquireOrRenew(), "the holder lost its own lease on renewal").toBe(true);
  expect((await stat(leaseFile(dir))).ino, "a renewal replaced the file, so the claim moved")
    .toBe(first);
  expect(a.view().since, "the holder says it has been supervising since its last renewal")
    .toBe(since);

  const written = JSON.parse(await readFile(leaseFile(dir), "utf8")) as { at: number };
  expect(written.at, "the stamp was not refreshed, so the holder ages out while holding")
    .toBeGreaterThan(since!);
});

/* A HOLDER THAT DIED IS REPLACED AT ONCE, not after a timeout. The stale window
 * here is an hour, so nothing but "that pid is gone" can explain the takeover.
 * This is what an engine restart looks like from the other engine's side, and
 * waiting out three minutes on every deploy would leave the host unsupervised
 * for minutes at a time, several times a day. */
test("a lease whose holder is gone is taken immediately, however fresh the stamp", async () => {
  const dir = await leaseDir();
  await plant(dir, { pid: await deadPid(), at: Date.now(), who: "an engine that crashed" });

  const b = new HostLease({ name: "toy", dir, staleMs: 3_600_000 });
  expect(await b.acquireOrRenew(),
    "a dead engine's lease outlived it, so this host has no supervisor").toBe(true);
  expect(b.view().pid).toBe(process.pid);
});

/* THE OTHER UNIX USER'S ENGINE IS ALIVE. `kill(pid, 0)` on a process this user
 * does not own raises EPERM, and reading that as "no such process" is the one
 * mistake that turns the whole lease into a race: BOTH engines on his Mac would
 * see the other as dead and take over from each other for ever. pid 1 is
 * launchd, root's, running, and always there. */
test("a live holder belonging to another unix user is left alone", async () => {
  const dir = await leaseDir();
  await plant(dir, { pid: 1, at: Date.now(), who: "root@this-mac:1" });

  const b = new HostLease({ name: "toy", dir });
  expect(await b.acquireOrRenew(),
    "a live engine owned by another unix user read as dead, so both engines supervise")
    .toBe(false);
  expect(b.view().pid, "the watcher does not name the holder it can see").toBe(1);
  expect((await stat(leaseFile(dir))).ino, "the live holder's lease was unlinked")
    .toBeGreaterThan(0);
});

/* A HOLDER THAT IS RUNNING BUT HAS STOPPED CHECKING. Its own pid cannot tell
 * you that, so the stamp is the only evidence, and this is the case the stale
 * window exists for: a wedged engine still holding the lease is a host with no
 * supervisor and no sign of it. */
test("a live holder that stopped renewing loses the lease when its stamp goes stale", async () => {
  const dir = await leaseDir();
  await plant(dir, { pid: process.pid, at: Date.now() - 5_000, who: "an engine that wedged" });

  const patient = new HostLease({ name: "toy", dir, staleMs: 60_000 });
  expect(await patient.acquireOrRenew(),
    "a lease five seconds old was taken from a live holder").toBe(false);

  const b = new HostLease({ name: "toy", dir, staleMs: 1_000 });
  expect(await b.acquireOrRenew(),
    "an engine that stopped checking went on holding the lease for ever").toBe(true);
});

/* A STAMP FROM THE FUTURE IS NOT FRESH. A clock that ran ahead -- or a lease
 * written before a time correction -- would otherwise never age out, and this
 * host would have no supervisor for as long as the file sat there. Judged by
 * age rather than by comparison so that "not yet" and "long ago" both mean the
 * holder is not answering. */
test("a lease stamped in the future does not hold the host for ever", async () => {
  const dir = await leaseDir();
  await plant(dir, { pid: process.pid, at: Date.now() + 3_600_000, who: "a clock that ran ahead" });

  const b = new HostLease({ name: "toy", dir, staleMs: 60_000 });
  expect(await b.acquireOrRenew(),
    "a lease from the future can never go stale, so nothing ever supervises this host")
    .toBe(true);
});

/* A FILE THAT SAYS NOTHING IS STILL A CLAIM, for as long as its mtime is fresh.
 * That window is real and it is small: it is the instant in the middle of a
 * renewal when the file has been truncated and not yet written. Reading it as
 * "nobody holds this" would take the lease off a healthy holder roughly as often
 * as it renews. */
test("a lease nobody can parse is honoured while it is fresh, and taken when it is not", async () => {
  const dir = await leaseDir();
  await plant(dir, "{ half a rene");
  /* Backdated a little, and that is not a fudge: for an UNREADABLE lease the
   * `at` this compares is the file's MTIME, so the freshness test puts the
   * filesystem's clock and the system clock either side of a `>= 0`. Those are
   * two clocks. A sub-millisecond inversion between them on a loaded box makes
   * a file written microseconds ago read as "stamped in the future", therefore
   * not fresh, therefore taken: the exact takeover this branch exists to
   * prevent, failing about one full-suite run in two. 50ms is still four
   * orders of magnitude inside the 60s window under test, so what is being
   * asserted is unchanged; it just is not also a race between two clocks. */
  await backdateMtime(dir, 50);

  expect(await new HostLease({ name: "toy", dir, staleMs: 60_000 }).acquireOrRenew(),
    "a lease caught mid-renewal was taken off a healthy holder").toBe(false);

  /* ...and the other half, which matters more: if an unreadable lease were
   * honoured for ever, one badly timed kill would leave this host with no
   * supervisor and no way back short of somebody finding the file by hand.
   * There is no stamp inside it to age, so it is the mtime that goes back. */
  await backdateMtime(dir, 60_000);
  const b = new HostLease({ name: "toy", dir, staleMs: 1_000 });
  expect(await b.acquireOrRenew(),
    "a file nothing can read holds this host for ever").toBe(true);
  expect(b.view().holder).toBe(true);
});

/* GIVING IT BACK IS WHAT MAKES A RESTART FREE. A released lease is claimed by
 * the next engine on its first check instead of after the pid check, which is
 * the difference between a deploy costing nothing and a deploy costing a tick. */
test("a lease given back is taken by the next engine at once", async () => {
  const dir = await leaseDir();
  const a = new HostLease({ name: "toy", dir });
  const b = new HostLease({ name: "toy", dir, staleMs: 3_600_000 });
  await a.acquireOrRenew();
  expect(await b.acquireOrRenew(), "two engines held it at once").toBe(false);

  await a.release();
  expect(await b.acquireOrRenew(),
    "the lease outlived the engine that gave it back").toBe(true);
});

/* AND ONLY IF IT IS STILL OURS. An engine whose lease was taken while it was
 * wedged still thinks it holds one; releasing on the way out must not delete
 * the claim of whoever is supervising the host NOW. Judged by inode, because
 * the name is the same file to everybody and the identity is not. */
test("releasing a lease that has since been taken does not delete the new holder's", async () => {
  const dir = await leaseDir();
  const wedged = new HostLease({ name: "toy", dir, staleMs: 1_000 });
  await wedged.acquireOrRenew();

  // it stops checking: the stamp it left stops moving, and the file ages
  await backdateStamp(dir, 60_000);
  const b = new HostLease({ name: "toy", dir, staleMs: 1_000 });
  expect(await b.acquireOrRenew(), "the stale lease was not taken over").toBe(true);
  const theirs = (await stat(leaseFile(dir))).ino;

  await wedged.release();
  expect((await stat(leaseFile(dir)).catch(() => null))?.ino,
    "an engine standing down deleted the live supervisor's lease").toBe(theirs);
});

/* NO SHARED DIRECTORY MEANS NOBODY SUPERVISES, deliberately. The alternative --
 * act anyway -- is every engine on the host supervising at once, which is the
 * defect this file exists for. The row says so rather than reading as an engine
 * that is quietly in charge. */
test("an engine that cannot write the lease directory supervises nothing, and says so", async () => {
  const b = new HostLease({ name: "toy", dir: "/dev/null/there-is-no-directory-here" });
  expect(await b.acquireOrRenew(),
    "an engine that could not take the lease supervised the host anyway").toBe(false);
  expect(b.view().holder).toBe(false);
  expect(b.view().note, "/health does not say why nothing is being supervised")
    .toContain("cannot be written");
});

/* AND IT ASKS AGAIN. The directory is unreachable when this engine starts and
 * reachable a moment later, which is not a contrivance: on his Mac the leaf
 * lives under /Users/Shared/callyourcode, a directory owned by whichever
 * account created it first, and the other account's engine can only make the
 * leaf once the owner's engine has widened it. An engine that asked once would
 * spend the rest of its life watching a host it may be the only engine on --
 * kokoro never started, never capped, and nothing to say why. */
test("an engine that could not reach the lease directory asks again on the next check", async () => {
  const root = await leaseDir();
  // a FILE where the parent directory needs to be: mkdir cannot pass through it
  await writeFile(`${root}/callyourcode`, "");
  const dir = `${root}/callyourcode/services`;

  const b = new HostLease({ name: "toy", dir });
  expect(await b.acquireOrRenew(), "it took a lease it could not have written").toBe(false);

  await rm(`${root}/callyourcode`);
  expect(await b.acquireOrRenew(),
    "the first answer was remembered, so this engine never supervises anything again")
    .toBe(true);
  expect(b.view().holder).toBe(true);
});

/* BOTH ACCOUNTS HAVE TO BE ABLE TO GET IN. Two unix users share this lease, and
 * a leaf only one of them can write is a host where one engine supervises and
 * the other cannot even take over when it dies -- taking over is an unlink of
 * another user's file, which needs write on the directory. mkdir's mode is
 * masked by the umask (022 leaves 0755), so the chmod is the whole of it. */
test("the lease directory is left writable by both accounts", async () => {
  const root = await leaseDir();
  const dir = `${root}/services`;

  expect(await new HostLease({ name: "toy", dir }).acquireOrRenew()).toBe(true);
  expect((await stat(dir)).mode & 0o777,
    "the other unix user cannot write the lease directory").toBe(0o777);
});

/* AND THE DEFAULT HAS TO BE SOMEWHERE EITHER ACCOUNT CAN CREATE, which is a
 * fact about the machine rather than about this code, so it is measured against
 * the real filesystem.
 *
 * This is the one that shipped broken. The default was
 * `/Users/Shared/callyourcode/services`, beside the limits lease, and making
 * a directory needs WRITE on its parent: `/Users/Shared/callyourcode` is
 * `drwxr-xr-x work:wheel`, so `example`'s engine -- the only account on his Mac
 * with a kokoro to start -- could not create it, held no lease, and started
 * nothing, while /health reported the host supervised. The limits lease got
 * away with it because its leaf already existed at 0777, and 0755 on a parent
 * still grants everyone the SEARCH needed to write a file inside.
 *
 * A directory this engine cannot create is a directory this engine cannot
 * supervise from, whoever else can. */
test("the default lease directory sits somewhere either account can create", () => {
  if (process.env.CYC_SERVICES_LEASE_DIR) return; // pointed elsewhere by a harness
  const parent = dirname(DEFAULT_DIR);
  const mode = statSync(parent).mode & 0o777;
  expect(mode & 0o002,
    `${parent} is not world-writable, so an engine whose account does not own it ` +
    `cannot create ${DEFAULT_DIR} and will supervise nothing`).toBeGreaterThan(0);
});
