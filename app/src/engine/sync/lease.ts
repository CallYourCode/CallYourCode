import {cyclog} from '@/shared/logging';

/* One drainer per origin (offline design v2, section 3).
 *
 * Every tab of the app holds the same intent rows (one IndexedDB per origin),
 * so every tab would write every wire: the engine gets each send once per open
 * tab. One tab at a time holds the lease and runs the drain; the others paint
 * from the store and hand their rows to the holder. When the holder dies (tab
 * closed, crashed, navigated away) the next tab takes the lease, re-reads the
 * rows and drains.
 *
 * The lease is a Web Lock: the browser releases it the moment the holding
 * page goes. A holding page that is not gone but not running either (frozen
 * in the back/forward cache, a background tab the browser stopped) keeps the
 * lock and drains nothing, so the holder also says so over a BroadcastChannel
 * every second, and a follower that hears nothing for three seconds takes the
 * lock with `steal`. A holder that finds its own last beat older than that
 * (it was frozen) steps down before it writes another wire: it hands the lock
 * back, queues for it again, and leads only once it is granted afresh.
 *
 * Where Web Locks are missing (an insecure context, an old browser) the tabs
 * elect over the channel alone: the holder beats every second, a tab that
 * hears nothing for three seconds claims it, and of two claimants the lower
 * id keeps it. A thawed holder whose last beat is older than that has lost
 * the lease to whoever claimed it meanwhile: it steps down and listens. Where
 * neither API exists there is one tab: it leads. */

export const LOCK_NAME = 'cyc-drain';
export const CHANNEL_NAME = 'cyc-drain-lease';
export const HEARTBEAT_MS = 1_000;
export const LEASE_TTL_MS = 3_000;

export type ChannelLike = {
  postMessage(msg: unknown): void;
  onmessage: ((ev: MessageEvent) => void) | null;
  close(): void;
};
export type LocksLike = {
  request(name: string, options: {steal?: boolean}, cb: () => Promise<unknown>): Promise<unknown>;
};
export type LeaseApis = {
  locks: LocksLike | null;
  channel: ((name: string) => ChannelLike) | null;
  id?: string;
};

type Frame = {t: 'lease'; id: string};

let leader = false;
const subs = new Set<() => void>();
let channel: ChannelLike | null = null;
let beat: ReturnType<typeof setInterval> | null = null;
let claimTimer: ReturnType<typeof setTimeout> | null = null;
let stealTimer: ReturnType<typeof setTimeout> | null = null;
let stealArmedAt = 0;
let stealDelay = 0;
let selfId = '';
let random: () => number = Math.random;
// The holder's own last beat: older than the TTL means this tab was not
// running, and whatever it believes about the lease is stale.
let lastBeatAt = 0;

// Web Locks bookkeeping. Every request carries a generation so a grant or a
// rejection is matched to the request it answers; `held` is the generation
// this tab leads through, `release` settles that request's callback promise
// (the browser releases the lock then), `pending` counts the requests still
// queued so a follower re-queues at most once.
let locks: LocksLike | null = null;
let lockGen = 0;
let held: number | null = null;
let release: (() => void) | null = null;
let pending = 0;
let lockProven = false;
// Bumped on teardown: a request settling after a reset answers nothing.
let epoch = 0;

function lapsed(): boolean {
  return channel !== null && Date.now() - lastBeatAt > LEASE_TTL_MS;
}

// The drain asks before every wire write. A holder whose own beat has lapsed
// is not the holder any more, whatever `leader` still says.
export function isLeader(): boolean {
  if (leader && lapsed()) lapse();
  return leader;
}

// Called each time this tab takes the lease.
export function onLeader(cb: () => void): () => void {
  subs.add(cb);
  return () => {
    subs.delete(cb);
  };
}

function become(how: string): void {
  if (leader) return;
  leader = true;
  cyclog('drain.lease', {id: selfId, how});
  startBeating();
  for (const cb of [...subs]) cb();
}

function yieldTo(other: string): void {
  if (!leader) return;
  leader = false;
  stopBeating();
  cyclog('drain.lease-yield', {id: selfId, to: other});
}

function stopBeating(): void {
  if (beat !== null) {
    clearInterval(beat);
    beat = null;
  }
}

function stopTimers(): void {
  stopBeating();
  if (claimTimer !== null) {
    clearTimeout(claimTimer);
    claimTimer = null;
  }
  if (stealTimer !== null) {
    clearTimeout(stealTimer);
    stealTimer = null;
  }
}

function post(): void {
  if (lapsed()) {
    lapse();
    return;
  }
  lastBeatAt = Date.now();
  const f: Frame = {t: 'lease', id: selfId};
  channel?.postMessage(f);
}

function startBeating(): void {
  if (!channel) return;
  lastBeatAt = Date.now();
  post();
  stopBeating();
  beat = setInterval(post, HEARTBEAT_MS);
}

// This tab led, and was not running for longer than the TTL: another tab may
// hold the lease by now. Step down without a wire written, and queue again.
function lapse(): void {
  if (!leader) return;
  stopTimers();
  yieldTo('lapsed');
  if (held !== null) {
    handBack();
    requestLock(false);
    armSteal();
    return;
  }
  armClaim();
}

// The channel election: the holder beats, the rest wait for silence.
function armClaim(): void {
  if (claimTimer !== null) clearTimeout(claimTimer);
  claimTimer = setTimeout(
    () => {
      claimTimer = null;
      claim();
    },
    LEASE_TTL_MS + Math.round(random() * 500)
  );
}

function claim(): void {
  stopTimers();
  become('channel');
}

// Web Locks with a channel: a follower that hears no beat for the TTL takes
// the lock from a holder that is not running. A follower that was itself not
// running (its timer fired late) has heard nothing for a different reason:
// it listens for one more round before it steals from a live holder.
function armSteal(): void {
  if (!locks || !channel || leader) return;
  if (stealTimer !== null) clearTimeout(stealTimer);
  stealDelay = LEASE_TTL_MS + Math.round(random() * 500);
  stealArmedAt = Date.now();
  stealTimer = setTimeout(() => {
    stealTimer = null;
    if (Date.now() - stealArmedAt > stealDelay + HEARTBEAT_MS) {
      armSteal();
      return;
    }
    cyclog('drain.lease-steal', {id: selfId, why: 'no beat from the holder for the TTL'});
    requestLock(true);
  }, stealDelay);
}

function onFrame(ev: MessageEvent): void {
  const f = ev.data as Partial<Frame> | null;
  if (!f || f.t !== 'lease' || typeof f.id !== 'string' || f.id === selfId) return;
  if (held !== null) return; // the lock decides; a beat is not a claim
  if (leader) {
    // Two channel holders: the lower id keeps the lease, the other steps back.
    if (f.id < selfId) {
      stopTimers();
      yieldTo(f.id);
      armClaim();
    }
    return;
  }
  if (locks) {
    armSteal();
    return;
  }
  armClaim();
}

function handBack(): void {
  held = null;
  const done = release;
  release = null;
  done?.();
}

function requestLock(steal: boolean): void {
  if (!locks) return;
  if (!steal && pending > 0) return;
  const gen = ++lockGen;
  const era = epoch;
  pending++;
  let request: Promise<unknown>;
  try {
    request = locks.request(LOCK_NAME, steal ? {steal: true} : {}, () => {
      if (era !== epoch) return Promise.resolve();
      pending--;
      if (leader) {
        // Granted while this tab leads through another request: hand it
        // straight back so the queue moves on.
        return Promise.resolve();
      }
      lockProven = true;
      held = gen;
      stopTimers();
      const kept = new Promise<void>((resolve) => {
        release = resolve;
      });
      become(steal ? 'lock-steal' : 'lock');
      return kept;
    });
  } catch (err) {
    request = Promise.reject(err);
  }
  request.then(
    () => {
      if (era === epoch) onLockRequestDone(gen);
    },
    (err) => {
      if (era !== epoch) return;
      if (held === gen) {
        // Another tab took the lock with steal: this one was not running.
        cyclog('drain.lease-stolen', {id: selfId, err: String(err)});
        held = null;
        release = null;
        yieldTo('stolen');
        requestLock(false);
        armSteal();
        return;
      }
      if (gen === 1 && !lockProven && !leader) {
        // The API refused the first request outright: elect over the
        // channel instead, where there is one.
        pending = Math.max(0, pending - 1);
        cyclog('drain.lease-locks-failed', {err: String(err)});
        locks = null;
        stopTimers();
        if (channel) armClaim();
        else become('alone');
        return;
      }
      cyclog('drain.lease-request-rejected', {id: selfId, gen, err: String(err)});
      onLockRequestDone(gen);
    }
  );
}

// A request's promise settles once its callback promise has: the lock was
// handed back (a lapse, or a grant while leading). If this tab leads through
// nothing now, it queues again.
function onLockRequestDone(gen: number): void {
  if (held === gen) {
    // The browser ended a lock this tab did not hand back.
    held = null;
    release = null;
    yieldTo('released');
  }
  if (!leader && held === null) {
    requestLock(false);
    armSteal();
  }
}

export function start(apis: LeaseApis): void {
  selfId = apis.id ?? `${Date.now().toString(36)}-${Math.floor(random() * 1e9).toString(36)}`;
  if (apis.channel) {
    try {
      channel = apis.channel(CHANNEL_NAME);
      channel.onmessage = onFrame;
    } catch {
      channel = null;
    }
  }
  if (apis.locks) {
    locks = apis.locks;
    requestLock(false);
    armSteal();
    return;
  }
  if (channel) {
    armClaim();
    return;
  }
  become('alone');
}

function teardown(): void {
  epoch++;
  stopTimers();
  if (channel) {
    channel.onmessage = null;
    channel.close();
    channel = null;
  }
  if (held !== null) handBack();
  locks = null;
  lockGen = 0;
  held = null;
  release = null;
  pending = 0;
  lockProven = false;
  lastBeatAt = 0;
  leader = false;
}

// Test seam: with apis, run a real election over them; without, this tab
// leads at once so a drain under test never waits on a lease. Subscribers
// stay (the drain's is static; a test unsubscribes its own).
export function __resetForTest(apis?: LeaseApis, rnd?: () => number): void {
  teardown();
  random = rnd ?? Math.random;
  if (apis) {
    start(apis);
    return;
  }
  // Silent: a log line here would leave the log's ship timer behind in a
  // test that counts its timers.
  leader = true;
  for (const cb of [...subs]) cb();
}

const nav = typeof navigator !== 'undefined' ? (navigator as Navigator & {locks?: LocksLike}) : undefined;
start({
  locks: nav?.locks ?? null,
  channel:
    typeof window !== 'undefined' && 'BroadcastChannel' in window
      ? (name) => new BroadcastChannel(name)
      : null
});
