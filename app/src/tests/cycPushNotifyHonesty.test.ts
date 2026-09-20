import {afterEach, beforeEach, describe, expect, test, vi} from 'vitest';

/* The push chain never lies: enablePush lands 'on' only when permission,
 * browser subscription AND the server registration all held, and names the
 * step that broke otherwise; disablePush reports whether the subscription is
 * really gone; pushRealState reads the live subscription, not the stored
 * flag. Hermetic: Notification, serviceWorker, pushManager and appFetch are
 * all fakes. */

const {appFetchMock} = vi.hoisted(() => ({appFetchMock: vi.fn()}));
vi.mock('../engine/appFetch', () => ({appFetch: appFetchMock}));

type Sub = {
  endpoint: string;
  options: {applicationServerKey: ArrayBuffer | null};
  unsubscribe: ReturnType<typeof vi.fn>;
  toJSON: () => {endpoint: string};
};

// 'AQID' is base64url for bytes [1, 2, 3]; the module compares the stored
// subscription key against the server's key byte for byte.
const SERVER_KEY = 'AQID';
const serverKeyBytes = () => Uint8Array.from([1, 2, 3]).buffer;

const makeSub = (over: Partial<Sub> = {}): Sub => ({
  endpoint: 'https://push.example/ep-1',
  options: {applicationServerKey: serverKeyBytes()},
  unsubscribe: vi.fn(async () => true),
  toJSON: () => ({endpoint: 'https://push.example/ep-1'}),
  ...over
});

type Reg = {
  pushManager: {
    getSubscription: ReturnType<typeof vi.fn>;
    subscribe: ReturnType<typeof vi.fn>;
  };
};

const makeReg = (sub: Sub | null): Reg => ({
  pushManager: {
    getSubscription: vi.fn(async () => sub),
    subscribe: vi.fn(async () => makeSub())
  }
});

const jsonRes = (body: unknown, ok = true) => ({ok, json: async () => body});

// GET /push/key answers the key; POST /push/subscribe answers {ok}.
const wireServer = (opts: {key?: boolean; registerOk?: boolean} = {}) => {
  const {key = true, registerOk = true} = opts;
  appFetchMock.mockImplementation(async (url: string) => {
    if (url.endsWith('/push/key')) {
      if (!key) throw new Error('key fetch down');
      return jsonRes({key: SERVER_KEY});
    }
    if (url.endsWith('/push/subscribe')) return jsonRes({ok: registerOk});
    if (url.endsWith('/push/unsubscribe')) return jsonRes({ok: true});
    throw new Error('unexpected url ' + url);
  });
};

let notification: {permission: NotificationPermission; requestPermission: ReturnType<typeof vi.fn>};

const supportPush = (reg: Reg) => {
  vi.stubGlobal('PushManager', function PushManager() {});
  vi.stubGlobal('Notification', notification);
  Object.defineProperty(navigator, 'serviceWorker', {
    configurable: true,
    value: {
      register: vi.fn(async () => reg),
      ready: Promise.resolve(reg),
      getRegistration: vi.fn(async () => reg)
    }
  });
};

const loadMod = () => import('../engine/pushNotify');

beforeEach(() => {
  vi.resetModules();
  appFetchMock.mockReset();
  localStorage.clear();
  notification = {permission: 'default', requestPermission: vi.fn(async () => 'granted' as const)};
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete (navigator as unknown as Record<string, unknown>).serviceWorker;
});

describe('enablePush is honest about every step', () => {
  test('no push support: unsupported, and no permission prompt', async () => {
    const mod = await loadMod();
    expect(await mod.enablePush()).toBe('unsupported');
    expect(notification.requestPermission).not.toHaveBeenCalled();
    expect(appFetchMock).not.toHaveBeenCalled();
  });

  test('permission denied: denied, nothing subscribed, flag stays unset', async () => {
    const reg = makeReg(null);
    supportPush(reg);
    notification.requestPermission.mockResolvedValue('denied');
    const mod = await loadMod();
    expect(await mod.enablePush()).toBe('denied');
    expect(notification.requestPermission).toHaveBeenCalledTimes(1);
    expect(reg.pushManager.subscribe).not.toHaveBeenCalled();
    expect(localStorage.getItem('cyc-push-enabled')).not.toBe('1');
  });

  test('key fetch down: register-failed before any subscribe', async () => {
    const reg = makeReg(null);
    supportPush(reg);
    wireServer({key: false});
    const mod = await loadMod();
    expect(await mod.enablePush()).toBe('register-failed');
    expect(reg.pushManager.subscribe).not.toHaveBeenCalled();
    expect(localStorage.getItem('cyc-push-enabled')).not.toBe('1');
  });

  test('pushManager.subscribe throws: subscribe-failed, no registration POST', async () => {
    const reg = makeReg(null);
    reg.pushManager.subscribe.mockRejectedValue(new Error('push service said no'));
    supportPush(reg);
    wireServer();
    const mod = await loadMod();
    expect(await mod.enablePush()).toBe('subscribe-failed');
    const urls = appFetchMock.mock.calls.map((c) => c[0] as string);
    expect(urls.some((u) => u.endsWith('/push/subscribe'))).toBe(false);
    expect(localStorage.getItem('cyc-push-enabled')).not.toBe('1');
  });

  test('server rejects the registration: register-failed and the fresh orphan is rolled back', async () => {
    const fresh = makeSub();
    const reg = makeReg(null);
    reg.pushManager.subscribe.mockResolvedValue(fresh);
    supportPush(reg);
    wireServer({registerOk: false});
    const mod = await loadMod();
    expect(await mod.enablePush()).toBe('register-failed');
    expect(fresh.unsubscribe).toHaveBeenCalledTimes(1);
    expect(localStorage.getItem('cyc-push-enabled')).not.toBe('1');
  });

  test('server rejects but the subscription predates this attempt: it is left alone', async () => {
    const incumbent = makeSub();
    const reg = makeReg(incumbent);
    supportPush(reg);
    wireServer({registerOk: false});
    const mod = await loadMod();
    expect(await mod.enablePush()).toBe('register-failed');
    expect(incumbent.unsubscribe).not.toHaveBeenCalled();
  });

  test('the whole chain holds: on, registered with the real endpoint, flag set', async () => {
    const fresh = makeSub();
    const reg = makeReg(null);
    reg.pushManager.subscribe.mockResolvedValue(fresh);
    supportPush(reg);
    wireServer();
    const mod = await loadMod();
    expect(await mod.enablePush()).toBe('on');
    const post = appFetchMock.mock.calls.find((c) => (c[0] as string).endsWith('/push/subscribe'));
    expect(post).toBeTruthy();
    const body = JSON.parse((post![1] as RequestInit).body as string) as {
      subscription: {endpoint: string};
    };
    expect(body.subscription.endpoint).toBe('https://push.example/ep-1');
    expect(localStorage.getItem('cyc-push-enabled')).toBe('1');
  });
});

describe('disablePush reports what really happened', () => {
  test('no subscription: already off', async () => {
    supportPush(makeReg(null));
    const mod = await loadMod();
    expect(await mod.disablePush()).toBe('off');
    expect(localStorage.getItem('cyc-push-enabled')).toBe('0');
  });

  test('unsubscribe fails: failed, flag untouched, server not told', async () => {
    localStorage.setItem('cyc-push-enabled', '1');
    const sub = makeSub({unsubscribe: vi.fn(async () => false)});
    supportPush(makeReg(sub));
    wireServer();
    const mod = await loadMod();
    expect(await mod.disablePush()).toBe('failed');
    expect(localStorage.getItem('cyc-push-enabled')).toBe('1');
    expect(appFetchMock).not.toHaveBeenCalled();
  });

  test('unsubscribed and the server acked: off, with the endpoint in the POST', async () => {
    localStorage.setItem('cyc-push-enabled', '1');
    const sub = makeSub();
    supportPush(makeReg(sub));
    wireServer();
    const mod = await loadMod();
    expect(await mod.disablePush()).toBe('off');
    expect(sub.unsubscribe).toHaveBeenCalledTimes(1);
    expect(localStorage.getItem('cyc-push-enabled')).toBe('0');
    const post = appFetchMock.mock.calls.find((c) =>
      (c[0] as string).endsWith('/push/unsubscribe')
    );
    const body = JSON.parse((post![1] as RequestInit).body as string) as {endpoint: string};
    expect(body.endpoint).toBe('https://push.example/ep-1');
  });

  test('unsubscribed but the server could not be told: off-server-failed', async () => {
    const sub = makeSub();
    supportPush(makeReg(sub));
    appFetchMock.mockRejectedValue(new Error('server down'));
    const mod = await loadMod();
    expect(await mod.disablePush()).toBe('off-server-failed');
    expect(sub.unsubscribe).toHaveBeenCalledTimes(1);
    expect(localStorage.getItem('cyc-push-enabled')).toBe('0');
  });
});

describe('pushRealState reads the live subscription, not the stored flag', () => {
  test('denied permission reads blocked', async () => {
    supportPush(makeReg(makeSub()));
    notification.permission = 'denied';
    const mod = await loadMod();
    expect(await mod.pushRealState()).toBe('blocked');
  });

  test('granted with a live subscription reads on, even with the flag cleared', async () => {
    localStorage.setItem('cyc-push-enabled', '0');
    supportPush(makeReg(makeSub()));
    notification.permission = 'granted';
    const mod = await loadMod();
    expect(await mod.pushRealState()).toBe('on');
  });

  test('granted with no subscription reads off, even with the flag set', async () => {
    localStorage.setItem('cyc-push-enabled', '1');
    supportPush(makeReg(null));
    notification.permission = 'granted';
    const mod = await loadMod();
    expect(await mod.pushRealState()).toBe('off');
  });

  test('permission never asked reads off without touching the push manager', async () => {
    const reg = makeReg(makeSub());
    supportPush(reg);
    const mod = await loadMod();
    expect(await mod.pushRealState()).toBe('off');
    expect(reg.pushManager.getSubscription).not.toHaveBeenCalled();
  });
});
