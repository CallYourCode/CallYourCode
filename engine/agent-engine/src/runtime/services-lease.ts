/* ONE SUPERVISOR PER SERVICE PER HOST, decided by a file both unix users can
 * replace.
 *
 * services.ts is the guard that used to be a bash loop in a terminal tab, and
 * moving it into the engine moved it into EVERY engine: this Mac runs two, his
 * own on :10101 and the `work` account's on :7790 (deploy/macos/*.plist). Ports
 * are host-wide, so both of them see kokoro on :10104. Two supervisors racing to
 * spawn it is untidy; the other half is not: either engine's ceiling check could
 * restart the kokoro that is speaking to him, and the `work` engine would be
 * killing a process it did not start, cannot see the point of, and has no
 * business touching.
 *
 * So exactly one engine acts, and the rest measure and report -- which is worth
 * having, since /health on either engine then tells the same truth about the
 * host -- with their rows saying plainly that somebody else is the one doing
 * anything about it.
 *
 * PER SERVICE, NOT PER HOST, and that distinction was paid for.
 *
 * The first version of this file took ONE lease for the whole host, and it was
 * wrong in a way that would have been silent and total. The port is host-wide,
 * but the ABILITY TO FILL IT is per unix account: kokoro lives in
 * `~/.voicemode`, the transcriber in the checkout's own `stt/.venv`, and the
 * voice engine's LaunchAgent is under the running user's `~/Library`. On his
 * Mac `/Users/work/.voicemode` does not exist, so `work`'s engine can start
 * NOTHING -- and `scripts/deploy-engines.sh` restarts work FIRST, so work would
 * claim the host lease on every deploy and renew it for ever. The engine that
 * can start kokoro would stand down for the engine that cannot. Nobody starts
 * it, nobody caps it, and /health reports a healthy supervisor throughout.
 *
 * A host lease with a capability gate on top does not fix it, because there is
 * no such thing as "capable of the host": account A may have kokoro while
 * account B has the transcriber, and then a single lease has no valid holder --
 * one engine must either supervise what it cannot start or nothing is
 * supervised at all. The resource being contended is a PORT, so the lease is
 * named after the service that binds it, and the qualification to contend for
 * it is being able to start that service right now. An engine that cannot never
 * claims; a holder that stops being able (a checkout deleted underneath it)
 * gives it back on its next check.
 *
 * A service nothing can start -- whisper, watch-only -- has no lease at all.
 * There is nothing to be the one of.
 *
 * THE SHAPE IS limits-share.ts's, on purpose, and that file has the measurements
 * behind every part of it: claim by `link()` rather than `open(…,"wx")` so the
 * name never exists holding an empty file; judge and release BY INODE so a
 * process whose lease went stale cannot unlink the live holder's; and treat "the
 * file is not there" as a third answer rather than a flavour of "it says
 * nothing", because reading absent as dead is how that lease once produced 68
 * overlapping holds. The leaf directory is 0777 and NOT sticky, because in
 * /Users/Shared (drwxrwxrwt) one user may not unlink another's file -- and
 * taking over a dead engine's lease is exactly an unlink of another user's
 * file. Where that directory lives is not a detail either: see DEFAULT_DIR.
 *
 * WHAT IS DIFFERENT, and why it could not simply be that file. That lease is
 * held across one pair of HTTP calls and released in a `finally`, so staleness
 * alone settles it. This one is held for as long as the engine runs, which
 * changes two things:
 *
 *   - IT IS RENEWED. The holder re-stamps it on every check, so "the stamp is
 *     old" means the holder stopped checking, not that it is busy.
 *   - LIVENESS IS ASKED, NOT TIMED. `kill(pid, 0)` distinguishes a dead process
 *     (ESRCH) from another user's live one (EPERM), so a holder that died is
 *     replaced on the next tick rather than after a timeout. That matters
 *     because he restarts engines constantly: a deploy would otherwise leave the
 *     host with no supervisor for the whole stale window, every time.
 *
 * THE BOUND, since a lease that outlives its holder is the failure worth being
 * explicit about. A holder that dies is taken over by the next engine to tick
 * that can see its pid is gone: at most one check interval (60s in production,
 * and immediately if that engine is starting up). If the pid cannot be judged --
 * recycled, or a lease file nothing can parse -- the mtime backstop applies and
 * takeover is within staleMs (three intervals) plus one tick. Nothing waits
 * forever on a lease.
 *
 * NOTHING CROSS-HOST. linux does not share a filesystem with either Mac, so it
 * holds its own lease and supervises its own services, which is what you want:
 * these are processes on a machine, and the machine is the unit.
 */

import { randomUUID } from "node:crypto";
import { chmod, link, mkdir, readFile, stat, unlink, writeFile } from "node:fs/promises";
import { hostname, userInfo } from "node:os";

/** What /health says about who is supervising this host. */
export type LeaseView = {
  /** This engine is the one that starts, restarts and memory-caps things here. */
  holder: boolean;
  /** The pid holding it: ours when we hold it, theirs when we do not, null when
   *  the lease could not be read at all. */
  pid: number | null;
  /** Since when, as the holder last stamped it. */
  since: number | null;
  /** Who, in words, for a person reading /health. */
  note: string;
};

type LeaseFile = { pid: number; at: number; who: string; claim?: string };

/* A lease state, with "there is no file" kept separate from "the file says
 * nothing I can use". Reading those as the same thing is what let the limits
 * lease delete live claims. */
type LeaseState =
  | { kind: "held"; pid: number; at: number; who: string; ino: number }
  | { kind: "unreadable"; at: number; ino: number };

export type HostLeaseOpts = {
  /** The service this lease is for. It is the file's name, so two services on
   *  one host are contended separately and an engine that can start one of them
   *  is not standing down over the other. */
  name: string;
  dir?: string;
  /** How long an unrenewed lease may sit before anyone may take it. */
  staleMs?: number;
  log?: (line: string) => void;
};

/* DIRECTLY UNDER A DIRECTORY EITHER ACCOUNT CAN CREATE IN, and that is the
 * whole reason this is not `/Users/Shared/callyourcode/services` beside the
 * limits lease.
 *
 * Making a directory needs WRITE on its parent. `/Users/Shared/callyourcode`
 * is `drwxr-xr-x work:wheel` on his Mac -- whichever account got there first
 * owns it -- so only `work` can create a new leaf inside it, and `example` is
 * not in `wheel`. Chmod'ing the parent does not help: a non-owner's chmod is a
 * no-op. So the engine that can actually start kokoro would have found no lease
 * directory, held no lease, and started nothing, while /health said the host was
 * supervised. (The limits lease survives this only because its leaf already
 * exists at 0777: 0755 on the parent still grants everyone SEARCH, which is all
 * you need to write a file inside it.)
 *
 * `/Users/Shared` itself is `drwxrwxrwt`: every account may create in it and the
 * sticky bit stops any of them removing another's. So the leaf lives there, one
 * level up, and whichever engine starts first makes it 0777 for the other.
 * Asserted in services-lease.test.ts against the real filesystem rather than
 * assumed, because this is a fact about the machine and it changed once. */
export const DEFAULT_DIR = process.env.CYC_SERVICES_LEASE_DIR ??
  (process.platform === "darwin"
    ? "/Users/Shared/callyourcode-services"
    : "/tmp/callyourcode-services");

/** Is that process still there? Told apart from "not allowed to ask", which is
 *  what the other unix user's live engine looks like from here. */
function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM: it exists and belongs to somebody else. ESRCH: it is gone.
    return (e as NodeJS.ErrnoException)?.code === "EPERM";
  }
}

export class HostLease {
  private readonly dir: string;
  private readonly path: string;
  private readonly staleMs: number;
  private readonly log: (line: string) => void;
  private readonly who: string;
  private dirReady: Promise<boolean> | null = null;
  private saidNoDir = false;
  /** The inode we hold, which is the claim. Null when we do not hold it. */
  private mine: number | null = null;
  /** An instance-unique id: the suffix that keeps this engine's write probe
   *  distinct from its peers', and the claim written into the lease body so
   *  release() can tell OUR file from a new holder's re-created one -- the
   *  inode alone is not identity on Linux, where unlink+recreate reuses the
   *  inode number. */
  private readonly claim = randomUUID();
  /** When we first took the one we are holding. */
  private since: number | null = null;
  private view_: LeaseView = { holder: false, pid: null, since: null, note: "not looked at yet" };

  constructor(opts: HostLeaseOpts) {
    this.dir = opts.dir ?? DEFAULT_DIR;
    /* Named after the service, and sanitised because the name reaches the
     * filesystem: a key with a slash in it would put the lease somewhere else
     * entirely, and two keys that differed only there would share one. */
    this.path = `${this.dir}/supervisor.${opts.name.replace(/[^A-Za-z0-9._-]/g, "_")}.lease`;
    this.staleMs = opts.staleMs ?? 180_000;
    this.log = opts.log ?? (() => {});
    this.who = `${userInfo().username}@${hostname()}:${process.pid}`;
  }

  view(): LeaseView {
    return { ...this.view_ };
  }

  /* A YES IS REMEMBERED AND A NO IS NOT, which is the whole of this wrapper.
   *
   * It used to be one memo for both answers, and that is a defect with a shape
   * this repo keeps meeting: the first answer decides for ever. An engine that
   * starts before the directory is reachable -- which is a real ordering on his
   * Mac, see makeDir -- would never ask again, so it would watch and report for
   * the rest of its life on a host where it may be the only engine running.
   * That is kokoro never started and never capped until somebody restarts the
   * engine by hand, which is exactly the failure services.ts exists to end.
   *
   * Asking again costs one mkdir per check, once a minute, and it stops costing
   * anything the moment it works. */
  private async ensureDir(): Promise<boolean> {
    const ok = await (this.dirReady ??= this.makeDir());
    if (!ok) this.dirReady = null;
    return ok;
  }

  /* The answer is a PROBE rather than a mkdir that returned: mkdir succeeds when
   * the directory is already there in a mode this user cannot write, which is
   * exactly the case to catch -- the other unix account got here first. */
  private async makeDir(): Promise<boolean> {
    try {
      /* WIDENED BY WHOEVER GETS HERE FIRST, so the second account can claim,
       * renew and -- the one that needs write on the directory itself -- unlink
       * a stale lease of the first's. mkdir's mode is masked by the umask (022
       * gives 0755), so the chmod is not decoration; it is the only thing that
       * makes the directory shared. It is the leaf's owner doing it, which is
       * why this works where chmod'ing the PARENT did not: see DEFAULT_DIR. */
      await mkdir(this.dir, { recursive: true, mode: 0o777 });
      await chmod(this.dir, 0o777).catch(() => {});
      const probe = `${this.dir}/.probe.${process.pid}.${this.claim}`;
      await writeFile(probe, "");
      /* WriteFile succeeding already proved the directory is writable; the
       * unlink is cleanup, and its failure (ENOENT when a rival got here first)
       * must not read as "cannot write". */
      await unlink(probe).catch(() => {});
      return true;
    } catch (e) {
      // Once, not once a minute: this is asked again on every check now.
      if (!this.saidNoDir) {
        this.saidNoDir = true;
        this.log(`no shared lease directory at ${this.dir} (${(e as Error)?.message})`);
      }
      return false;
    }
  }

  private async read(): Promise<LeaseState | null> {
    let ino: number;
    let mtimeMs: number;
    try {
      const st = await stat(this.path);
      ino = st.ino;
      mtimeMs = st.mtimeMs;
    } catch {
      return null; // no lease here, which is not the same as a dead one
    }
    try {
      const j = JSON.parse(await readFile(this.path, "utf8")) as LeaseFile;
      if (typeof j?.at === "number") {
        return { kind: "held", pid: Number(j.pid) || 0, at: j.at, who: String(j.who ?? "?"), ino };
      }
    } catch {
      /* There, and saying nothing usable -- including the instant in the middle
       * of a renewal, when the file has been truncated and not yet written. The
       * mtime is fresh in that window, so it reads as a live lease and nobody
       * takes it. */
    }
    return { kind: "unreadable", at: mtimeMs, ino };
  }

  /** Take it, or keep it, or say who has it. Called on every check. */
  async acquireOrRenew(): Promise<boolean> {
    if (!(await this.ensureDir())) {
      /* NO SHARED DIRECTORY MEANS NOBODY SUPERVISES, and that is the deliberate
       * choice. The alternative -- act anyway -- is every engine on the host
       * supervising at once, which is the defect this file exists for. A host
       * where the lease cannot be written says so on /health and its services
       * are watched and reported, which is what they were before any of this. */
      this.view_ = { holder: false, pid: null, since: null,
        note: `no engine can supervise this host: the lease directory ${this.dir} ` +
          "cannot be written, so nothing here starts or stops anything" };
      this.mine = null;
      return false;
    }

    // Still ours? Renew in place: the inode is the claim, so the file is
    // rewritten rather than replaced.
    if (this.mine !== null) {
      const st = await stat(this.path).catch(() => null);
      if (st && st.ino === this.mine) {
        const at = Date.now();
        await writeFile(this.path, JSON.stringify({ pid: process.pid, at, who: this.who, claim: this.claim } satisfies LeaseFile))
          .catch(() => {});
        this.view_ = { holder: true, pid: process.pid, since: this.since ?? at,
          note: `this engine supervises this host (${this.who})` };
        return true;
      }
      /* Somebody took it: our file was unlinked as stale and re-created. That
       * means this engine stopped checking for longer than staleMs, so the
       * other one was right to. Stand down rather than fight for it. */
      this.log("the supervision lease was taken from this engine; it will only watch now");
      this.mine = null;
      this.since = null;
    }

    for (let attempt = 0; attempt < 3; attempt++) {
      const tmp = `${this.path}.${process.pid}.claim`;
      const at = Date.now();
      try {
        await writeFile(tmp, JSON.stringify({ pid: process.pid, at, who: this.who, claim: this.claim } satisfies LeaseFile),
          { mode: 0o666 });
        await chmod(tmp, 0o666).catch(() => {}); // the other unix user has to read it
        await link(tmp, this.path);
        this.mine = (await stat(this.path)).ino;
        this.since = at;
        this.log(`this engine now supervises this host (${this.who})`);
        this.view_ = { holder: true, pid: process.pid, since: at,
          note: `this engine supervises this host (${this.who})` };
        return true;
      } catch {
        // taken, or this user cannot write here after all
      } finally {
        await unlink(tmp).catch(() => {});
      }

      const held = await this.read();
      /* It went away between our claim failing and our looking. Nothing is
       * removed here: unlinking would delete whichever live claim landed in the
       * meantime. Go round and claim it properly. */
      if (!held) continue;

      /* THE TWO WAYS A LEASE ENDS, and both are needed.
       *
       * GONE: the holder's pid is not there. Taken at once -- this is the
       * common case, because it is what an engine restart looks like, and
       * waiting out a stale window on every deploy would leave the host
       * unsupervised for minutes at a time for no reason.
       *
       * STALE: the stamp is old. This is the holder that is still running but
       * has stopped checking, which its own pid cannot tell you, and the
       * backstop for a pid this process cannot judge -- an unreadable file
       * names nobody, and a recycled pid number reads as alive.
       *
       * A stamp in the FUTURE (age < 0) is not fresh, deliberately: a lease
       * from a clock that ran ahead can never age out, so honouring it would
       * mean this host has no supervisor for ever. */
      const age = Date.now() - held.at;
      const fresh = age >= 0 && age < this.staleMs;
      const gone = held.kind === "held" && held.pid > 0 && !pidAlive(held.pid);
      if (fresh && !gone) {
        this.view_ = {
          holder: false,
          pid: held.kind === "held" ? held.pid : null,
          since: held.kind === "held" ? held.at : null,
          note: held.kind === "held"
            ? `another engine on this host supervises it (${held.who}); this one only watches`
            : "another engine on this host holds the supervision lease; this one only watches",
        };
        return false;
      }
      // Over, and removed BY INODE so a holder that arrived since is left alone.
      this.log("taking over: the supervision lease was left by " +
        `${held.kind === "held" ? held.who : "a file that says nothing"}, ` +
        `${gone ? `whose pid ${(held as { pid: number }).pid} is gone` :
          `last touched ${Math.round(age / 1000)}s ago`}`);
      try {
        if ((await stat(this.path)).ino === held.ino) await unlink(this.path);
      } catch { /* already gone */ }
    }

    /* Three goes and still nothing: somebody is claiming as fast as we are, and
     * whoever wins, it is not this engine right now. */
    this.view_ = { holder: false, pid: null, since: null,
      note: "another engine on this host is claiming the supervision lease; this one only watches" };
    return false;
  }

  /** Give it back, and only if it is still the one we took. A released lease is
   *  what makes an engine restart cost nothing: the next process claims it
   *  immediately instead of waiting for the pid check or the stale window. */
  async release(): Promise<void> {
    const ino = this.mine;
    const claim = this.claim;
    this.mine = null;
    this.since = null;
    if (ino === null) return;
    try {
      const body = JSON.parse(await readFile(this.path, "utf8")) as { claim?: unknown };
      /* Inode alone is not identity after unlink+recreate, which reuses the
       * inode on Linux: an inode match can point at the new holder's file.
       * Unlink only while the body still carries OUR claim. */
      if (body?.claim !== claim) return;
      if ((await stat(this.path)).ino === ino) await unlink(this.path);
    } catch { /* already gone, or no longer ours */ }
  }
}
