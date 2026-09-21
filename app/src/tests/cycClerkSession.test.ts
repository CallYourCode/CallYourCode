/* Hermetic clerkSession gate behaviour. window.Clerk is a fake exposing the v5
 * surface the app uses (session/getToken, mountSignIn, handleRedirectCallback,
 * addListener, signOut); window.location is stubbed so location.replace never
 * navigates the test runner. Modules are re-imported per test so the loader's
 * cached promise and the boot-check latch start fresh.
 *
 * The four claims under test:
 *  - logged out (getToken null) -> ensureSessionOrGate mounts the gate.
 *  - signed in (getToken returns a token) -> no gate.
 *  - a #/sso-callback URL -> handleRedirectCallback is called.
 *  - clerkSignOut -> Clerk.signOut is called.
 */

import {afterEach, beforeEach, describe, expect, test, vi} from 'vitest';

// pk_live_ base64("clerk.callyourcode.com$") - the real allowed key shape.
const KEY = 'pk_live_Y2xlcmsuY2FsbHlvdXJjb2RlLmNvbSQ';

type FakeClerk = {
  loaded: boolean;
  user: unknown;
  session: {getToken: () => Promise<string | null>} | null;
  mountSignIn: ReturnType<typeof vi.fn>;
  handleRedirectCallback: ReturnType<typeof vi.fn>;
  signOut: ReturnType<typeof vi.fn>;
  addListener: ReturnType<typeof vi.fn>;
  load: ReturnType<typeof vi.fn>;
};

const makeClerk = (token: string | null): FakeClerk => ({
  loaded: true,
  user: token ? {} : null,
  session: {getToken: async () => token},
  mountSignIn: vi.fn(),
  handleRedirectCallback: vi.fn(async () => undefined),
  signOut: vi.fn(async () => undefined),
  addListener: vi.fn(() => () => {}),
  load: vi.fn(async () => undefined)
});

const stubLocation = (href: string) => {
  const url = new URL(href);
  vi.stubGlobal('location', {
    href: url.href,
    search: url.search,
    hash: url.hash,
    replace: vi.fn()
  } as unknown as Location);
};

const settle = async (rounds = 6) => {
  for (let i = 0; i < rounds; i++) await new Promise((r) => setTimeout(r, 0));
};

beforeEach(() => {
  vi.resetModules();
  document.body.innerHTML = '';
  delete (window as {Clerk?: unknown}).Clerk;
  delete (window as {__cycClerkToken?: unknown}).__cycClerkToken;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const gate = () => document.querySelector('.cyc-clerk-gate');

describe('clerkSession gate', () => {
  test('logged out: ensureSessionOrGate mounts the blurred gate', async () => {
    stubLocation('https://app.callyourcode.com/');
    const clerk = makeClerk(null);
    (window as {Clerk?: unknown}).Clerk = clerk;
    const {configureClerkKey, ensureSessionOrGate, hideSignIn} = await import(
      '../engine/clerkSession'
    );
    configureClerkKey(KEY);
    await ensureSessionOrGate();
    await settle();
    expect(gate()).not.toBeNull();
    expect(clerk.mountSignIn).toHaveBeenCalledTimes(1);
    // Redirect flow must return to '/'.
    expect(clerk.mountSignIn.mock.calls[0][1]).toMatchObject({
      fallbackRedirectUrl: '/',
      forceRedirectUrl: '/'
    });
    // Stop the poll interval so it does not leak into later tests.
    hideSignIn();
  });

  test('signed in: ensureSessionOrGate leaves no gate', async () => {
    stubLocation('https://app.callyourcode.com/');
    (window as {Clerk?: unknown}).Clerk = makeClerk('a.jwt.token');
    const {configureClerkKey, ensureSessionOrGate} = await import('../engine/clerkSession');
    configureClerkKey(KEY);
    await ensureSessionOrGate();
    await settle();
    expect(gate()).toBeNull();
  });

  test('sso-callback URL: handleRedirectCallback is called, no gate', async () => {
    stubLocation('https://app.callyourcode.com/?b=123#/sso-callback');
    const clerk = makeClerk(null);
    (window as {Clerk?: unknown}).Clerk = clerk;
    const {configureClerkKey, ensureSessionOrGate} = await import('../engine/clerkSession');
    configureClerkKey(KEY);
    await ensureSessionOrGate();
    await settle();
    expect(clerk.handleRedirectCallback).toHaveBeenCalledTimes(1);
    expect((location as unknown as {replace: ReturnType<typeof vi.fn>}).replace).toHaveBeenCalledWith(
      '/'
    );
    expect(gate()).toBeNull();
  });

  test('clerkSignOut calls Clerk.signOut then boots to /', async () => {
    stubLocation('https://app.callyourcode.com/');
    const clerk = makeClerk('a.jwt.token');
    (window as {Clerk?: unknown}).Clerk = clerk;
    const {configureClerkKey, clerkSignOut} = await import('../engine/clerkSession');
    configureClerkKey(KEY);
    await clerkSignOut();
    await settle();
    expect(clerk.signOut).toHaveBeenCalledTimes(1);
    expect((location as unknown as {replace: ReturnType<typeof vi.fn>}).replace).toHaveBeenCalledWith(
      '/'
    );
  });

  test('isSignedIn reflects the session token', async () => {
    stubLocation('https://app.callyourcode.com/');
    (window as {Clerk?: unknown}).Clerk = makeClerk('a.jwt.token');
    const {configureClerkKey, isSignedIn} = await import('../engine/clerkSession');
    configureClerkKey(KEY);
    expect(await isSignedIn()).toBe(true);
  });
});
