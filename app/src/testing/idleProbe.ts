// Idle instrumentation, on only under ?testhooks=1. It counts the things a
// phone pays for while the app is open and nothing is happening: timers
// firing, fetches leaving, and DOM mutations landing. A spec reads and resets
// the counters through window.__cycIdle; wire frames are counted by the rig's
// own pipe tap (__cycPipeSent), so they are not duplicated here.
//
// One wire thing is counted here: the presence beat's {t:"visible"} frames.
// They ride the pipe sealed, so the rig's tap sees only the {t:"x"} envelope
// and cannot read the inner {t:"visible"} back out to split them from product
// frames. The client bumps presenceFrames here the moment it puts one on the
// wire, so a spec can classify the beat as its own class instead of miscounting
// it as product traffic.
//
// This must be installed before the app schedules any timer or opens any
// socket, so main.ts calls it as its first statement.

type TimerRec = {kind: 'interval' | 'timeout'; delay: number; fires: number};

export interface IdleProbe {
  fires: number;
  intervalFires: number;
  timeoutFires: number;
  // Fires keyed by "<i|t><delayMs>", so a spec can attribute a stray tick.
  byDelay: Record<string, number>;
  fetches: {get: number; post: number; other: number; total: number};
  // Presence beat frames ({t:"visible"}) the client actually put on the wire.
  presenceFrames: number;
  mutations: number;
  longTasks: number;
  longTaskMs: number;
  reset(): void;
  snapshot(): IdleSnapshot;
  notePresenceFrame(): void;
  timers(): TimerRec[];
}

export interface IdleSnapshot {
  fires: number;
  intervalFires: number;
  timeoutFires: number;
  byDelay: Record<string, number>;
  fetches: {get: number; post: number; other: number; total: number};
  presenceFrames: number;
  mutations: number;
  longTasks: number;
  longTaskMs: number;
}

export function installIdleProbe(): void {
  let params: URLSearchParams;
  try {
    params = new URLSearchParams(location.search);
  } catch {
    return;
  }
  if (params.get('testhooks') === null) return;
  const w = window as unknown as {__cycIdle?: IdleProbe};
  if (w.__cycIdle) return;

  const timerById = new Map<number, TimerRec>();

  const state: IdleProbe = {
    fires: 0,
    intervalFires: 0,
    timeoutFires: 0,
    byDelay: {},
    fetches: {get: 0, post: 0, other: 0, total: 0},
    presenceFrames: 0,
    mutations: 0,
    longTasks: 0,
    longTaskMs: 0,
    reset() {
      state.fires = 0;
      state.intervalFires = 0;
      state.timeoutFires = 0;
      state.byDelay = {};
      state.fetches = {get: 0, post: 0, other: 0, total: 0};
      state.presenceFrames = 0;
      state.mutations = 0;
      state.longTasks = 0;
      state.longTaskMs = 0;
      for (const rec of timerById.values()) rec.fires = 0;
    },
    snapshot() {
      return {
        fires: state.fires,
        intervalFires: state.intervalFires,
        timeoutFires: state.timeoutFires,
        byDelay: {...state.byDelay},
        fetches: {...state.fetches},
        presenceFrames: state.presenceFrames,
        mutations: state.mutations,
        longTasks: state.longTasks,
        longTaskMs: Math.round(state.longTaskMs)
      };
    },
    notePresenceFrame() {
      state.presenceFrames++;
    },
    timers() {
      return [...timerById.values()].filter((r) => r.fires > 0);
    }
  };
  w.__cycIdle = state;

  const note = (kind: 'interval' | 'timeout', delay: number, id: number) => {
    state.fires++;
    if (kind === 'interval') state.intervalFires++;
    else state.timeoutFires++;
    const key = (kind === 'interval' ? 'i' : 't') + Math.round(delay);
    state.byDelay[key] = (state.byDelay[key] ?? 0) + 1;
    const rec = timerById.get(id);
    if (rec) rec.fires++;
  };

  const realSetInterval = window.setInterval.bind(window);
  const realSetTimeout = window.setTimeout.bind(window);
  const realClearInterval = window.clearInterval.bind(window);
  const realClearTimeout = window.clearTimeout.bind(window);

   
  window.setInterval = function (handler: any, timeout?: any, ...args: any[]) {
    const delay = Number(timeout) || 0;
    let id = 0;
    const wrapped =
      typeof handler === 'function'
        ? (...a: unknown[]) => {
            note('interval', delay, id);
            return (handler as (...z: unknown[]) => unknown)(...a);
          }
        : handler;
    id = realSetInterval(wrapped, timeout as number, ...args) as unknown as number;
    timerById.set(id, {kind: 'interval', delay, fires: 0});
    return id as unknown as ReturnType<typeof setInterval>;
     
  } as any;

   
  window.setTimeout = function (handler: any, timeout?: any, ...args: any[]) {
    const delay = Number(timeout) || 0;
    let id = 0;
    const wrapped =
      typeof handler === 'function'
        ? (...a: unknown[]) => {
            note('timeout', delay, id);
            timerById.delete(id);
            return (handler as (...z: unknown[]) => unknown)(...a);
          }
        : handler;
    id = realSetTimeout(wrapped, timeout as number, ...args) as unknown as number;
    timerById.set(id, {kind: 'timeout', delay, fires: 0});
    return id as unknown as ReturnType<typeof setTimeout>;
     
  } as any;

  window.clearInterval = ((id?: number) => {
    if (id !== undefined) timerById.delete(id);
    return realClearInterval(id as number);
     
  }) as any;
  window.clearTimeout = ((id?: number) => {
    if (id !== undefined) timerById.delete(id);
    return realClearTimeout(id as number);
     
  }) as any;

  const realFetch = window.fetch.bind(window);
  window.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const method = (
      init?.method ??
      (typeof input === 'object' && 'method' in input ? (input as Request).method : 'GET') ??
      'GET'
    ).toUpperCase();
    state.fetches.total++;
    if (method === 'GET') state.fetches.get++;
    else if (method === 'POST') state.fetches.post++;
    else state.fetches.other++;
    return realFetch(input, init);
     
  }) as any;

  const startObservers = () => {
    if (document.body) {
      new MutationObserver((records) => {
        state.mutations += records.length;
      }).observe(document.body, {
        childList: true,
        subtree: true,
        attributes: true,
        characterData: true
      });
    } else {
      realSetTimeout(startObservers, 0);
      return;
    }
    try {
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          state.longTasks++;
          state.longTaskMs += entry.duration;
        }
      }).observe({entryTypes: ['longtask']});
    } catch {
      // longtask is not in every engine; the count simply stays zero.
    }
  };
  startObservers();
}
