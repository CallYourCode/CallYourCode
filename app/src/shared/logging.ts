const RING_MAX = 1500;
const QUEUE_MAX = 600;
const BURST_MAX = 60;
const SHIP_MS = 1500;
const SHIP_AT = 40;
const GIVE_UP_AFTER = 5;
const VALUE_MAX = 300;
const SINK = '/clientlog';
const MUST_SHIP_EVENTS = new Set(['send.pressed']);

type LogFields = Record<string, unknown>;

function readFlag(name: string) {
  try {
    return new URLSearchParams(location.search).get(name) ?? localStorage.getItem(`cyc:${name}`);
  } catch {
    return null;
  }
}

const DEVLOG = readFlag('devlog');

/* THE HOSTED PRIVACY GATE. A local app ships its diagnostic log automatically
 * (the sink is the user's own machine; app.log is theirs). A hosted
 * (clerk-auth) app never auto-ships: lines stay in the on-device ring and
 * leave the device only inside an explicit bug report (/report, which attaches
 * logTail). contract.ts flips this switch once /config names the mode; until
 * then NOTHING ships (fail-private), and the queue holds the early lines so a
 * local app still ships its boot the moment local is confirmed. ?devlog=1
 * forces shipping for a debugging session; ?devlog=0 forces silence anywhere. */
let autoShip = false;
function shipAllowed(): boolean {
  if (DEVLOG === '0') return false;
  if (DEVLOG === '1') return true;
  return autoShip;
}
export function setLogAutoShip(enabled: boolean): void {
  autoShip = enabled;
  scheduleShip();
}

// Test hook: with ?testhooks=1 every cyclog emit (event + fields, before the
// burst cap and before formatting) is also handed to window.__cycLogTap when a
// spec has installed one. Specs count emits at the sink instead of parsing
// shipped or console lines.
type LogTap = (event: string, fields: LogFields) => void;
const TAPPED = readFlag('testhooks') !== null;
function tapped(): LogTap | null {
  if (!TAPPED) return null;
  const tap = (window as unknown as {__cycLogTap?: unknown}).__cycLogTap;
  return typeof tap === 'function' ? (tap as LogTap) : null;
}

function deviceTag() {
  try {
    const existing = localStorage.getItem('cyc-device-tag');
    if (existing) return existing;
    const created = Math.random().toString(36).slice(2, 7);
    localStorage.setItem('cyc-device-tag', created);
    return created;
  } catch {
    return 'nostore';
  }
}

const DEVICE = deviceTag();
const PAGE = Math.random().toString(36).slice(2, 7);
const ring: string[] = [];
let queue: string[] = [];
let dropped = 0;
let failures = 0;
let burst = 0;
let burstSecond = 0;
let shipping = false;
let shipTimer: ReturnType<typeof setTimeout> | undefined;
let beaconTimer: ReturnType<typeof setInterval> | undefined;

export function newCid(prefix = 'c') {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

function formatFields(fields: LogFields) {
  return Object.entries(fields)
    .flatMap<string>(([key, raw]) => {
      if (raw === undefined || raw === null) return [];
      let value: string;
      if (typeof raw === 'string') value = raw;
      else if (raw instanceof Error) value = `${raw.name}: ${raw.message}`;
      else {
        try {
          value = JSON.stringify(raw) ?? String(raw);
        } catch {
          value = String(raw);
        }
      }
      value = value.replace(/[\n\r\t]+/g, ' ');
      if (value.length > VALUE_MAX) value = `${value.slice(0, VALUE_MAX)}…`;
      return `${key}=${value === '' || /\s|"/.test(value) ? JSON.stringify(value) : value}`;
    })
    .join(' ');
}

function endpoint() {
  try {
    return new URL(SINK, location.origin).toString();
  } catch {
    return SINK;
  }
}

function keep(line: string) {
  ring.push(line);
  if (ring.length > RING_MAX) ring.splice(0, ring.length - RING_MAX);
  // Queue unconditionally; shipAllowed() gates the SEND, so lines logged
  // before /config names the mode still ship once a local app is confirmed.
  while (queue.length >= QUEUE_MAX) {
    queue.shift();
    dropped++;
  }
  queue.push(line);
}

async function ship() {
  if (!shipAllowed() || shipping || !queue.length || failures >= GIVE_UP_AFTER) return;
  shipping = true;
  const lines = queue;
  const lost = dropped;
  queue = [];
  dropped = 0;
  try {
    const result = await fetch(endpoint(), {
      method: 'POST',
      headers: {'content-type': 'application/json'},
      body: JSON.stringify({device: DEVICE, page: PAGE, dropped: lost, lines}),
      keepalive: true
    });
    if (!result.ok) throw new Error(String(result.status));
    failures = 0;
  } catch {
    failures++;
    queue = lines.concat(queue).slice(-QUEUE_MAX);
    dropped += lost;
  } finally {
    shipping = false;
  }
}

function scheduleShip() {
  if (!shipAllowed() || shipTimer) return;
  if (queue.length >= SHIP_AT) {
    void ship();
    return;
  }
  shipTimer = setTimeout(() => {
    shipTimer = undefined;
    void ship();
  }, SHIP_MS);
}

function flushBeacon() {
  if (!shipAllowed() || !queue.length) return;
  try {
    if (
      navigator.sendBeacon(
        endpoint(),
        new Blob([JSON.stringify({device: DEVICE, page: PAGE, dropped, lines: queue})], {
          type: 'application/json'
        })
      )
    ) {
      queue = [];
      dropped = 0;
    }
  } catch {}
}

export function cyclog(event: string, fields: LogFields = {}) {
  tapped()?.(event, fields);
  const second = Math.floor(Date.now() / 1000);
  if (second !== burstSecond) {
    burstSecond = second;
    burst = 0;
  }
  burst++;
  if (burst > BURST_MAX) {
    if (burst === BURST_MAX + 1)
      keep(`${new Date().toISOString()} app log.ratecap cap=${BURST_MAX}/s`);
    else if (!MUST_SHIP_EVENTS.has(event)) dropped++;
    if (!MUST_SHIP_EVENTS.has(event)) return;
  }
  const details = formatFields(fields);
  const line = `${new Date().toISOString()} app ${event} dev=${DEVICE} pg=${PAGE}${details ? ` ${details}` : ''}`;
  keep(line);
  scheduleShip();
  console.debug(line);
}

export function logSizeBeacon() {
  if (beaconTimer || typeof document === 'undefined') return;
  const startedAt = Date.now();
  beaconTimer = setInterval(() => {
    if (document.hidden) return;
    const memory = (performance as typeof performance & {memory?: {usedJSHeapSize: number}}).memory;
    cyclog('page.size', {
      nodes: document.getElementsByTagName('*').length,
      heapMB: memory ? Number((memory.usedJSHeapSize / 1048576).toFixed(1)) : null,
      upMin: Math.round((Date.now() - startedAt) / 60000)
    });
  }, 60_000);
}

export function logTail(count: number) {
  return ring.slice(-Math.max(0, count));
}

export function logIdentity() {
  return {device: DEVICE, page: PAGE};
}

export function logShipState() {
  return {queued: queue.length, dropped, failures};
}

if (typeof window !== 'undefined') {
  window.addEventListener('pagehide', flushBeacon);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flushBeacon();
  });
}
