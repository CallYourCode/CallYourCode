import {appFetch} from './appFetch';

const SW_URL = '/cyc-sw.js';

const APP = '';
const LABEL_KEY = 'cyc-push-label';

const b64ToU8 = (base64: string) => {
  const pad = '='.repeat((4 - (base64.length % 4)) % 4);
  const raw = atob((base64 + pad).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
};

const pushSupported = () =>
  'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;

export function installedForPush(): boolean {
  const ios =
    /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  if (!ios) return true;
  return (
    (navigator as any).standalone === true ||
    window.matchMedia('(display-mode: standalone)').matches
  );
}

function deviceLabel(): string {
  let label = localStorage.getItem(LABEL_KEY);
  if (label) return label;
  const ua = navigator.userAgent;
  const kind = /iPhone/.test(ua)
    ? 'iPhone'
    : /iPad/.test(ua)
      ? 'iPad'
      : /Android/.test(ua)
        ? 'Android'
        : /Macintosh/.test(ua)
          ? 'Mac'
          : /Windows/.test(ua)
            ? 'Windows'
            : 'browser';
  const browser = /CriOS|Chrome/.test(ua) ? 'Chrome' : /Firefox/.test(ua) ? 'Firefox' : 'Safari';
  label = `${kind} ${browser}`;
  localStorage.setItem(LABEL_KEY, label);
  return label;
}

let registration: ServiceWorkerRegistration | null = null;

async function ensureWorker(): Promise<ServiceWorkerRegistration | null> {
  if (!pushSupported()) return null;
  if (registration) return registration;
  try {
    registration = await navigator.serviceWorker.register(SW_URL, {scope: '/'});
    await navigator.serviceWorker.ready;
    return registration;
  } catch (e) {
    console.warn('[push] service worker registration failed', e);
    return null;
  }
}

const sameKey = (a: ArrayBuffer | null | undefined, b: Uint8Array) => {
  if (!a) return false;
  const x = new Uint8Array(a);
  return x.length === b.length && x.every((v, i) => v === b[i]);
};

// One subscribe attempt, honest about which step broke: 'register-failed'
// means the app server could not be reached or said no (the key fetch or the
// registration POST); 'subscribe-failed' means the browser side broke (a stale
// subscription that would not clear, or pushManager.subscribe itself).
type SubscribeStep = 'on' | 'subscribe-failed' | 'register-failed';

async function subscribeTo(
  httpBase: string,
  reg: ServiceWorkerRegistration
): Promise<SubscribeStep> {
  const key = await appFetch(httpBase + '/push/key', {signal: AbortSignal.timeout(8000)})
    .then((r): Promise<{key?: string}> => r.json())
    .catch((): null => null);
  if (!key?.key) return 'register-failed';
  const bytes = b64ToU8(key.key);

  let sub = await reg.pushManager.getSubscription().catch((): null => null);
  const hadSub = !!sub;
  if (sub && !sameKey(sub.options?.applicationServerKey, bytes)) {
    try {
      await sub.unsubscribe();
      sub = null;
    } catch (e) {
      console.warn('[push] stale subscription could not be replaced', e);
      return 'subscribe-failed';
    }
  }
  try {
    sub =
      sub ??
      (await reg.pushManager.subscribe({userVisibleOnly: true, applicationServerKey: bytes}));
  } catch (e) {
    console.warn('[push] pushManager.subscribe failed', e);
    return 'subscribe-failed';
  }
  const res = await appFetch(httpBase + '/push/subscribe', {
    method: 'POST',
    headers: {'content-type': 'application/json'},
    body: JSON.stringify({subscription: sub.toJSON(), label: deviceLabel(), deviceId: deviceId()}),
    signal: AbortSignal.timeout(8000)
  })
    .then((r): Promise<{ok?: boolean}> => r.json())
    .catch((): null => null);
  if (res?.ok) return 'on';
  // The server never learned about a subscription we just created, so pushes
  // cannot arrive through it; roll the orphan back so the real state reads
  // off. A subscription that existed before this attempt is left alone (it may
  // still be registered from an earlier run).
  if (!hadSub) await sub.unsubscribe().catch(() => {});
  return 'register-failed';
}

const DEVICE_ID_KEY = 'cyc-device-id';
function deviceId(): string {
  let id = '';
  try {
    id = localStorage.getItem(DEVICE_ID_KEY) ?? '';
    if (!id) {
      id = crypto.randomUUID?.() ?? String(Math.random()).slice(2) + Date.now().toString(36);
      localStorage.setItem(DEVICE_ID_KEY, id);
    }
  } catch {}
  return id;
}

const WANT_KEY = 'cyc-push-enabled';

function wantsPush(): boolean {
  try {
    const v = localStorage.getItem(WANT_KEY);
    if (v === null) return pushSupported() && Notification.permission === 'granted';
    return v === '1';
  } catch {
    return false;
  }
}

function setWantsPush(on: boolean) {
  try {
    localStorage.setItem(WANT_KEY, on ? '1' : '0');
  } catch {}
}

export type PushEnableResult =
  'on' | 'unsupported' | 'denied' | 'subscribe-failed' | 'register-failed';

// 'on' only when the whole chain held: permission granted, browser
// subscription made, and the app server acknowledged the registration.
// Anything less returns the step that broke; the stored want-flag is only set
// on full success.
export async function enablePush(): Promise<PushEnableResult> {
  if (!pushSupported()) return 'unsupported';
  const permission =
    Notification.permission === 'granted' ? 'granted' : await Notification.requestPermission();
  if (permission !== 'granted') return 'denied';
  const reg = await ensureWorker();
  if (!reg) return 'subscribe-failed';
  const step = await subscribeTo(APP, reg).catch((): SubscribeStep => 'subscribe-failed');
  if (step === 'on') setWantsPush(true);
  return step;
}

export type PushDisableResult = 'off' | 'off-server-failed' | 'failed';

// 'off' means the browser subscription is gone and the server dropped the
// registration; 'off-server-failed' means the subscription is gone (no push
// can arrive here any more) but the server could not be told; 'failed' means
// the subscription is still live, so the toggle must stay on.
export async function disablePush(): Promise<PushDisableResult> {
  const reg =
    registration ??
    (pushSupported()
      ? await navigator.serviceWorker.getRegistration().catch((): null => null)
      : null) ??
    null;
  const sub = reg ? await reg.pushManager.getSubscription().catch((): null => null) : null;
  if (!sub) {
    setWantsPush(false);
    return 'off';
  }
  const endpoint = sub.endpoint;
  const gone = await sub.unsubscribe().catch((e: unknown): false => {
    console.warn('[push] unsubscribe failed', e);
    return false;
  });
  if (!gone) return 'failed';
  setWantsPush(false);
  const acked = await appFetch(APP + '/push/unsubscribe', {
    method: 'POST',
    headers: {'content-type': 'application/json'},
    body: JSON.stringify({endpoint}),
    signal: AbortSignal.timeout(8000)
  })
    .then((r) => r.ok)
    .catch(() => false);
  return acked ? 'off' : 'off-server-failed';
}

export async function repairPush(): Promise<boolean> {
  if (!pushSupported() || Notification.permission !== 'granted') return false;
  if (!wantsPush()) return false;
  const reg = await ensureWorker();
  if (!reg) return false;
  const step = await subscribeTo(APP, reg).catch((): SubscribeStep => 'subscribe-failed');
  return step === 'on';
}

// Synchronous hint only (stored flag + permission), for a first paint before
// the async truth arrives. Anything user-facing settles on pushRealState().
export function pushState(): 'on' | 'off' | 'blocked' | 'unsupported' {
  if (!pushSupported()) return 'unsupported';
  if (Notification.permission === 'denied') return 'blocked';
  return Notification.permission === 'granted' && wantsPush() ? 'on' : 'off';
}

// The real current state: permission plus an actual live push subscription in
// the browser, not the stored want-flag.
export async function pushRealState(): Promise<'on' | 'off' | 'blocked' | 'unsupported'> {
  if (!pushSupported()) return 'unsupported';
  if (Notification.permission === 'denied') return 'blocked';
  if (Notification.permission !== 'granted') return 'off';
  const reg =
    registration ??
    (await navigator.serviceWorker.getRegistration().catch((): null => null)) ??
    null;
  const sub = reg ? await reg.pushManager.getSubscription().catch((): null => null) : null;
  return sub ? 'on' : 'off';
}

export function onNotificationOpen(fn: (sessionId: string) => void): () => void {
  if (!('serviceWorker' in navigator)) return () => {};
  const onMessage = (e: MessageEvent) => {
    if (e.data?.t === 'open-chat' && e.data.sessionId) fn(String(e.data.sessionId));
  };
  navigator.serviceWorker.addEventListener('message', onMessage);
  return () => navigator.serviceWorker.removeEventListener('message', onMessage);
}

// The worker's content-free "sync now" poke: a push arrived while the app is
// open (cyc-sw.js messaged its matched window clients). It carries at most the
// sessionId the push envelope already named in the clear, never any content;
// the store decides what one poke is worth (engine/store.ts onPushPoke).
export function onSyncPoke(fn: (sessionId: string) => void): () => void {
  if (!('serviceWorker' in navigator)) return () => {};
  const onMessage = (e: MessageEvent) => {
    if (e.data?.t === 'sync-poke') fn(e.data.sessionId ? String(e.data.sessionId) : '');
  };
  navigator.serviceWorker.addEventListener('message', onMessage);
  return () => navigator.serviceWorker.removeEventListener('message', onMessage);
}

export async function reportRead(sessionId: string) {
  if (!sessionId) return;
  await appFetch(APP + '/push/read', {
    method: 'POST',
    headers: {'content-type': 'application/json'},
    body: JSON.stringify({sessionId}),
    signal: AbortSignal.timeout(8000)
  }).catch(() => {});
}

export async function clearNotifications(sessionId: string) {
  const reg =
    registration ?? (pushSupported() ? await navigator.serviceWorker.getRegistration() : null);
  if (!reg) return;
  for (const tag of [sessionId, 'cyc-read']) {
    const notes = await reg.getNotifications({tag}).catch((): Notification[] => []);
    notes.forEach((n) => n.close());
  }
}
